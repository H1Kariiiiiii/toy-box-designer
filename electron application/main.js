/**
 * 玩具包装盒设计助手 - Electron 主进程
 * 职责：创建窗口、管理配置、调用豆包 Seedream（火山方舟）文生图 API、文件保存
 */
// SMOKE 模式下捕获未处理异常/拒绝，避免弹原生错误对话框挂起测试
//（必须在所有 require 之前注册，否则模块加载失败仍会弹窗）
if (process.env.SMOKE) {
  process.on('uncaughtException', (e) => {
    console.error('SMOKE uncaughtException:', e && (e.stack || e.message));
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    console.error('SMOKE unhandledRejection:', e && (e.stack || e.message), '(rejection)', e);
    process.exit(1);
  });
}
const { app, BrowserWindow, ipcMain, dialog, safeStorage, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
// SMOKE 模式隔离数据目录：测试产生的配置/方案/图片不写入真实用户数据
if (process.env.SMOKE) {
  app.setPath('userData', path.join(app.getPath('temp'), 'toybox_smoke_userdata'));
  try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
const { exportPdfX, gsStatus } = require('./pdfx.js');

const { buildImageRequest } = require('./lib/imgRequest.js');
const DEFAULT_CONFIG = {
  apiKey: '',
  imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', // 文生图接口（OpenAI 兼容：火山方舟/硅基流动/智谱/OpenAI 等）
  model: 'doubao-seedream-5-0-260128', // Seedream 5.0 lite（2K/4K、png、组图、图生图；以控制台开通为准）
  size: '2048x2048',
  // 视觉质检默认走小米 MiMo（OpenAI 兼容，key 复用主 API Key 或单独填）
  visionProvider: 'xiaomi', // xiaomi | volces
  visionBaseUrl: 'https://api.xiaomimimo.com/v1',
  visionModel: 'mimo-v2.5',
  visionApiKey: '',
  theme: 'light', // 界面主题：light（默认浅色）| dark | system（跟随系统）
};

let mainWindow = null;

/* ---------------- 配置存取 ---------------- */
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
/** API Key 加密存储：Windows 用 DPAPI（safeStorage），不可用时退回明文；enc: 前缀标记已加密 */
const ENC_PREFIX = 'enc:';
function encryptSecret(v) {
  if (!v || !safeStorage.isEncryptionAvailable()) return v;
  try { return ENC_PREFIX + safeStorage.encryptString(String(v)).toString('base64'); } catch (e) { return v; }
}
function decryptSecret(v) {
  if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) return v;
  try { return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64')); } catch (e) { return ''; }
}
function readConfig() {
  try {
    const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
    cfg.apiKey = decryptSecret(cfg.apiKey);
    cfg.visionApiKey = decryptSecret(cfg.visionApiKey);
    if (Array.isArray(cfg.profiles)) {
      cfg.profiles = cfg.profiles.map((p) => ({
        ...p,
        apiKey: decryptSecret(p && p.apiKey),
        visionApiKey: decryptSecret(p && p.visionApiKey),
      }));
    }
    return cfg;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function writeConfig(cfg) {
  // 原子写：先写临时文件再 rename，避免崩溃损坏 config.json；apiKey 落盘前加密
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const out = {
    ...cfg,
    apiKey: encryptSecret(cfg.apiKey),
    visionApiKey: encryptSecret(cfg.visionApiKey),
  };
  if (Array.isArray(out.profiles)) {
    out.profiles = out.profiles.map((pf) => ({
      ...pf,
      apiKey: encryptSecret(pf && pf.apiKey),
      visionApiKey: encryptSecret(pf && pf.visionApiKey),
    }));
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/* ---------------- Seedream 文生图 ---------------- */
/** 按魔数识别 PNG/JPEG，避免 4.5/4.0（固定 jpeg）与 5.0（png）混用时 MIME 错误 */
function detectImageFormat(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  return null; // 魔数不匹配：拒绝，避免脏数据以图片扩展名落盘
}

/* ---------------- 安全网络请求 ---------------- */
/** 统一 fetch：仅 http/https、超时、拒绝重定向（防挂起/凭据外泄/SSRF 面收窄）。
 * label 非空时 AbortError 转为友好中文提示（如「文生图超时（超过 N 秒）」） */
async function safeFetch(url, opts = {}, timeoutMs = 60000, label = '') {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) throw new Error('仅允许 http/https 请求');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(u, { ...opts, signal: ctrl.signal, redirect: 'error' });
  } catch (e) {
    if (label && e && e.name === 'AbortError') {
      throw new Error(`${label}超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 流式读取响应体并限制大小（防恶意/故障服务端无限输出拖垮内存） */
async function readBodyLimited(resp, maxBytes) {
  if (!resp || !resp.body) return Buffer.alloc(0);
  const len = Number(resp.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error('响应体过大（Content-Length 超限）');
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('响应体过大');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
const MAX_JSON_RESPONSE = 64 * 1024 * 1024; // 文生图 JSON（含 b64_json）上限
const MAX_IMAGE_DOWNLOAD = 64 * 1024 * 1024; // 图片 url 下载上限

/* ---------------- 文生图（OpenAI 兼容，火山方舟 / 硅基流动 / 智谱 / OpenAI 等） ---------------- */
async function generateImage({ baseUrl, prompt, model, size, seed, image, maxImages, apiKey, watermark }) {
  if (!apiKey) throw new Error('尚未配置 API Key，请先在左侧"设置"中填写');
  if (!prompt) throw new Error('提示词为空');
  if (!model) throw new Error('未配置模型 ID');

  const req = buildImageRequest({ baseUrl, model, prompt, size, seed, image, watermark });
  if (maxImages > 1 && !req.volces) {
    // 组图（多图一次生成）仅火山方舟支持，其他平台回退为单图
    maxImages = 1;
  }
  if (maxImages > 1 && req.volces) {
    req.body.sequential_image_generation = 'auto';
    req.body.sequential_image_generation_options = { max_images: maxImages };
  }

  const headers = { Authorization: `Bearer ${apiKey}` };
  if (req.kind === 'json') headers['Content-Type'] = 'application/json';
  // 超时按张数动态计算：组图/4K 耗时远高于单图，固定 120s 会把正常生成误杀（每张约 30-60s）
  const apiTimeout = 120000 + Math.max(0, (maxImages || 1) - 1) * 60000;
  const resp = await safeFetch(req.url, {
    method: 'POST',
    headers,
    body: req.kind === 'json' ? JSON.stringify(req.body) : req.body,
  }, apiTimeout, '文生图');

  let json = {};
  try {
    const raw = await readBodyLimited(resp, MAX_JSON_RESPONSE);
    json = JSON.parse(raw.toString('utf8'));
  } catch { /* 解析失败按空处理 */ }
  if (!resp.ok || !json.data || !json.data.length) {
    const msg = json.error && json.error.message ? json.error.message : JSON.stringify(json);
    throw new Error(`文生图 API 调用失败（HTTP ${resp.status}）：${msg}`);
  }

  // 统一输出：优先 b64_json，缺失则下载 url 到本地缓存（url 链接约 24 小时失效）
  const imgDir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const images = [];
  for (const d of json.data) {
    let buf, mime;
    if (d.b64_json) {
      buf = Buffer.from(d.b64_json, 'base64');
    } else if (d.url) {
      const imgResp = await safeFetch(d.url, {}, 120000, '图片下载');
      if (!imgResp.ok) throw new Error('图片下载失败');
      buf = await readBodyLimited(imgResp, MAX_IMAGE_DOWNLOAD);
    } else {
      continue;
    }
    const det = detectImageFormat(buf);
    if (!det) throw new Error('API 返回了非图片数据');
    mime = det.mime;
    const localPath = path.join(imgDir, `box_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${images.length}.${det.ext}`);
    fs.writeFileSync(localPath, buf);
    images.push({ dataUrl: `data:${mime};base64,${buf.toString('base64')}`, localPath });
  }
  if (!images.length) throw new Error('文生图 API 未返回任何图片');

  return { images, usage: json.usage || null };
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: '玩具包装盒设计助手',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: '#161a20',
    autoHideMenuBar: true,
    show: process.env.SMOKE_SHOW ? true : !process.env.SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const loadDone = mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  loadDone.catch((e) => console.error('页面加载失败:', e)); // 生产路径兜底，避免 unhandled rejection
  mainWindow.on('closed', () => { mainWindow = null; });
  // 纵深防御：禁止 window.open 子窗口（子窗口会继承 webPreferences）；教程里的 http/https 链接交给系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).protocol !== 'file:') e.preventDefault();
    } catch { e.preventDefault(); }
  });

  // 冒烟测试模式：SMOKE=1 时无头加载，检查 DOM 与 JS 错误后自动退出
  if (process.env.SMOKE) {
    const errors = [];
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level === 3) errors.push(`${message} @${sourceId}:${line}`);
    });
    loadDone.then(async () => {
      await new Promise((r) => setTimeout(r, 2500));
      // 方案导出/导入往返测试准备（1x1 PNG + 导出目标路径）
      const testPng = path.join(app.getPath('temp'), 'toybox_1px.png');
      fs.writeFileSync(testPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      const exportPath = path.join(app.getPath('temp'), 'toybox_roundtrip.toybox.json');
      try { fs.unlinkSync(exportPath); } catch (e) { /* ignore */ }
      // 恶意方案文件：images 携带本地/UNC 路径（安全修复回归测试用）
      const evilPath = path.join(app.getPath('temp'), 'toybox_evil.toybox.json');
      fs.writeFileSync(evilPath, JSON.stringify({ app: 'toy-box-designer', format: 1, scheme: { kind: 'import', prompt: 'evil', boxType: 'tianDiGai', images: ['C:\\Windows\\win.ini', '\\\\evil\\share\\x.png'] } }));
      if (process.env.SMOKE_BARCODE) {
        // 条码专项诊断
        const diag = await mainWindow.webContents.executeJavaScript(`(() => {
          try {
            const holder = document.createElement('div');
            JsBarcode(holder, '6901234567892', { format: 'EAN13', displayValue: true, width: 2, height: 60, margin: 4, fontSize: 16, flat: true });
            const svg = holder.querySelector('svg');
            return svg ? { ok: true, innerLen: svg.innerHTML.length, w: svg.getAttribute('width'), h: svg.getAttribute('height'), tag: svg.tagName } : { ok: false, holderHtml: holder.innerHTML.slice(0, 200) };
          } catch (e) {
            return { ok: false, error: String(e), stack: (e && e.stack || '').split('\\n').slice(0, 3).join(' | ') };
          }
        })()`);
        console.log('BARCODE DIAG:', JSON.stringify(diag));
        app.exit(0);
        return;
      }
      const dom = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const step = (s) => console.log('SMOKE STEP:', s);
        const mk = (color) => { const c = document.createElement('canvas'); c.width = 16; c.height = 16; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 16, 16); return c.toDataURL(); };
        window.confirm = () => true; // SMOKE 下自动确认弹窗
        window.alert = () => {};
        try {
        step('dom');
        out.boxes = document.querySelectorAll('.box-card').length;
        out.boxCardInit = document.querySelectorAll('.box-card').length;
        out.activeBox = document.querySelector('.box-card.active .bc-name') ? document.querySelector('.box-card.active .bc-name').textContent : null;
        out.hasPreviewSvg = !!document.querySelector('#preview-area svg');
        out.prompt = document.getElementById('req-prompt').value;
        out.jsBarcodeLoaded = typeof window.JsBarcode === 'function';
        out.marketChips = document.querySelectorAll('#compliance-markets .market-chip').length;

        // 3D mockup：模拟用户路径——先在设计页（mockup 隐藏，曾导致 0 尺寸 canvas bug）再切预览页
        step('mockup');
        document.querySelector('.tab[data-page="design"]').click();
        await new Promise((r) => setTimeout(r, 400));
        document.querySelector('.tab[data-page="preview"]').click();
        await new Promise((r) => setTimeout(r, 600));
        // 3D mockup：模块加载 + WebGL canvas 创建
        out.mockup = {
          moduleLoaded: !!window.__mockup,
          canvasCount: document.querySelectorAll('#mockup-area canvas').length,
          areaSize: (() => { const el = document.getElementById('mockup-area'); return el ? el.clientWidth + 'x' + el.clientHeight : 'null'; })(),
        };
        // 显式渲染 3D 并捕获异常（renderMockup 内部 catch 的日志中文会乱码，这里直接拿结果）
        out.mockupRender = await (async () => {
          try {
            window.__app.state.currentImage = mk('#ff8800'); // 注入主视觉图，让盒子带贴图
            await window.__mockup.renderMockup(window.__app.state.templates[window.__app.state.currentType], getSize());
            return 'ok';
          } catch (e) { return 'ERR: ' + e.message; }
        })();
        await new Promise((r) => setTimeout(r, 1200)); // 等 WebGL 出帧
        // 直接读 WebGL canvas 像素（capturePage 对 WebGL 抓屏在部分 GPU 上为空，JS 侧读取才可靠）
        out.mockupPng = (() => {
          const cv = document.querySelector('#mockup-area canvas');
          if (!cv) return '';
          return cv.toDataURL('image/png');
        })();
        out.mockupPixels = (() => {
          const cv = document.querySelector('#mockup-area canvas');
          if (!cv) return 'no-canvas';
          const c = document.createElement('canvas');
          c.width = cv.width; c.height = cv.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(cv, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let nonBg = 0, total = 0;
          for (let i = 0; i < d.length; i += 16) {
            total++;
            const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
            if (a > 40 && !(r < 45 && g < 50 && b < 60)) nonBg++;
          }
          return { w: cv.width, h: cv.height, nonBgRatio: +(nonBg / total).toFixed(3) };
        })();

        // 展开图等比例放大（预览页可见时）：SVG 宽度 ≈ 容器可用宽度，不被拉伸
        out.svgFit = (() => {
          const svg = document.querySelector('#preview-area svg');
          const area = document.getElementById('preview-area');
          const page = document.getElementById('page-preview');
          if (!svg) return 'no-svg';
          return {
            svgW: Math.round(parseFloat(svg.getAttribute('width')) || 0),
            areaW: area.clientWidth,
            areaRectW: Math.round(area.getBoundingClientRect().width),
            pageW: page.clientWidth,
            bodyScrollW: document.body.scrollWidth,
            winW: window.innerWidth,
          };
        })();
        // 尺寸标注：预览时在展开图下方独立标注区（不遮挡）；导出时不含标注
        out.label = (() => {
          const svg = document.querySelector('#preview-area svg');
          if (!svg) return 'no-svg';
          const txt = Array.from(svg.querySelectorAll('text')).find((t) => t.textContent.includes('展开尺寸'));
          return {
            hasLabel: !!txt,
            labelY: txt ? Math.round(parseFloat(txt.getAttribute('y'))) : null,
            svgH: Math.round(parseFloat(svg.getAttribute('height'))),
          };
        })();
        out.labelExport = !window.__app.buildSvg(2, { bleed: 3, showLabel: false }).includes('展开尺寸');
        // 自定义像素兼容 * / × / X 分隔
        out.normSize = {
          star: window.normSize('2048*2048'),
          times: window.normSize('1920×1080'),
          upperX: window.normSize('1080X1920'),
          plain: window.normSize('1024x768'),
          invalid: window.normSize('abc'),
        };
        // 多配置档：新建 → 2 档；切回第一档；删除 → 回到 1 档
        out.profiles = {
          initCount: document.getElementById('cfg-profile').options.length,
          newBtn: !!document.getElementById('btn-profile-new'),
        };
        document.getElementById('btn-profile-new').click();
        out.profiles.afterNew = document.getElementById('cfg-profile').options.length;
        out.profiles.newName = document.getElementById('cfg-profile').options[document.getElementById('cfg-profile').options.length - 1].textContent;
        out.profiles.nameBox = document.getElementById('cfg-profileName').value;
        document.getElementById('cfg-profile').value = '0';
        document.getElementById('cfg-profile').dispatchEvent(new Event('change'));
        out.profiles.switchOk = document.getElementById('cfg-apiKey').value === '';
        document.getElementById('btn-profile-del').click(); // 两段确认：第一次武装
        document.getElementById('btn-profile-del').click(); // 第二次确认删除
        out.profiles.afterDel = document.getElementById('cfg-profile').options.length;
        // 盒型页改尺寸 → 预览页「当前盒型」说明同步更新
        out.sizeSync = (() => {
          document.querySelector('.tab[data-page="box"]').click();
          document.getElementById('size-h').value = '55';
          document.getElementById('size-h').dispatchEvent(new Event('input'));
          const txt = document.getElementById('box-size-text').textContent;
          document.querySelector('.tab[data-page="preview"]').click();
          return { has55: document.getElementById('box-size-text').textContent.includes('55'), txt };
        })();
        // 切换盒型 → 开窗盒
        step('switchTo');
        out.boxCardCount = document.querySelectorAll('.box-card').length;
        if (document.querySelectorAll('.box-card')[1]) {
          document.querySelectorAll('.box-card')[1].click();
        } else {
          console.error('SMOKE 诊断: box-card 数量=' + out.boxCardCount + ', 页面=' + document.querySelectorAll('.page.active').length);
        }
        await new Promise(r => setTimeout(r, 200));
        out.switchTo = {
          active: document.querySelector('.box-card.active .bc-name').textContent,
          rects: document.querySelectorAll('#preview-area svg rect').length,
        };

        // 合规：选中中国市场 → 清单渲染
        document.querySelectorAll('#compliance-markets .market-chip')[0].click();
        await new Promise(r => setTimeout(r, 200));
        out.complianceAfterCn = {
          chips: document.querySelectorAll('#compliance-markets .market-chip.active').length,
          items: document.querySelectorAll('#compliance-items .comp-item').length,
          has3C: document.querySelector('#compliance-items').textContent.includes('3C'),
        };

        // 条码：注入 EAN-13 → 展开图出现条码白底与组
        window.__app.state.barcode = { format: 'EAN13', value: '6901234567892' };
        window.__app.renderLayout();
        out.barcodeSvg = {
          whitePad: document.querySelectorAll('#preview-area svg rect[fill="#ffffff"]').length,
          groups: document.querySelectorAll('#preview-area svg g[transform]').length,
        };

        // 出血 3mm：预览尺寸应比无出血大 6mm*2.5
        const noBleed = window.__app.buildSvg(2.5, { bleed: 0 });
        const withBleed = window.__app.buildSvg(2.5, { bleed: 3 });
        out.bleedSize = {
          no: noBleed.match(/width="([0-9.]+)"/)[1] + 'x' + noBleed.match(/height="([0-9.]+)"/)[1],
          yes: withBleed.match(/width="([0-9.]+)"/)[1] + 'x' + withBleed.match(/height="([0-9.]+)"/)[1],
          hasDieLine: withBleed.includes('stroke-dasharray="10 6"'),
        };

        // 生成链路参数（不真调 API，仅验证 generate 前置读取）
        document.getElementById('req-seed').value = '42';
        out.seedRead = window.__app.state.lastSeed === null; // 初始 lastSeed 为 null

        // 组图：改生成张数=3 → 提示词含第1/2/3张视图描述
        const countSel = document.getElementById('req-count');
        countSel.value = '3';
        countSel.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 200));
        out.groupPrompt = {
          hasShot1: document.getElementById('req-prompt').value.includes('第1张 正面主视觉'),
          hasShot3: document.getElementById('req-prompt').value.includes('第3张 侧面'),
          n3: document.getElementById('req-prompt').value.includes('生成 3 张'),
        };
        // 5.0 pro + 组图 → 提示出现
        document.getElementById('cfg-model').value = 'doubao-seedream-5-0-pro-260628';
        document.getElementById('cfg-model').dispatchEvent(new Event('input'));
        out.proHint = !document.getElementById('count-hint').classList.contains('hidden');
        document.getElementById('cfg-model').value = 'doubao-seedream-5-0-260128';

        // 结果区多图：注入 2 张伪图 → 缩略图渲染 + 点击切换
        window.__app.state.generatedImages = [{ dataUrl: mk('#ff8800') }, { dataUrl: mk('#2288ff') }];
        window.__app.state.activeIndex = 0;
        window.__app.renderResults();
        const thumbs = document.querySelectorAll('#result-thumbs img');
        out.multiImage = {
          thumbCount: thumbs.length,
          active0: document.querySelector('#result-thumbs img.active') !== null,
        };
        if (thumbs[1]) { thumbs[1].click(); } else { console.log('SMOKE STEP: thumbs[1] 缺失, length=' + thumbs.length); }
        await new Promise(r => setTimeout(r, 100));
        out.afterSwitch = {
          activeIndex: window.__app.state.activeIndex,
          appliedToLayout: window.__app.state.currentImage === window.__app.state.generatedImages[1].dataUrl,
        };

        // 大图导航：批量 4 方案 → 箭头可见、序号 1/4、点 ▶ 变 2/4、循环回绕
        window.__app.state.batchMode = true;
        window.__app.state.generatedImages = [mk('#ff0000'), mk('#00ff00'), mk('#0000ff'), mk('#ffff00')].map((d) => ({ dataUrl: d }));
        window.__app.state.activeIndex = 0;
        window.__app.renderResults();
        const navPrev = document.getElementById('btn-result-prev');
        const navNext = document.getElementById('btn-result-next');
        const navCounter = document.getElementById('result-counter');
        out.resultNav = {
          navVisible: !navPrev.classList.contains('hidden') && !navNext.classList.contains('hidden'),
          counter1of4: navCounter.textContent === '方案 1/4',
          hasPrevNext: !!navPrev && !!navNext,
        };
        navNext.click();
        await new Promise(r => setTimeout(r, 50));
        out.resultNav.idxAfterNext = window.__app.state.activeIndex;
        out.resultNav.counter2of4 = navCounter.textContent === '方案 2/4';
        navPrev.click(); // 1 → 0
        await new Promise(r => setTimeout(r, 50));
        navPrev.click(); // 0 → 循环回绕 3/4
        await new Promise(r => setTimeout(r, 50));
        out.resultNav.idxLoopBack = window.__app.state.activeIndex === 3;

        // 合规自动排版（此时条码已注入，验证同面板避让）：启用 + 字段 + 欧盟 → 白底/文字/CE/条码共存
        window.__app.state.compAuto = true;
        window.__app.state.compFields = { name: '恐龙积木', sku: 'T-1001', material: 'ABS 塑料', standard: 'GB 6675', maker: '澄海玩具厂', warning: '适合 3 岁以上儿童，小零件谨防误吞' };
        window.__app.state.markets.add('eu');
        window.__app.renderLayout();
        const compSvg = document.querySelector('#preview-area svg').innerHTML;
        out.complianceBlock = {
          whiteBg: document.querySelectorAll('#preview-area svg rect[fill="#f4f6f8"]').length,
          hasName: compSvg.includes('恐龙积木'),
          hasSku: compSvg.includes('T-1001'),
          hasCE: compSvg.includes('>CE<'),
          barcodePadStill: document.querySelectorAll('#preview-area svg rect[fill="#ffffff"]').length,
        };

        // 方案库 IPC 往返 + 批量 UI
        const fakeScheme = await window.api.saveScheme({ kind: 'test', prompt: '冒烟测试', seed: '', boxType: 'tianDiGai', boxSize: { w: 200, d: 130, h: 60 }, images: [] });
        await window.__app.loadSchemes(); // 模拟 app.js saveScheme 包装后的刷新
        await new Promise(r => setTimeout(r, 300));
        const listAfter = await window.api.listSchemes();
        out.schemes = {
          saved: !!fakeScheme.id,
          listed: listAfter.length > 0,
          listRendered: document.querySelectorAll('#scheme-list .scheme-item').length > 0,
          deleteOk: (await window.api.deleteScheme(fakeScheme.id)).ok,
        };

        // 方案导出→导入往返（forcePath 免弹窗）
        const recR = await window.api.saveScheme({ kind: 'test', prompt: '往返测试', seed: '42', boxType: 'kaiChuangHe', boxSize: { w: 200, d: 130, h: 60 }, images: [${JSON.stringify(testPng)}] });
        const expR = await window.api.exportScheme(recR.id, ${JSON.stringify(exportPath)});
        await window.api.deleteScheme(recR.id);
        const impR = await window.api.importScheme(${JSON.stringify(exportPath)});
        out.roundtrip = {
          exported: !!expR.saved,
          imported: !!impR.imported,
          imgCount: impR.imported ? impR.scheme.images.length : -1,
          imgPath: impR.imported && impR.scheme.images.length ? impR.scheme.images[0] : '',
          promptPreserved: impR.imported ? impR.scheme.prompt === '往返测试' : false,
          seedPreserved: impR.imported ? impR.scheme.seed === '42' : false,
        };
        if (impR.imported) await window.api.deleteScheme(impR.scheme.id); // 测试后清理

        // 图片尺寸：比例 × 清晰度 计算 + 旧配置推断
        out.sizeCalc = {
          '16:9@1080p': window.calcSize('16:9', '1080p'),
          '9:16@1080p': window.calcSize('9:16', '1080p'),
          '21:9@1080p': window.calcSize('21:9', '1080p'),
          '1:1@2K': window.calcSize('1:1', '2K'),
          '4:3@720p': window.calcSize('4:3', '720p'),
          '3:2@1080p': window.calcSize('3:2', '1080p'),
          '2:3@1080p': window.calcSize('2:3', '1080p'),
          '3:4@2K': window.calcSize('3:4', '2K'),
          '21:9@4K封顶': window.calcSize('21:9', '4K'),
          infer1920x1080: JSON.stringify(window.inferRatioQuality('1920x1080')),
          infer1080x1440: JSON.stringify(window.inferRatioQuality('1080x1440')),
          infer2048x2048: JSON.stringify(window.inferRatioQuality('2048x2048')),
          eff16x9: (() => { document.getElementById('cfg-ratio').value = '16:9'; document.getElementById('cfg-quality').value = '1080p'; return window.getEffectiveSize(); })(),
          ratioOpts: document.querySelectorAll('#cfg-ratio option').length,
          qualityOpts: document.querySelectorAll('#cfg-quality option').length,
          previewShown: document.getElementById('size-preview').textContent.length > 0,
        };

        // 页签导航：页签 + 切换生效 + 双盒型列表 + 教程页
        out.tabs = {
          count: document.querySelectorAll('.tab').length,
          pages: document.querySelectorAll('.page').length,
          miniBox: !!document.getElementById('boxTypeMini'),
          miniCards: document.querySelectorAll('#boxTypeMini .box-card').length,
          gotoBtn: !!document.getElementById('btn-goto-box'),
        };
        document.querySelector('.tab[data-page="box"]').click();
        out.tabBoxActive = document.getElementById('page-box').classList.contains('active');
        document.querySelector('.tab[data-page="design"]').click();
        out.tabDesignActive = document.getElementById('page-design').classList.contains('active');
        // 品牌图标：页面 logo 已从 emoji 换成内联 SVG（新应用图标）
        out.brand = {
          logoSvg: !!document.querySelector('.topbar .logo svg'),
          noEmoji: !document.querySelector('.topbar .logo') || document.querySelector('.topbar .logo').textContent.trim() === '',
        };
        // 教程页：页签存在、切换生效、7 张截图资源可加载
        out.help = await (async () => {
          const tab = document.querySelector('.tab[data-page="help"]');
          document.querySelector('.tab[data-page="help"]').click();
          const active = document.getElementById('page-help').classList.contains('active');
          const imgs = [...document.querySelectorAll('#page-help img')];
          const names = ['design', 'preview', 'box', 'compliance', 'qc', 'history', 'settings'];
          const loaded = await Promise.all(imgs.map((i) => new Promise((res) => {
            if (i.complete && i.naturalWidth > 0) return res(true);
            i.onload = () => res(i.naturalWidth > 0);
            i.onerror = () => res(false);
          })));
          const haveAll = names.every((n) => imgs.some((i) => i.getAttribute('src').includes(n + '.png')));
          const faqCount = document.querySelectorAll('#page-help details').length;
          const apiDetails = document.querySelectorAll('#page-help .help-api details').length;
          const hasRec3 = [...document.querySelectorAll('#page-help .help-api summary')].some((s) => s.textContent.includes('推荐三'));
          const apiLinks = [...document.querySelectorAll('#page-help .help-api a')];
          const linksOk = apiLinks.length >= 5 && apiLinks.every((a) => (a.href.startsWith('https://') || a.href.startsWith('http://')) && a.target === '_blank' && a.rel === 'noopener');
          const noMoonshot = ![...document.querySelectorAll('#base-url-presets option')].some((o) => o.value.includes('moonshot'));
          document.querySelector('.tab[data-page="design"]').click();
          return { tabExists: !!tab, active, imgs: imgs.length, loadedOk: loaded.every(Boolean), haveAll, faqCount, apiDetails, hasRec3, apiLinks: apiLinks.length, linksOk, noMoonshot };
        })();

        // 质检：正常状态无 fail；无图 → fail；EAN 校验位错 → warn
        const qcOk = window.__app.runQualityCheck();
        const noImgSave = window.__app.state.currentImage;
        window.__app.state.currentImage = null;
        const qcNoImg = window.__app.runQualityCheck();
        window.__app.state.currentImage = noImgSave;
        const bcSave = window.__app.state.barcode;
        window.__app.state.barcode = { format: 'EAN13', value: '6901234567890' };
        const qcBadEan = window.__app.runQualityCheck();
        window.__app.state.barcode = bcSave;
        window.__app.renderQc(qcOk);
        out.qc = {
          okNoFails: !qcOk.some((i) => i.level === 'fail'),
          failWhenNoImage: qcNoImg.some((i) => i.level === 'fail' && i.msg.includes('主视觉')),
          warnOnBadEan: qcBadEan.some((i) => i.level === 'warn' && i.msg.includes('校验位')),
          panelRendered: document.querySelectorAll('#qc-items .qc-item').length > 0,
          visionBtn: !!document.getElementById('btn-qc-vision'),
        };
        out.batchUI = {
          btn: !!document.getElementById('btn-batch'),
          count: document.getElementById('batch-count').value,
        };
        // 设计页「当前配置」卡
        out.quickStatus = {
          box: document.getElementById('qs-box').textContent,
          size: document.getElementById('qs-size').textContent,
          img: document.getElementById('qs-img').textContent,
          model: document.getElementById('qs-model').textContent,
          gs: document.getElementById('qs-gs').textContent,
          steps: document.querySelectorAll('.steps li').length,
        };
        // 快捷主题 chips + 点击填入
        out.quickThemes = {
          chips: document.querySelectorAll('.qt-chip').length,
          firstChipText: document.querySelector('.qt-chip') ? document.querySelector('.qt-chip').textContent : 'none',
        };
        if (document.querySelector('.qt-chip')) {
          document.querySelector('.qt-chip').click();
          out.quickThemes.filled = document.getElementById('req-theme').value;
        }
        // 左右列面板分布（修复 design-right 丢失的回归测试）
        out.columns = {
          left: document.querySelectorAll('#page-design .design-left > .panel').length,
          right: document.querySelectorAll('#page-design .design-right > .panel').length,
          rightHasResult: !!document.querySelector('#page-design .design-right #result-area'),
          rightHasStatus: !!document.querySelector('#page-design .design-right #quick-status'),
        };
        // 预览页：从上到下 当前盒型 → 3D → 展开图，单列填满
        out.previewStack = {
          panels: document.querySelectorAll('#page-preview .preview-stack > .panel').length,
          order: Array.from(document.querySelectorAll('#page-preview .preview-stack > .panel')).map((p) => {
            const h = p.querySelector('h2');
            return h ? h.textContent.trim().replace(/\s+/g, ' ') : '';
          }),
          has3dAfterBox: (() => {
            const ps = document.querySelectorAll('#page-preview .preview-stack > .panel');
            const idx = (t) => Array.from(ps).findIndex((p) => (p.querySelector('h2') || {}).textContent && p.querySelector('h2').textContent.includes(t));
            return idx('3D') === 1 && idx('展开图') === 2 && idx('当前盒型') === 0;
          })(),
        };
        // ================= 新批次：盒型几何一致性（boxes.js 纯函数） =================
        out.geometry = (() => {
          const T = window.__app.state.templates;
          const res = {};
          for (const id of Object.keys(T)) {
            const t = T[id];
            const lay = t.build({ w: 200, d: 130, h: 60 });
            const inBounds = lay.panels.every((p) => p.x >= 0 && p.y >= 0 && p.x + p.w <= lay.width + 0.001 && p.y + p.h <= lay.height + 0.001);
            const hasFace = lay.panels.some((p) => p.kind === 'face');
            const mainPanel = lay.panels.find((p) => p.id === lay.panel);
            const mainIsFace = mainPanel && mainPanel.kind === 'face';
            const overlap = (() => {
              const solids = lay.panels.filter((p) => p.kind !== 'window');
              for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
                const a = solids[i], b = solids[j];
                if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return a.id + '∩' + b.id;
              }
              return '';
            })();
            const winInside = (() => {
              const w = lay.panels.find((p) => p.kind === 'window');
              if (!w) return 'no-window';
              const f = lay.panels.find((p) => p.id === lay.panel);
              return f && w.x >= f.x && w.y >= f.y && w.x + w.w <= f.x + f.w + 0.001 && w.y + w.h <= f.y + f.h + 0.001;
            })();
            const diffSize = (() => {
              const s1 = t.build({ w: 150, d: 100, h: 50 });
              return s1.width !== lay.width || s1.height !== lay.height;
            })();
            res[id] = { w: lay.width, h: lay.height, panels: lay.panels.length, inBounds, hasFace, mainIsFace, overlap, winInside, diffSize };
          }
          return res;
        })();

        // ================= 新批次：getSize 边界 =================
        out.sizeEdge = (() => {
          const set = (w, d, h) => { document.getElementById('size-w').value = w; document.getElementById('size-d').value = d; document.getElementById('size-h').value = h; };
          const g = () => JSON.stringify(window.__app.getSize());
          const cases = {};
          set('0', '130', '60'); cases.zero = g();
          set('-5', '130', '60'); cases.neg = g();
          set('abc', '130', '60'); cases.nan = g();
          set('250', '100', '45'); cases.normal = g();
          set('', '', ''); cases.empty = g();
          set('200', '130', '60');
          return cases;
        })();

        // ================= 新批次：EAN/UPC 条码逻辑 =================
        out.barcodeLogic = (() => {
          const c = window.__app.checkEan13;
          return {
            valid13: c('6901234567892'),
            invalid13: c('6901234567890'),
            short12: c('690123456789'),
            nonDigit: c('69012345678a'),
            empty: c(''),
            makeValid: !!window.makeBarcode('EAN13', '6901234567892'),
            makeInvalidCheck: (() => { const r = window.makeBarcode('EAN13', '6901234567890'); return r ? { drew: true, innerLen: r.inner.length } : { drew: false }; })(),
            makeUPC12: !!window.makeBarcode('UPC', '036000291452'),
            makeUPCBad: (() => { const r = window.makeBarcode('UPC', '03600029145'); return r ? { drew: true } : { drew: false }; })(),
            makeGarbage: window.makeBarcode('EAN13', 'abc') === null,
          };
        })();

        // ================= 新批次：合规市场规则 =================
        out.complianceRules = (() => {
          const CD = window.ComplianceData;
          const mk = (ids) => ids.map((i) => CD.markets[i] ? CD.markets[i].items.map((x) => x.label).join('|') : 'MISSING:' + i).join(' || ');
          return {
            marketIds: Object.keys(CD.markets).join(','),
            cn: mk(['cn']),
            eu: mk(['eu']),
            us: mk(['us']),
            printing: CD.printing.length,
          };
        })();

        // ================= 新批次：导出尺寸（300dpi + 出血） =================
        out.exportDims = (() => {
          const scale = 300 / 25.4;
          const svg = window.__app.buildSvg(scale, { bleed: 3, showLabel: false });
          const m = svg.match(/width="([0-9.]+)" height="([0-9.]+)"/);
          const lay = window.__app.state.templates[window.__app.state.currentType].build(window.__app.getSize());
          const expectW = Math.round((lay.width + 6) * scale * 10) / 10;
          return {
            actualW: m ? +m[1] : -1,
            expectW,
            matches: m ? Math.abs(+m[1] - expectW) < 2 : false,
            noLabel: !svg.includes('展开尺寸'),
          };
        })();

        // ================= 新批次：3D 三种盒型渲染 =================
        out.mockupAllBoxes = await Promise.all(['tianDiGai', 'kaiChuangHe', 'shuangChaHe'].map(async (id) => {
          try {
            window.__app.state.currentType = id;
            window.__app.state.currentImage = mk('#ff8800');
            await window.__mockup.renderMockup(window.__app.state.templates[id], { w: 200, d: 130, h: 60 });
            await new Promise((r) => setTimeout(r, 250));
            const cv = document.querySelector('#mockup-area canvas');
            return { id, ok: true, w: cv ? cv.width : 0, h: cv ? cv.height : 0 };
          } catch (e) { return { id, ok: false, err: e.message }; }
        }));

        // ================= 新批次：无图方案载入恢复 =================
        out.schemeRestore = await (async () => {
          const rec = await window.api.saveScheme({ kind: 'test', prompt: '恢复测试', seed: '77', boxType: 'kaiChuangHe', boxSize: { w: 180, d: 120, h: 55 }, size: '1800x1200', images: [] });
          await window.__app.loadScheme(rec);
          await new Promise((r) => setTimeout(r, 200));
          const s = window.__app.state;
          const o = {
            type: s.currentType,
            w: document.getElementById('size-w').value,
            d: document.getElementById('size-d').value,
            h: document.getElementById('size-h').value,
            ratio: document.getElementById('cfg-ratio').value,
            quality: document.getElementById('cfg-quality').value,
            prompt: document.getElementById('req-prompt').value,
            seed: document.getElementById('req-seed').value,
            errStatus: document.getElementById('gen-status').textContent.includes('载入失败'),
            imgCount: s.generatedImages.length,
          };
          await window.api.deleteScheme(rec.id);
          return o;
        })();

        // ================= 新批次：批量数量边界 =================
        out.batchEdge = (() => {
          // 直接调用真实实现（window.__app.clampBatchCount），防止测试镜像漂移
          const uiMax = Math.max(...Array.from(document.querySelectorAll('#batch-count option')).map((o) => Number(o.value)));
          return {
            clamp99: window.__app.clampBatchCount('99'),   // 超限输入 → 夹到 12
            clamp0: window.__app.clampBatchCount('0'),     // 0 → 回退 4
            clampNaN: window.__app.clampBatchCount('abc'), // 非法 → 回退 4
            uiMax,
            uiAllInRange: uiMax <= 12,
          };
        })();

        // ================= 新批次：生成守卫（空提示词不崩） =================
        out.generateGuard = (() => {
          const old = document.getElementById('req-prompt').value;
          document.getElementById('req-prompt').value = '';
          let res = 'no-prompt-return';
          try { window.__app.generate(); res = 'called'; } catch (e) { res = 'threw:' + e.message; }
          document.getElementById('req-prompt').value = old;
          return { res, status: document.getElementById('gen-status').textContent };
        })();

        // ================= 新批次：XML 转义与特殊字符注入 =================
        out.escXml = (() => {
          const s = window.escXml('A&B<C>D"E');
          const inj = (() => {
            const old = { f: window.__app.state.compFields, a: window.__app.state.compAuto };
            window.__app.state.compAuto = true;
            window.__app.state.compFields = { name: 'A&B<恐龙>', sku: 'T<1>', material: 'ABS&PC', standard: 'GB 6675', maker: '厂&社', warning: '3+ 岁' };
            const svg2 = window.__app.buildSvg(1, { showLabel: false });
            window.__app.state.compFields = old.f;
            window.__app.state.compAuto = old.a;
            const bare = (svg2.match(/&(?!amp;|lt;|gt;|quot;|#)/g) || []).length;
            return { bareAmpCount: bare, hasInjName: svg2.includes('A&amp;B&lt;恐龙&gt;') };
          })();
          return { escaped: s, escOk: s === 'A&amp;B&lt;C&gt;D&quot;E', inj };
        })();

        // ================= 新批次：条码 UI → state =================
        out.barcodeUI = (() => {
          const on = document.getElementById('barcode-enabled');
          const fmt = document.getElementById('barcode-format');
          const val = document.getElementById('barcode-value');
          const orig = { on: on.checked, fmt: fmt.value, val: val.value };
          on.checked = true; fmt.value = 'EAN13'; val.value = '6901234567892';
          window.__app.updateBarcode();
          const s1 = window.__app.state.barcode;
          val.value = ''; window.__app.updateBarcode();
          const s2 = window.__app.state.barcode;
          on.checked = orig.on; fmt.value = orig.fmt; val.value = orig.val;
          window.__app.updateBarcode();
          return { set: !!(s1 && s1.value === '6901234567892'), cleared: s2 === null };
        })();

        // ================= 新批次：配置档保存往返 =================
        out.configRoundtrip = await (async () => {
          const m0 = document.getElementById('cfg-model').value;
          const vm0 = document.getElementById('cfg-visionModel').value;
          document.getElementById('cfg-model').value = 'test-model-x';
          document.getElementById('cfg-visionModel').value = 'test-vision-x';
          await window.__app.saveConfig();
          const cfg = await window.api.getConfig();
          const p = (cfg.profiles || [])[cfg.activeIndex || 0] || {};
          document.getElementById('cfg-model').value = m0;
          document.getElementById('cfg-visionModel').value = vm0;
          await window.__app.saveConfig();
          return { modelSaved: p.model === 'test-model-x', visionSaved: p.visionModel === 'test-vision-x' };
        })();

        // ================= 新批次：主题切换（0.3.0，浅色默认 / 深色 / 跟随系统） =================
        out.theme = await (async () => {
          const sel = document.getElementById('cfg-theme');
          const orig = window.__app.state.theme;
          const lightDefault = document.documentElement.getAttribute('data-theme') === 'light'
            && window.__app.buildSvg(2, { bleed: 0, showLabel: false }).includes('fill="#ffffff"');
          // 切深色：data-theme 与 buildSvg 画布背景同步变化
          sel.value = 'dark';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          const darkApplied = document.documentElement.getAttribute('data-theme') === 'dark'
            && window.__app.buildSvg(2, { bleed: 0, showLabel: false }).includes('fill="#2a3140"');
          // 跟随系统：mock prefers-color-scheme 暗色 → system 模式应切到 dark
          const origMq = window.matchMedia;
          window.matchMedia = (q) => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
          sel.value = 'system';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          const systemDark = document.documentElement.getAttribute('data-theme') === 'dark';
          window.matchMedia = origMq;
          // 持久化：theme 随 setConfig 存取
          const rec = await window.api.setConfig({ theme: 'dark' });
          const got = await window.api.getConfig();
          const persisted = rec.theme === 'dark' && got.theme === 'dark';
          // 恢复浅色并持久化
          sel.value = 'light';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await window.api.setConfig({ theme: 'light' });
          return { lightDefault, darkApplied, systemDark, persisted, backToLight: document.documentElement.getAttribute('data-theme') === 'light' };
        })();

        // ================= 新批次：生成过程可视化（进度条 + 阶段文案 + 计时器 + 结果区覆盖层） =================
        out.progress = await (async () => {
          const wrap = document.getElementById('gen-progress');
          const bar = document.getElementById('gen-progress-bar');
          const ov = document.getElementById('gen-overlay');
          const csHidden = (el) => el && getComputedStyle(el).display === 'none';
          window.__app.genProgressDone();
          // 空闲/完成态：不仅 hidden 属性，实际渲染也必须不可见（防 display 覆盖 hidden 的回归）
          const initHidden = wrap.hidden === true && ov.hidden === true && csHidden(ov);
          window.__app.genProgress('🕐 测试生成中', 0.5);
          const shown = wrap.hidden === false;
          const width = bar.style.width;
          const ovShown = ov.hidden === false && !csHidden(ov);
          const ovBar = document.getElementById('gen-overlay-bar');
          const ovWidth = ovBar ? ovBar.style.width : '';
          const ovText = document.getElementById('gen-overlay-text').textContent;
          // 覆盖层为雾化玻璃效果：半透明背景 + backdrop blur（不是纯透明、也不是实心）
          const cs = ov ? getComputedStyle(ov) : null;
          const ovBg = cs ? cs.backgroundColor : '';
          const ovGlassBg = ovBg !== 'rgba(0, 0, 0, 0)' && ovBg !== 'transparent' && ovBg !== '';
          const ovBlur = cs ? cs.backdropFilter || cs.webkitBackdropFilter : '';
          // 注意：此处位于主进程模板字符串内，需用双反斜杠转义，渲染端才能收到 /blur\(/（裸 \( 会被丢弃反斜杠导致正则语法错误）
          const ovGlass = ovGlassBg && /blur\\(/.test(ovBlur);
          window.__app.genProgress('🕐 测试生成中', -1);
          const indet = bar.classList.contains('indeterminate');
          const ovIndet = ovBar ? ovBar.classList.contains('indeterminate') : false;
          window.__app.genTimerStart();
          await new Promise((r) => setTimeout(r, 1200));
          const timer = document.getElementById('gen-status').textContent.includes('已等待 1 秒');
          const ovTimer = document.getElementById('gen-overlay-text').textContent.includes('已等待 1 秒');
          window.__app.genProgressDone();
          const doneHidden = wrap.hidden === true && bar.style.width === '0px' && !bar.classList.contains('indeterminate') && ov.hidden === true && csHidden(ov);
          return { initHidden, shown, width, indet, timer, doneHidden, ovShown, ovWidth, ovText, ovIndet, ovTimer, ovGlass };
        })();

        // ================= 新批次：innerHTML 注入防护（renderQc / renderSchemes） =================
        out.injectionGuard = await (async () => {
          // renderQc：恶意 msg（如 AI 视觉返回的 notes）必须被转义，不产生裸标签
          window.__app.renderQc([{ level: 'fail', msg: '<img src=x onerror=1>' }, { level: 'warn', msg: '<script>alert(1)</script>' }]);
          const qcHtml = document.getElementById('qc-items').innerHTML;
          const qcEsc = qcHtml.includes('&lt;img') && qcHtml.includes('&lt;script&gt;') && !qcHtml.includes('<img src=x') && !qcHtml.includes('<script>alert');
          // renderSchemes：恶意 boxType（导入的 .toybox.json 可携带）必须被转义
          const evil = await window.api.saveScheme({ kind: 'test', prompt: 'p', seed: '', boxType: '<img src=x onerror=1>', boxSize: { w: 1, d: 1, h: 1 }, images: [] });
          await window.__app.loadSchemes();
          await new Promise((r) => setTimeout(r, 200));
          const schHtml = document.getElementById('scheme-list').innerHTML;
          const schEsc = schHtml.includes('&lt;img') && !schHtml.includes('<img src=x onerror=1>');
          await window.api.deleteScheme(evil.id);
          await window.__app.loadSchemes();
          return { qcEsc, schEsc };
        })();

        // ================= 新批次：路径白名单与导入净化（安全修复回归） =================
        out.pathGuard = await (async () => {
          // 1) 导入含恶意本地/UNC 路径的方案 → 图片路径全部被丢弃（不透传、不落盘）
          const imp = await window.api.importScheme(${JSON.stringify(evilPath)});
          const imgStripped = imp.imported && (imp.scheme.images || []).every((x) => x === '');
          // 1b) 净化后的方案（images 全空）必须能正常载入，不报"载入失败"
          let loadOk = false;
          if (imp.imported) {
            await window.__app.loadScheme(imp.scheme);
            await new Promise((r) => setTimeout(r, 200));
            loadOk = !document.getElementById('gen-status').textContent.includes('载入失败');
          }
          // 2) file:readImage 对白名单外路径（本地/UNC）必须拒绝（JSON.stringify 生成合法 JS 字面量）
          const readOutside = await window.api.readImage(${JSON.stringify('C:\\Windows\\win.ini')}).then(() => false, () => true);
          const readUnc = await window.api.readImage(${JSON.stringify('\\\\evil\\share\\x.png')}).then(() => false, () => true);
          if (imp.imported) await window.api.deleteScheme(imp.scheme.id);
          return { imgStripped, loadOk, readOutside, readUnc };
        })();

        // ================= 新批次：API 设置页「测试连接 / 设为使用中」 =================
        out.apiTest = await (async () => {
          const hasBtn = !!document.getElementById('btn-testApi') && !!document.getElementById('btn-setActive');
          // 1) 设为使用中：点击后结果区显示「当前使用中」，下拉选中项带 ⭐ 徽标
          await window.__app.setActive();
          await new Promise((r) => setTimeout(r, 100));
          const activeShown = document.getElementById('api-test-result').textContent.includes('当前使用中');
          const starShown = document.querySelector('#cfg-profile option:checked') && document.querySelector('#cfg-profile option:checked').textContent.includes('⭐');
          // 2) 测试连接：无 Key 时点击 → 显示「跳过」提示（不崩）
          const imgKey0 = document.getElementById('cfg-apiKey').value;
          const visKey0 = document.getElementById('cfg-visionApiKey').value;
          document.getElementById('cfg-apiKey').value = '';
          document.getElementById('cfg-visionApiKey').value = '';
          await window.__app.testApi();
          await new Promise((r) => setTimeout(r, 100));
          const skipShown = document.getElementById('api-test-result').textContent.includes('跳过');
          document.getElementById('cfg-apiKey').value = imgKey0;
          document.getElementById('cfg-visionApiKey').value = visKey0;
          // 3) 失败路径：连不上的地址 → ok:false 且不抛异常
          const fail = await window.api.testApi({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x' });
          return { hasBtn, activeShown, starShown, skipShown, failOk: !!(fail && fail.ok === false) };
        })();

        // ================= 新批次：去除水印（设置页 AI 水印=off → 生成时提示词约束，走保存路径） =================
        out.nowatermark = await (async () => {
          const sel = document.getElementById('cfg-watermark');
          if (!sel) return { hasCheck: false };
          const fn = window.__app.applyWatermarkGuard;
          // 1) off → 保存 → 约束生效；default → 保存 → 原样
          sel.value = 'off';
          await window.__app.saveConfig();
          const on = fn('一只恐龙');
          sel.value = 'default';
          await window.__app.saveConfig();
          const off = fn('一只恐龙');
          // 2) off 时空提示词 → 约束本身兜底
          sel.value = 'off';
          await window.__app.saveConfig();
          const empty = fn('');
          sel.value = 'off';
          return {
            hasCheck: true,
            onHasGuard: on.includes('无任何水印') && on.includes('一只恐龙'),
            offUnchanged: off === '一只恐龙',
            emptyFallsBack: empty === '画面干净，无任何水印、logo、文字、角标或装饰性符号',
          };
        })();

        // ================= 新批次：AI 水印三态（请求参数在 main 侧 sa 断言，此处只测渲染端 UI + 提示词约束） =================
        out.watermark = (() => {
          // 渲染端：三态下拉存在
          const sel = document.getElementById('cfg-watermark');
          const hasSelect = !!sel && ['off', 'default', 'on'].every((v) => sel.querySelector('option[value="' + v + '"]'));
          const fn = window.__app.applyWatermarkGuard;
          // 保存路径：off → 约束生效；default/on → 原样
          sel.value = 'off';
          window.__app.formToProfile(window.__app.getActiveIdx());
          const off = fn('一只恐龙');
          sel.value = 'default';
          window.__app.formToProfile(window.__app.getActiveIdx());
          const def = fn('一只恐龙');
          sel.value = 'on';
          window.__app.formToProfile(window.__app.getActiveIdx());
          const on = fn('一只恐龙');
          sel.value = 'off';
          window.__app.formToProfile(window.__app.getActiveIdx());
          return {
            hasSelect,
            offHasGuard: off.includes('无任何水印') && off.includes('一只恐龙'),
            defUnchanged: def === '一只恐龙',
            onUnchanged: on === '一只恐龙',
          };
        })();

        // ================= 新批次：缓存管理 UI（设置页） =================
        out.cacheUi = (() => {
          const hasBtns = !!document.getElementById('btn-cache-clean7') && !!document.getElementById('btn-cache-cleanAll') && !!document.getElementById('cache-status');
          const statusText = document.getElementById('cache-status').textContent;
          return { hasBtns, statusFilled: statusText.length > 0 };
        })();

        // ================= 新批次：条码即时校验（0.2.6） =================
        out.barcodeInvalid = await (async () => {
          const on = document.getElementById('barcode-enabled');
          const fmt = document.getElementById('barcode-format');
          const val = document.getElementById('barcode-value');
          const hint = document.getElementById('barcode-hint');
          const orig = { on: on.checked, fmt: fmt.value, val: val.value };
          // UPC 13 位 → 不绘制 + 提示
          on.checked = true; fmt.value = 'UPC'; val.value = '5595962666565';
          window.__app.updateBarcode();
          const upcLen = window.__app.state.barcode === null && !!hint.textContent;
          // EAN13 坏校验位 → 不绘制 + 提示
          fmt.value = 'EAN13'; val.value = '6901234567891';
          window.__app.updateBarcode();
          const eanCheck = window.__app.state.barcode === null && hint.textContent.includes('校验位');
          // 合法 EAN13 → 正常绘制
          val.value = '6901234567892';
          window.__app.updateBarcode();
          const eanOk = !!(window.__app.state.barcode && window.__app.state.barcode.value === '6901234567892');
          on.checked = orig.on; fmt.value = orig.fmt; val.value = orig.val;
          window.__app.updateBarcode();
          return { upcLen, eanCheck, eanOk };
        })();

        // ================= 新批次：条码自定义大小/位置（0.2.12） =================
        out.barcodeCustom = await (async () => {
          const on = document.getElementById('barcode-enabled');
          const fmt = document.getElementById('barcode-format');
          const val = document.getElementById('barcode-value');
          const wEl = document.getElementById('barcode-w'), hEl = document.getElementById('barcode-h');
          const xEl = document.getElementById('barcode-x'), yEl = document.getElementById('barcode-y');
          on.checked = true; fmt.value = 'CODE128'; val.value = '1234567890123';
          // 自定义宽 60mm + 位置 20%/70% → 与自动布局 SVG 不同、且为非等比 scale 语法
          wEl.value = '60'; hEl.value = ''; xEl.value = '20'; yEl.value = '70';
          window.__app.updateBarcode();
          const svgCustom = window.__app.buildSvg(300 / 25.4, { bleed: 3, showLabel: false });
          const hasCustom = window.__app.state.barcode && window.__app.state.barcode.w === 60 && window.__app.state.barcode.x === 20;
          const nonUniform = svgCustom.includes('scale(') && /scale\([^)]*,\s*[^)]*\)/.test(svgCustom);
          // 自动模式（参数留空）→ SVG 不同且为等比 scale
          wEl.value = ''; hEl.value = ''; xEl.value = ''; yEl.value = '';
          window.__app.updateBarcode();
          const svgAuto = window.__app.buildSvg(300 / 25.4, { bleed: 3, showLabel: false });
          const differs = svgCustom !== svgAuto;
          // 方案持久化：scheme:save 必须存 barcode（含自定义参数）+ 载入恢复输入框
          const rec = await window.api.saveScheme({
            kind: 'test', prompt: '条码方案', seed: '', boxType: 'tianDiGai', boxSize: { w: 200, d: 130, h: 60 }, images: [],
            compAuto: false, compFields: {}, markets: [], barcode: { format: 'CODE128', value: '1234567890123', w: 60, h: 30, x: 20, y: 70 }, bleed: true,
          });
          const list = await window.api.listSchemes();
          const got = list.find((s) => s.id === rec.id);
          const persisted = !!(got && got.barcode && got.barcode.format === 'CODE128' && got.barcode.value === '1234567890123' && got.barcode.w === 60 && got.barcode.h === 30 && got.barcode.x === 20 && got.barcode.y === 70);
          await window.__app.loadScheme(got);
          const restored = document.getElementById('barcode-enabled').checked === true
            && document.getElementById('barcode-w').value === '60'
            && document.getElementById('barcode-h').value === '30'
            && document.getElementById('barcode-x').value === '20'
            && document.getElementById('barcode-y').value === '70';
          await window.api.deleteScheme(rec.id);
          await window.__app.loadSchemes();
          on.checked = false; fmt.value = 'EAN13'; val.value = '';
          wEl.value = ''; hEl.value = ''; xEl.value = ''; yEl.value = '';
          window.__app.updateBarcode();
          return { hasCustom, nonUniform, differs, persisted, restored };
        })();

        // ================= 新批次：预览区条码直接拖拽/缩放（0.2.12） =================
        out.barcodeDrag = await (async () => {
          const on = document.getElementById('barcode-enabled');
          const fmt = document.getElementById('barcode-format');
          const val = document.getElementById('barcode-value');
          const wEl = document.getElementById('barcode-w'), hEl = document.getElementById('barcode-h');
          const xEl = document.getElementById('barcode-x'), yEl = document.getElementById('barcode-y');
          on.checked = true; fmt.value = 'CODE128'; val.value = '1234567890123';
          wEl.value = ''; hEl.value = ''; xEl.value = ''; yEl.value = '';
          window.__app.updateBarcode();
          const fire = (el, type, cx, cy) => {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
          };
          // 1) 缩放手柄（se 右下角）：mousedown → mousemove(+80,+50) → mouseup
          const se = document.querySelector('.bc-handle[data-bc="se"]');
          const autoW = window.__app.state.barcode.w;
          let resized = false;
          if (se) {
            const r = se.getBoundingClientRect();
            fire(se, 'mousedown', r.left + r.width / 2, r.top + r.height / 2);
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2 + 80, clientY: r.top + r.height / 2 + 50, button: 0 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            resized = window.__app.state.barcode.w !== null && window.__app.state.barcode.w > (autoW || 0) && document.getElementById('barcode-w').value !== '';
          }
          // 1b) 连续拖动（真实场景：每次 mousemove 都触发重绘）：se 手柄往里缩 4 次 → 应持续变小（用户反馈"往里缩却变大"回归）
          let shrinkOk = false;
          {
            const se2 = document.querySelector('.bc-handle[data-bc="se"]');
            const r2 = se2.getBoundingClientRect();
            const w0 = window.__app.state.barcode.w;
            fire(se2, 'mousedown', r2.left + r2.width / 2, r2.top + r2.height / 2);
            let cx = r2.left + r2.width / 2, cy = r2.top + r2.height / 2;
            const seq = [];
            for (let i = 0; i < 4; i++) {
              cx -= 40; cy -= 25; // 持续往里缩
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
              seq.push(window.__app.state.barcode.w);
            }
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const last = seq[seq.length - 1];
            shrinkOk = last !== null && last < w0 && seq.every((v, i) => i === 0 || v < seq[i - 1]); // 单调变小
          }
          // 1c) 四角等比缩放：设 60×30（比例 2:1），se 手柄斜向拖 (+90,+30) → 比例仍为 2:1 且变大
          let ratioOk = false;
          {
            wEl.value = '60'; hEl.value = '30'; xEl.value = ''; yEl.value = '';
            window.__app.updateBarcode();
            const se3 = document.querySelector('.bc-handle[data-bc="se"]');
            const r3 = se3.getBoundingClientRect();
            fire(se3, 'mousedown', r3.left + r3.width / 2, r3.top + r3.height / 2);
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: r3.left + r3.width / 2 + 90, clientY: r3.top + r3.height / 2 + 30, button: 0 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const b = window.__app.state.barcode;
            const ratio = b.w / b.h;
            ratioOk = b.w > 60 && Math.abs(ratio - 2) / 2 < 0.02; // 比例保持 2:1（±2%）
          }
          const body = document.querySelector('.bc-body');
          let moved = false;
          if (body) {
            const r = body.getBoundingClientRect();
            const x0 = window.__app.state.barcode.x, y0 = window.__app.state.barcode.y;
            fire(body, 'mousedown', r.left + r.width / 2, r.top + r.height / 2);
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2 + 60, clientY: r.top + r.height / 2 + 40, button: 0 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            moved = window.__app.state.barcode.x !== x0 && window.__app.state.barcode.y !== y0
              && document.getElementById('barcode-x').value !== '' && document.getElementById('barcode-y').value !== '';
          }
          // 3) 自动模式不应有手柄/命中区（interactive 未开或条码未设时）
          on.checked = false;
          window.__app.updateBarcode();
          const noOverlay = !document.querySelector('.bc-body, .bc-handle');
          on.checked = true;
          window.__app.updateBarcode();
          return { resized, shrinkOk, ratioOk, moved, noOverlay };
        })();

        // ================= 新批次：合规排版随方案存档/恢复（0.2.7） =================
        out.compScheme = await (async () => {
          window.__app.state.compAuto = true;
          window.__app.state.compFields = { name: '恢复品名', sku: 'R-001', material: 'PP', standard: 'GB 6675', maker: '测试厂', warning: '3+岁' };
          window.__app.state.markets = new Set(['cn']);
          const rec = await window.api.saveScheme({
            kind: 'test', prompt: 'p', seed: '', boxType: 'tianDiGai', boxSize: { w: 200, d: 130, h: 60 }, images: [],
            compAuto: true, compFields: window.__app.state.compFields, markets: ['cn'], barcode: { format: 'EAN13', value: '6901234567892' }, bleed: true,
          });
          const list = await window.api.listSchemes();
          const saved = list.find((x) => x.id === rec.id);
          await window.__app.loadScheme(rec);
          const nameEl = document.getElementById('comp-name');
          const restored = nameEl.value === '恢复品名'
            && window.__app.state.markets.has('cn')
            && window.__app.state.barcode && window.__app.state.barcode.value === '6901234567892'
            && document.getElementById('comp-auto').checked === true
            && document.getElementById('opt-bleed').checked === true;
          await window.api.deleteScheme(rec.id);
          await window.__app.loadSchemes();
          // 用例 2：方案存了 compAuto=false 但含合规内容 → 载入后必须自动勾选（用户反馈：内容在但选项未勾）
          window.__app.state.compAuto = false;
          const rec2 = await window.api.saveScheme({
            kind: 'test', prompt: 'p', seed: '', boxType: 'tianDiGai', boxSize: { w: 200, d: 130, h: 60 }, images: [],
            compAuto: false, compFields: { name: '恐龙积木', sku: 'jdy11111', material: '塑料', standard: 'GB 6675', maker: '厂', warning: '12+' }, markets: [], barcode: {}, bleed: true,
          });
          await window.__app.loadScheme(rec2);
          const autoOnByContent = document.getElementById('comp-auto').checked === true && window.__app.state.compAuto === true;
          await window.api.deleteScheme(rec2.id);
          await window.__app.loadSchemes();
          return { saved: !!(saved && saved.compFields && saved.compFields.name === '恢复品名'), restored, autoOnByContent };
        })();

        // ================= 新批次：方案更新（💾）条码/合规等字段（0.2.12） =================
        out.schemeUpdate = await (async () => {
          const rec = await window.api.saveScheme({
            kind: 'test', prompt: '旧提示词', seed: '', boxType: 'tianDiGai', boxSize: { w: 200, d: 130, h: 60 }, images: [],
            compAuto: false, compFields: {}, markets: [], barcode: null, bleed: false,
          });
          const upd = await window.api.updateScheme(rec.id, {
            kind: 'test', prompt: '新提示词', seed: '', boxType: 'tianDiGai', boxSize: { w: 200, d: 130, h: 60 }, images: [],
            compAuto: true, compFields: { name: '恐龙积木', sku: 'jdy11111', material: '塑料', standard: 'GB 6675', maker: '厂', warning: '12+' }, markets: ['cn'],
            barcode: { format: 'CODE128', value: '1516516121321' }, bleed: true,
          });
          const list = await window.api.listSchemes();
          const got = list.find((x) => x.id === rec.id);
          const storedOk = !!(got && got.barcode && got.barcode.format === 'CODE128' && got.barcode.value === '1516516121321' && got.compAuto === true && got.bleed === true);
          // 载入后条码/合规/勾选全部恢复
          await window.__app.loadScheme(got);
          const barcodeChecked = document.getElementById('barcode-enabled').checked === true;
          const barcodeVal = document.getElementById('barcode-value').value === '1516516121321';
          const barcodeFmt = document.getElementById('barcode-format').value === 'CODE128';
          const compChecked = document.getElementById('comp-auto').checked === true;
          const nameVal = document.getElementById('comp-name').value === '恐龙积木';
          const promptVal = $('req-prompt').value === '新提示词';
          await window.api.deleteScheme(rec.id);
          await window.__app.loadSchemes();
          return { storedOk, restored: barcodeChecked && barcodeVal && barcodeFmt && compChecked && nameVal && promptVal };
        })();

        // ================= 新批次：合规检查全部勾选/取消全部（0.2.8） =================
        out.compSelectAll = await (async () => {
          window.__app.state.markets = new Set(['cn']);
          window.__app.state.compDone = new Set();
          window.__app.renderCompliance();
          const btns = document.querySelectorAll('#compliance-items .comp-select-row button');
          const allBtn = btns[0], noneBtn = btns[1];
          if (!allBtn || !noneBtn) return { hasBtns: false };
          allBtn.click();
          const afterAll = window.__app.state.compDone.size;
          const total = window.ComplianceData.markets.cn.items.length;
          noneBtn.click();
          const afterNone = window.__app.state.compDone.size;
          return { hasBtns: true, afterAll, total, afterNone };
        })();

        step('done');
        return out;
        } catch (err) { console.log('SMOKE STEP FAIL:', err && err.stack ? err.stack : JSON.stringify(err)); throw err; }
      })()`);

      // PDF/X 端到端：printToPDF → Ghostscript 转 PDF/X-3 CMYK（forcePath 直接输出，不弹窗）
      const pdfPath = path.join(app.getPath('temp'), 'toybox_smoke.pdf');
      let pdfxOut;
      try {
        pdfxOut = await mainWindow.webContents.executeJavaScript(`(async () => {
          const svg = window.__app.buildSvg(300 / 25.4, { bleed: 3 });
          const t = window.__app.state.templates[window.__app.state.currentType];
          const layout = t.build({ w: 200, d: 130, h: 60 });
          const res = await window.api.exportPdfX({
            svg,
            widthMm: layout.width + 6,
            heightMm: layout.height + 6,
            defaultName: 'smoke.pdf',
            forcePath: ${JSON.stringify(pdfPath)},
          });
          return res;
        })()`);
      } catch (err) {
        pdfxOut = { error: String(err.message || err) };
      }
      let pdfxVerify = { error: 'no file' };
      if (pdfxOut.saved && fs.existsSync(pdfPath)) {
        const buf = fs.readFileSync(pdfPath);
        const txt = buf.toString('latin1');
        const trim = txt.match(/\/TrimBox\s*\[\s*([^\]]+)/);
        pdfxVerify = {
          sizeKB: Math.round(buf.length / 1024),
          pdfHeader: buf.slice(0, 5).toString() === '%PDF-',
          hasPdfxMarker: buf.includes(Buffer.from('GTS_PDFXVersion')),
          hasX3: txt.includes('PDF/X-3:2002'),
          trimBox: trim ? trim[1] : 'NONE',
          trimInset: trim ? trim[1].split(/\s+/).map(Number)[0] : -1, // 第一个值应为 8.5pt（3mm）
          gsPath: !!pdfxOut.gs,
        };
        // PDF 内容非空白校验：gs 转 PNG 统计非白像素比例（防"白图"回归——文件头/PDFX 标记校验抓不到内容缺失）
        // 必须在 unlinkSync(pdfPath) 之前执行，否则 gs 读不到输入文件
        let contentRatio = -1;
        try {
          const gsRoot = fs.existsSync(path.join(process.resourcesPath, 'gs')) ? process.resourcesPath : path.join(__dirname, 'resources');
          const gsExe = path.join(gsRoot, 'gs', 'Library', 'bin', 'gswin64c.exe');
          const pngTmp = path.join(app.getPath('temp'), 'toybox_smoke_pdf.png');
          const tmpDirPermit = path.dirname(pdfPath).replace(/\\/g, '/'); // SAFER 下放行 temp 读（PDF）写（PNG）
          const r = spawnSync(gsExe, [`--permit-file-read=${tmpDirPermit}`, `--permit-file-write=${tmpDirPermit}`, '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=png16m', '-r72', `-sOutputFile=${pngTmp}`, pdfPath], { encoding: 'utf8' });
          if (r.status === 0 && fs.existsSync(pngTmp)) {
            const img = nativeImage.createFromPath(pngTmp);
            const bmp = img.toBitmap(); // BGRA
            let nonWhite = 0, total = 0;
            for (let i = 0; i < bmp.length; i += 4) {
              const b = bmp[i], g = bmp[i + 1], rr = bmp[i + 2], a = bmp[i + 3];
              total++;
              if (a > 0 && (rr < 245 || g < 245 || b < 245)) nonWhite++;
            }
            contentRatio = total ? Math.round((nonWhite / total) * 10000) / 100 : -1;
            try { fs.unlinkSync(pngTmp); } catch (e) { /* ignore */ }
          }
        } catch (e) { contentRatio = -1; }
        pdfxVerify.contentRatio = contentRatio;
        try { fs.unlinkSync(pdfPath); } catch (e) { /* ignore */ }
      } else {
        pdfxVerify = { error: pdfxOut.error || 'save failed', result: pdfxOut };
      }
      const gsSt = await mainWindow.webContents.executeJavaScript(`window.api.gsStatus()`);
      dom.pdfx = { export: pdfxVerify, gs: gsSt };

      // 3D mockup 视觉验证：截屏保存，供外部识图确认盒子渲染
      try {
        // 可选：截图前切到指定页签（如 SMOKE_LAST_PAGE=preview 截预览页；JSON.stringify 防注入）
        if (process.env.SMOKE_LAST_PAGE) {
          await mainWindow.webContents.executeJavaScript(
            `document.querySelector('.tab[data-page=${JSON.stringify(process.env.SMOKE_LAST_PAGE)}]').click()`
          );
        }
        await new Promise((r) => setTimeout(r, 2500)); // 等 renderMockup + WebGL 首帧渲染完成
        const img = await mainWindow.webContents.capturePage();
        const capPath = path.join(app.getPath('temp'), 'toybox_mockup.png');
        fs.writeFileSync(capPath, img.toPNG());
        console.log('SMOKE CAPTURE:', capPath);
      } catch (e) {
        console.log('SMOKE CAPTURE 失败:', e && e.message);
      }
      // ===== SMOKE 硬断言：关键修复与功能必须有值，否则 exit 1（防止"输出了但没校验"） =====
      const sa = (name, cond) => {
        if (cond) console.log('SMOKE_ASSERT_OK:', name);
        else { errors.push('SMOKE_ASSERT_FAIL: ' + name); console.log('SMOKE_ASSERT_FAIL:', name); }
      };
      sa('geometry.tianDiGai.noOverlap', dom.geometry && dom.geometry.tianDiGai.overlap === '');
      sa('geometry.kaiChuangHe.noOverlap', dom.geometry && dom.geometry.kaiChuangHe.overlap === '');
      sa('geometry.shuangChaHe.noOverlap', dom.geometry && dom.geometry.shuangChaHe.overlap === '');
      sa('geometry.windowInside', dom.geometry && dom.geometry.kaiChuangHe.winInside === true);
      sa('schemeRestore.noError', dom.schemeRestore && dom.schemeRestore.errStatus === false);
      sa('schemeRestore.restores', dom.schemeRestore && dom.schemeRestore.type === 'kaiChuangHe' && dom.schemeRestore.prompt === '恢复测试');
      sa('batchEdge.clamp99', dom.batchEdge && dom.batchEdge.clamp99 === 12);
      sa('batchEdge.clamp0', dom.batchEdge && dom.batchEdge.clamp0 === 4);
      sa('batchEdge.uiInRange', dom.batchEdge && dom.batchEdge.uiAllInRange === true);
      sa('injectionGuard.qc', dom.injectionGuard && dom.injectionGuard.qcEsc === true);
      sa('injectionGuard.schemes', dom.injectionGuard && dom.injectionGuard.schEsc === true);
      sa('escXml.ok', dom.escXml && dom.escXml.escOk === true);
      sa('escXml.noBareAmp', dom.escXml && dom.escXml.inj && dom.escXml.inj.bareAmpCount === 0);
      sa('barcode.ean', dom.barcodeLogic && dom.barcodeLogic.valid13 === true && dom.barcodeLogic.invalid13 === false);
      sa('barcode.badCheckNotDrawn', dom.barcodeLogic && dom.barcodeLogic.makeInvalidCheck && dom.barcodeLogic.makeInvalidCheck.drew === false);
      sa('exportDims.match', dom.exportDims && dom.exportDims.matches === true);
      sa('qc.okNoFails', dom.qc && dom.qc.okNoFails === true);
      sa('qc.failWhenNoImage', dom.qc && dom.qc.failWhenNoImage === true);
      sa('pdfx.export', dom.pdfx && dom.pdfx.export && dom.pdfx.export.hasPdfxMarker === true && typeof dom.pdfx.export.trimInset === 'number' && Math.abs(dom.pdfx.export.trimInset - 8.5039) < 0.005);
      sa('pdfx.contentNonBlank', dom.pdfx && typeof dom.pdfx.export.contentRatio === 'number' && dom.pdfx.export.contentRatio > 1);
      sa('mockup.threeBoxes', dom.mockupAllBoxes && dom.mockupAllBoxes.length === 3 && dom.mockupAllBoxes.every((b) => b.ok === true));
      sa('configRoundtrip', dom.configRoundtrip && dom.configRoundtrip.modelSaved === true && dom.configRoundtrip.visionSaved === true);
      sa('theme.lightDefault', dom.theme && dom.theme.lightDefault === true);
      sa('theme.darkApplied', dom.theme && dom.theme.darkApplied === true);
      sa('theme.systemDark', dom.theme && dom.theme.systemDark === true);
      sa('theme.persisted', dom.theme && dom.theme.persisted === true);
      sa('theme.backToLight', dom.theme && dom.theme.backToLight === true);
      sa('progress.initHidden', dom.progress && dom.progress.initHidden === true);
      sa('progress.show', dom.progress && dom.progress.shown === true && dom.progress.width === '50%');
      sa('progress.indeterminate', dom.progress && dom.progress.indet === true);
      sa('progress.timer', dom.progress && dom.progress.timer === true);
      sa('progress.done', dom.progress && dom.progress.doneHidden === true);
      sa('progress.overlay', dom.progress && dom.progress.ovShown === true && dom.progress.ovWidth === '50%' && dom.progress.ovText.includes('测试生成中') && dom.progress.ovIndet === true && dom.progress.ovTimer === true);
      sa('progress.overlayGlass', dom.progress && dom.progress.ovGlass === true);
      sa('help.tutorial', dom.help && dom.help.tabExists === true && dom.help.active === true && dom.help.imgs === 7 && dom.help.loadedOk === true && dom.help.haveAll === true && dom.help.faqCount >= 5);
      sa('help.apiKeys', dom.help && dom.help.apiDetails >= 5 && dom.help.hasRec3 === true && dom.help.noMoonshot === true);
      sa('help.links', dom.help && dom.help.apiLinks >= 5 && dom.help.linksOk === true);
      sa('brand.logoSvg', dom.brand && dom.brand.logoSvg === true && dom.brand.noEmoji === true);
      sa('multiImage.thumbs', dom.multiImage && dom.multiImage.thumbCount === 2 && dom.afterSwitch && dom.afterSwitch.activeIndex === 1);
      sa('resultNav.visible', dom.resultNav && dom.resultNav.hasPrevNext === true && dom.resultNav.navVisible === true && dom.resultNav.counter1of4 === true);
      sa('resultNav.next', dom.resultNav && dom.resultNav.idxAfterNext === 1 && dom.resultNav.counter2of4 === true);
      sa('resultNav.loopBack', dom.resultNav && dom.resultNav.idxLoopBack === true);
      sa('sizeSync.has55', dom.sizeSync && dom.sizeSync.has55 === true);
      sa('roundtrip.scheme', dom.roundtrip && dom.roundtrip.exported === true && dom.roundtrip.imported === true && dom.roundtrip.promptPreserved === true);
      sa('groupPrompt.shots', dom.groupPrompt && dom.groupPrompt.hasShot1 === true && dom.groupPrompt.hasShot3 === true && dom.groupPrompt.n3 === true);
      sa('pathGuard.imgStripped', dom.pathGuard && dom.pathGuard.imgStripped === true);
      sa('pathGuard.loadOk', dom.pathGuard && dom.pathGuard.loadOk === true);
      sa('pathGuard.readOutside', dom.pathGuard && dom.pathGuard.readOutside === true);
      sa('pathGuard.readUnc', dom.pathGuard && dom.pathGuard.readUnc === true);
      sa('apiTest.uiButtons', dom.apiTest && dom.apiTest.hasBtn === true);
      sa('apiTest.setActive', dom.apiTest && dom.apiTest.activeShown === true && dom.apiTest.starShown === true);
      sa('apiTest.skipWhenNoKey', dom.apiTest && dom.apiTest.skipShown === true);
      sa('apiTest.failPath', dom.apiTest && dom.apiTest.failOk === true);
      // 主进程侧：水印请求参数构造（lib/imgRequest.js 三态；buildImageRequest 已由顶部 require）
      {
        const wmBase = { model: 'm', prompt: 'p', size: '1K' };
        const wmVolces = 'https://ark.cn-beijing.volces.com/api/v3';
        const wmOpenai = 'https://api.openai.com/v1';
        const wmSilent = 'https://api.siliconflow.cn/v1';
        const offVolces = buildImageRequest({ ...wmBase, baseUrl: wmVolces, watermark: 'off' }).body;
        const offOpenai = buildImageRequest({ ...wmBase, baseUrl: wmOpenai, watermark: 'off' }).body;
        const offSilent = buildImageRequest({ ...wmBase, baseUrl: wmSilent, watermark: 'off' }).body;
        const defVolces = buildImageRequest({ ...wmBase, baseUrl: wmVolces, watermark: 'default' }).body;
        const onVolces = buildImageRequest({ ...wmBase, baseUrl: wmVolces, watermark: 'on' }).body;
        const onOpenai = buildImageRequest({ ...wmBase, baseUrl: wmOpenai, watermark: 'on' }).body;
        sa('watermarkReq.offVolces', offVolces.watermark === false);
        sa('watermarkReq.offOpenai', offOpenai.add_watermark === false && offOpenai.watermark === undefined);
        sa('watermarkReq.offSilent', offSilent.watermark === false);
        sa('watermarkReq.defNoParam', !('watermark' in defVolces) && !('add_watermark' in defVolces));
        sa('watermarkReq.onVolces', onVolces.watermark === true);
        sa('watermarkReq.onOpenai', onOpenai.add_watermark === true);
      }
      // 主进程侧：缓存管理（造假文件 → info/clean7/cleanAll 全链路，含"方案引用图保护"回归，0.2.7）
      {
        const imgDir = cacheDir();
        fs.mkdirSync(imgDir, { recursive: true });
        const now = Date.now();
        fs.writeFileSync(path.join(imgDir, 'box_new.png'), Buffer.from('x'));
        const oldF = path.join(imgDir, 'box_old.png');
        fs.writeFileSync(oldF, Buffer.from('y'));
        const oldT = new Date(now - 10 * 86400000);
        fs.utimesSync(oldF, oldT, oldT);
        // 受保护图：写入 manifest（模拟历史方案引用）——cleanAll 后必须保留
        const kept = path.join(imgDir, 'box_kept.png');
        fs.writeFileSync(kept, Buffer.from('z'));
        const manDir = path.join(app.getPath('userData'), 'schemes');
        fs.mkdirSync(manDir, { recursive: true });
        fs.writeFileSync(path.join(manDir, 'manifest.json'), JSON.stringify([{ id: 's_kept', ts: Date.now(), images: [kept] }]));
        const infoBefore = cacheInfo();
        const r7 = cleanCache(7);
        const infoAfter7 = cacheInfo();
        const rAll = cleanCache(0);
        const infoAfterAll = cacheInfo();
        sa('cache.infoCounts', infoBefore.fileCount === 3 && infoBefore.bytes === 3);
        sa('cache.clean7OnlyOld', r7.removed === 1 && infoAfter7.fileCount === 2);
        sa('cache.cleanAll', rAll.removed === 1 && infoAfterAll.fileCount === 1); // clean7 已删 old，cleanAll 只删未被引用的 new
        sa('cache.protectKept', fs.existsSync(kept)); // 方案引用图被保护（0.2.7 回归）
      }
      sa('nowatermark.check', dom.nowatermark && dom.nowatermark.hasCheck === true);
      sa('nowatermark.offUnchanged', dom.nowatermark && dom.nowatermark.offUnchanged === true);
      sa('nowatermark.onHasGuard', dom.nowatermark && dom.nowatermark.onHasGuard === true);
      sa('nowatermark.emptyFallsBack', dom.nowatermark && dom.nowatermark.emptyFallsBack === true);
      sa('watermark.uiSelect', dom.watermark && dom.watermark.hasSelect === true);
      sa('watermark.offGuard', dom.watermark && dom.watermark.offHasGuard === true);
      sa('watermark.defOnUnchanged', dom.watermark && dom.watermark.defUnchanged === true && dom.watermark.onUnchanged === true);
      sa('cache.ui', dom.cacheUi && dom.cacheUi.hasBtns === true && dom.cacheUi.statusFilled === true);
      // ================= 新断言批次：0.2.3~0.2.8 功能回归 =================
      {
        // seed 类型（0.2.3）：字符串 → 数字；空 seed 不传
        const seedNum = buildImageRequest({ model: 'm', prompt: 'p', size: '1K', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', seed: '42', watermark: 'off' }).body.seed;
        const seedEmpty = buildImageRequest({ model: 'm', prompt: 'p', size: '1K', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', seed: '', watermark: 'off' }).body;
        // 图生图（0.2.4）：image 为完整 data URL
        const imgData = buildImageRequest({ model: 'm', prompt: 'p', size: '1K', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', seed: '', image: 'data:image/webp;base64,ZmFrZQ==', watermark: 'off' }).body.image;
        sa('seedType.num', seedNum === 42 && typeof seedNum === 'number');
        sa('seedType.emptyOmit', !('seed' in seedEmpty));
        sa('imgRef.dataUrl', typeof imgData === 'string' && imgData.startsWith('data:image/webp;base64,'));
      }
      sa('barcodeInvalid.upcLen', dom.barcodeInvalid && dom.barcodeInvalid.upcLen === true);
      sa('barcodeInvalid.eanCheck', dom.barcodeInvalid && dom.barcodeInvalid.eanCheck === true);
      sa('barcodeInvalid.eanOk', dom.barcodeInvalid && dom.barcodeInvalid.eanOk === true);
      sa('barcode.customSize', dom.barcodeCustom && dom.barcodeCustom.hasCustom === true && dom.barcodeCustom.nonUniform === true && dom.barcodeCustom.differs === true);
      sa('barcode.schemePersist', dom.barcodeCustom && dom.barcodeCustom.persisted === true);
      sa('barcode.customRestore', dom.barcodeCustom && dom.barcodeCustom.restored === true);
      sa('barcode.dragResize', dom.barcodeDrag && dom.barcodeDrag.resized === true && dom.barcodeDrag.moved === true);
      sa('barcode.dragShrinkMonotonic', dom.barcodeDrag && dom.barcodeDrag.shrinkOk === true);
      sa('barcode.dragAspectLocked', dom.barcodeDrag && dom.barcodeDrag.ratioOk === true);
      sa('barcode.dragNoOverlayWhenOff', dom.barcodeDrag && dom.barcodeDrag.noOverlay === true);
      sa('compScheme.saved', dom.compScheme && dom.compScheme.saved === true);
      sa('compScheme.restored', dom.compScheme && dom.compScheme.restored === true);
      sa('compScheme.autoOnByContent', dom.compScheme && dom.compScheme.autoOnByContent === true);
      sa('schemeUpdate.stored', dom.schemeUpdate && dom.schemeUpdate.storedOk === true);
      sa('schemeUpdate.restored', dom.schemeUpdate && dom.schemeUpdate.restored === true);
      sa('compSelectAll.buttons', dom.compSelectAll && dom.compSelectAll.hasBtns === true);
      sa('compSelectAll.count', dom.compSelectAll && dom.compSelectAll.afterAll === dom.compSelectAll.total && dom.compSelectAll.afterNone === 0);
      console.log('SMOKE DOM:', JSON.stringify(dom, null, 2));
      console.log('SMOKE JS 错误:', errors.length ? errors : '无');
      // 保存 3D canvas 像素图（供外部识图确认）
      if (dom.mockupPng) {
        try {
          fs.writeFileSync(path.join(app.getPath('temp'), 'toybox_mockup3d.png'), Buffer.from(dom.mockupPng.split(',')[1], 'base64'));
        } catch (e) { /* ignore */ }
      }
      delete dom.mockupPng;
      app.exit(errors.length ? 1 : 0);
    });
  }
}

/* ---------------- IPC ---------------- */
ipcMain.handle('config:get', () => readConfig());
/** 配置档（profile）字段白名单 */
const PROFILE_FIELDS = ['name', 'apiKey', 'imageBaseUrl', 'model', 'visionModel', 'visionBaseUrl', 'visionApiKey', 'watermark'];
ipcMain.handle('config:set', (_e, cfg) => {
  // schema 校验：仅接受白名单字段（防任意结构写入损坏配置）
  const src = (cfg && typeof cfg === 'object') ? cfg : {};
  const merged = readConfig();
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (typeof src[k] === 'string') merged[k] = src[k].slice(0, 2048);
  }
  if (Array.isArray(src.profiles)) {
    merged.profiles = src.profiles.slice(0, 20).map((p) => {
      const out = {};
      if (p && typeof p === 'object') {
        for (const k of PROFILE_FIELDS) {
          if (typeof p[k] === 'string') out[k] = p[k].slice(0, 2048);
        }
      }
      out.watermark = ['off', 'default', 'on'].includes(out.watermark) ? out.watermark : 'off';
      return out;
    });
    const n = Number(src.activeIndex);
    merged.activeIndex = Number.isFinite(n) ? Math.min(merged.profiles.length - 1, Math.max(0, Math.floor(n))) : 0;
  }
  if (typeof src.size === 'string') merged.size = src.size.slice(0, 32);
  if (typeof src.ratio === 'string') merged.ratio = src.ratio.slice(0, 16);
  if (typeof src.quality === 'string') merged.quality = src.quality.slice(0, 16);
  if (['light', 'dark', 'system'].includes(src.theme)) merged.theme = src.theme;
  writeConfig(merged);
  return merged;
});
ipcMain.handle('image:generate', (_e, opts) => {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const cfg = readConfig();
  const prompt = typeof o.prompt === 'string' ? o.prompt.slice(0, 4000) : '';
  if (!prompt) throw new Error('提示词为空');
  return generateImage({
    baseUrl: typeof o.imageBaseUrl === 'string' ? o.imageBaseUrl : cfg.imageBaseUrl,
    prompt,
    model: typeof o.model === 'string' ? o.model.slice(0, 200) : cfg.model,
    size: typeof o.size === 'string' ? o.size.slice(0, 32) : cfg.size,
    seed: typeof o.seed === 'string' && /^\d+$/.test(o.seed) && Number(o.seed) >= 1 && Number(o.seed) <= 2147483647 ? o.seed : undefined, // 主进程兜底：非法/超范围 seed 忽略
    image: typeof o.image === 'string' ? o.image.slice(0, 30 * 1024 * 1024) : o.image,
    maxImages: Math.min(6, Math.max(1, Number(o.maxImages) || 1)), // 主进程兜底 clamp，防渲染端被绕过烧额度
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : cfg.apiKey,
    watermark: typeof o.watermark === 'string' ? o.watermark : 'off',
  });
});
ipcMain.handle('file:save', async (_e, { defaultName, dataBase64 }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '保存文件',
    defaultPath: path.join(app.getPath('downloads'), defaultName || 'box.png'),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { saved: false };
  const b64 = dataBase64.includes('base64,') ? dataBase64.split('base64,')[1] : dataBase64;
  if (typeof b64 !== 'string' || b64.length * 0.75 > 64 * 1024 * 1024) throw new Error('图片数据过大');
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  return { saved: true, filePath };
});

/* ---------------- PDF/X 印刷稿 ---------------- */
ipcMain.handle('gs:status', () => gsStatus());
ipcMain.handle('pdf:export', (_e, opts) => exportPdfX(opts));

/* ---------------- 历史方案库 ---------------- */
const schemesDir = () => path.join(app.getPath('userData'), 'schemes');
const manifestPath = () => path.join(schemesDir(), 'manifest.json');
function readSchemes() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch {
    return [];
  }
}
/** 方案字段白名单：防渲染端传入 id/ts 覆盖主进程值、防任意字段膨胀 manifest */
const SCHEME_FIELDS = ['kind', 'prompt', 'model', 'size', 'seed', 'boxType', 'boxSize', 'images', 'compAuto', 'compFields', 'markets', 'barcode', 'bleed'];
const COMP_FIELD_KEYS = ['name', 'sku', 'material', 'standard', 'maker', 'warning'];
const clampNum = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
/** 条码自定义参数清洗：仅接受有限数值，其余为 null（= 自动） */
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
/** 合规排版信息清洗（存/导入共用，防任意结构写入 manifest） */
function cleanCompInfo(s) {
  return {
    compAuto: !!(s && s.compAuto),
    compFields: (s && s.compFields && typeof s.compFields === 'object')
      ? Object.fromEntries(COMP_FIELD_KEYS.filter((k) => typeof s.compFields[k] === 'string').map((k) => [k, s.compFields[k].slice(0, 200)]))
      : {},
    markets: (s && Array.isArray(s.markets)) ? s.markets.filter((m) => typeof m === 'string' && m.length <= 16).slice(0, 10) : [],
    barcode: (s && s.barcode && typeof s.barcode === 'object' && typeof s.barcode.format === 'string' && typeof s.barcode.value === 'string' && s.barcode.value)
      ? { format: s.barcode.format.slice(0, 16), value: s.barcode.value.slice(0, 32) }
      : null,
    bleed: !!(s && s.bleed),
  };
}
ipcMain.handle('scheme:list', () => readSchemes());
ipcMain.handle('scheme:save', (_e, s) => {
  const list = readSchemes();
  const src = (s && typeof s === 'object') ? s : {};
  const rec = {
    id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    ...cleanCompInfo(src),
  };
  for (const k of SCHEME_FIELDS) {
    if (k === 'images') {
      rec.images = Array.isArray(src.images)
        ? src.images.filter((p) => typeof p === 'string' && p.length <= 512).slice(0, 12)
        : [];
    } else if (k === 'boxSize' && src.boxSize && typeof src.boxSize === 'object') {
      rec.boxSize = {
        w: clampNum(src.boxSize.w, 1, 500),
        d: clampNum(src.boxSize.d, 1, 500),
        h: clampNum(src.boxSize.h, 1, 500),
      };
    } else if (k === 'barcode') {
      // 条码对象持久化（曾缺失此分支导致条码从未存进方案）：格式/编码 + 自定义大小/位置参数
      rec.barcode = (src.barcode && typeof src.barcode === 'object' && typeof src.barcode.format === 'string' && typeof src.barcode.value === 'string')
        ? {
            format: src.barcode.format.slice(0, 16),
            value: src.barcode.value.slice(0, 64),
            w: numOrNull(src.barcode.w), h: numOrNull(src.barcode.h),
            x: numOrNull(src.barcode.x), y: numOrNull(src.barcode.y),
          }
        : null;
    } else if (typeof src[k] === 'string') {
      rec[k] = src[k].slice(0, 2000);
    } else if (k !== 'compAuto' && k !== 'compFields' && k !== 'markets' && k !== 'barcode' && k !== 'bleed') {
      rec[k] = '';
    }
  }
  list.unshift(rec);
  if (list.length > 100) list.length = 100;
  fs.mkdirSync(schemesDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(list, null, 1));
  return rec;
});
ipcMain.handle('scheme:delete', (_e, id) => {
  const list = readSchemes().filter((s) => s.id !== id);
  fs.writeFileSync(manifestPath(), JSON.stringify(list, null, 1));
  return { ok: true };
});
/** 更新已存方案的可编辑字段（条码/合规/尺寸/出血/提示词等；images 属于生成快照，不随更新变化） */
ipcMain.handle('scheme:update', (_e, id, s) => {
  const list = readSchemes();
  const rec = list.find((x) => x.id === id);
  if (!rec) return { ok: false, error: '方案不存在' };
  const src = (s && typeof s === 'object') ? s : {};
  for (const k of SCHEME_FIELDS) {
    if (k === 'images') continue; // 图片快照不可更新
    if (k === 'boxSize' && src.boxSize && typeof src.boxSize === 'object') {
      rec.boxSize = { w: clampNum(src.boxSize.w, 1, 500), d: clampNum(src.boxSize.d, 1, 500), h: clampNum(src.boxSize.h, 1, 500) };
    } else if (k === 'compAuto') {
      rec.compAuto = !!src.compAuto;
    } else if (k === 'compFields' && src.compFields && typeof src.compFields === 'object') {
      rec.compFields = { name: '', sku: '', material: '', standard: '', maker: '', warning: '' };
      for (const f of ['name', 'sku', 'material', 'standard', 'maker', 'warning']) {
        if (typeof src.compFields[f] === 'string') rec.compFields[f] = src.compFields[f].slice(0, 200);
      }
    } else if (k === 'markets' && Array.isArray(src.markets)) {
      rec.markets = src.markets.filter((m) => typeof m === 'string').slice(0, 8);
    } else if (k === 'barcode') {
      rec.barcode = (src.barcode && typeof src.barcode === 'object' && typeof src.barcode.format === 'string' && typeof src.barcode.value === 'string')
        ? { format: src.barcode.format.slice(0, 16), value: src.barcode.value.slice(0, 64), w: numOrNull(src.barcode.w), h: numOrNull(src.barcode.h), x: numOrNull(src.barcode.x), y: numOrNull(src.barcode.y) }
        : null;
    } else if (k === 'bleed') {
      rec.bleed = !!src.bleed;
    } else if (typeof src[k] === 'string') {
      rec[k] = src[k].slice(0, 2000);
    }
  }
  rec.ts = Date.now();
  fs.writeFileSync(manifestPath(), JSON.stringify(list, null, 1));
  return { ok: true, rec };
});
ipcMain.handle('file:readImage', (_e, p) => {
  if (!isInsideImagesDir(p)) throw new Error('仅允许读取应用图片目录内的文件');
  const st = fs.statSync(p);
  if (!st.isFile() || st.size > 64 * 1024 * 1024) throw new Error('图片不存在或过大');
  const buf = fs.readFileSync(p);
  const det = detectImageFormat(buf);
  if (!det) throw new Error('非图片文件');
  return `data:${det.mime};base64,${buf.toString('base64')}`;
});

/** 路径白名单：仅允许 userData/images 目录内（防导入方案携带任意路径 → 任意文件读取/NTLM） */
function isInsideImagesDir(p) {
  if (typeof p !== 'string' || !p) return false;
  const base = path.resolve(app.getPath('userData'), 'images');
  const rp = path.resolve(p);
  if (rp !== base && !rp.startsWith(base + path.sep)) return false;
  // 解析真实路径再比较，防目录内 junction/symlink 指向外部（文件存在时）
  try {
    const rbase = fs.realpathSync(base);
    const rp2 = fs.realpathSync(rp);
    return rp2 === rbase || rp2.startsWith(rbase + path.sep);
  } catch {
    return true; // 路径不存在时保留字符串白名单结果，后续操作自然失败
  }
}
/** forcePath 仅供 SMOKE 自动化测试使用；生产环境一律走保存/打开对话框 */
const allowForcePath = () => !!process.env.SMOKE;

/* ---------------- 方案导出 / 导入（.toybox.json，含 base64 图片） ---------------- */
ipcMain.handle('scheme:export', async (_e, id, forcePath) => {
  const rec = readSchemes().find((s) => s.id === id);
  if (!rec) throw new Error('方案不存在（可能已被删除）');
  const images = [];
  for (const p of rec.images || []) {
    if (!p || !isInsideImagesDir(p) || !fs.existsSync(p)) {
      images.push(null);
      continue;
    }
    const buf = fs.readFileSync(p);
    const det = detectImageFormat(buf);
    if (!det) { images.push(null); continue; }
    images.push(`data:${det.mime};base64,${buf.toString('base64')}`);
  }
  const payload = {
    app: 'toy-box-designer',
    format: 1,
    exportedAt: Date.now(),
    scheme: { ...rec, images },
  };
  let filePath = (allowForcePath() && forcePath) || null;
  if (!filePath) {
    const d = new Date(rec.ts);
    const name = `${rec.boxType || 'scheme'}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.toybox.json`;
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出方案（可发给同事导入）',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: '玩具包装方案', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { saved: false };
    filePath = r.filePath;
  }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 1));
  return { saved: true, filePath };
});

ipcMain.handle('scheme:import', async (_e, forcePath) => {
  let filePath = (allowForcePath() && forcePath) || null;
  if (!filePath) {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入方案',
      filters: [{ name: '玩具包装方案', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { imported: false };
    filePath = r.filePaths[0];
  }
  const st = fs.statSync(filePath);
  if (st.size > 50 * 1024 * 1024) throw new Error('方案文件过大（>50MB）');
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.length > 60 * 1024 * 1024) throw new Error('方案文件过大');
  const payload = JSON.parse(raw);
  if (!payload || payload.app !== 'toy-box-designer' || !payload.scheme) {
    throw new Error('不是有效的玩具包装方案文件');
  }
  const s = payload.scheme;
  // 图片 base64 → 落盘到 images/；非 dataURL 一律丢弃（防恶意方案携带任意本地路径）
  const imgDir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const images = [];
  let totalBytes = 0;
  for (const d of (s.images || []).slice(0, 20)) { // 图片张数上限 20
    const m = typeof d === 'string' && d.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) {
      images.push('');
      continue;
    }
    if (m[2].length * 0.75 > 15 * 1024 * 1024) { images.push(''); continue; } // 按 base64 长度预判，先于解码
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 15 * 1024 * 1024) { images.push(''); continue; } // 单图上限 15MB，防恶意大文件填盘
    totalBytes += buf.length;
    if (totalBytes > 50 * 1024 * 1024) { images.push(''); continue; } // 总量上限 50MB
    const det = detectImageFormat(buf);
    if (!det) { images.push(''); continue; } // 仅支持 PNG/JPEG：WebP/伪造内容跳过该图，不中断导入、不落盘
    const p = path.join(imgDir, `import_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${images.length}.${det.ext}`);
    fs.writeFileSync(p, buf);
    images.push(p);
  }
  const list = readSchemes();
  const rec = {
    id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    kind: s.kind || 'import',
    prompt: s.prompt || '',
    model: s.model || '',
    size: s.size || '',
    seed: s.seed || '',
    boxType: s.boxType || '',
    boxSize: s.boxSize || null,
    images,
    ...cleanCompInfo(s), // 合规排版信息随方案导入（兼容旧方案：缺省为关闭态）
  };
  list.unshift(rec);
  if (list.length > 100) list.length = 100;
  fs.mkdirSync(schemesDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(list, null, 1));
  return { imported: true, scheme: rec, file: filePath };
});

/* ---------------- AI 视觉质检（doubao-vision，检查生成图） ---------------- */
const VISION_QC_PROMPT =
  '你是包装印刷质检员。检查这张玩具包装主视觉插画图，回答三件事：' +
  '1) 图中是否出现任何文字、字母、数字或类似文字的符号（包装主视觉不应有文字）；' +
  '2) 是否有水印或 logo；' +
  '3) 主体（玩具/角色）是否畸形残缺（如多余手指、五官错乱、断裂）。' +
  '只输出 JSON，格式：{"hasText": 布尔, "hasWatermark": 布尔, "hasDeformity": 布尔, "notes": "一句话说明"}';

ipcMain.handle('vision:check', async (_e, { dataUrl, visionModel, visionBaseUrl, visionApiKey }) => {
  // key：必须填视觉质检专用 Key（不复用主 API Key——两者平台/计费相互独立）
  const key = (visionApiKey || '').trim();
  if (!key) throw new Error('尚未配置视觉质检 API Key，请在设置中填写（可用任意 OpenAI 兼容视觉模型的 Key）');
  // dataUrl：仅接受常见图片格式的 base64（防异常类型发给模型服务商）
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/.test(dataUrl)) {
    throw new Error('视觉质检仅接受 image/png、image/jpeg、image/webp 的 base64 图片');
  }
  if (dataUrl.length * 0.75 > 10 * 1024 * 1024) throw new Error('视觉质检图片过大（>10MB）');
  // base：默认小米 MiMo（OpenAI 兼容）
  const base = (visionBaseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const resp = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: visionModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: VISION_QC_PROMPT },
        ],
      }],
      max_tokens: 1000, // mimo-v2.5 为深度思考模型，reasoning 占输出，调大避免 content 为空
    }),
  }, 90000, '视觉质检');
  // 复用 readBodyLimited 限流读取（防异常服务端大响应撑爆主进程内存）
  let json = {};
  try {
    const raw = await readBodyLimited(resp, 8 * 1024 * 1024);
    json = JSON.parse(raw.toString('utf8'));
  } catch (e) { /* 解析失败按空处理 */ }
  if (!resp.ok || !json.choices || !json.choices.length) {
    const msg = json.error && json.error.message ? json.error.message : JSON.stringify(json);
    throw new Error(`视觉质检调用失败（HTTP ${resp.status}）：${msg}`);
  }
  const content = json.choices[0].message.content || '';
  // 提取 JSON（部分模型会包在 markdown 围栏里）
  const m = content.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (m) {
    try { parsed = JSON.parse(m[0]); } catch (e) { /* 解析失败返回原文 */ }
  }
  return { raw: content, parsed };
});

/* ---------------- api:test：设置页「测试连接」（探测 OpenAI 兼容 /models 端点） ---------------- */
ipcMain.handle('api:test', async (_e, { baseUrl, apiKey }) => {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const key = String(apiKey || '').trim();
  if (!base || !key) return { ok: false, error: '请先填写接口地址和 API Key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await safeFetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    }, 10000);
    if (r.ok) {
      const j = JSON.parse((await readBodyLimited(r, 1024 * 1024)).toString('utf8')) || null;
      const arr = j && Array.isArray(j.data) ? j.data : null;
      return {
        ok: true,
        status: r.status,
        modelCount: arr ? arr.length : null,
        sample: arr && arr.length ? String(arr[0].id || arr[0].name || '') : null,
      };
    }
    const body = (await readBodyLimited(r, 1024 * 1024)).toString('utf8').slice(0, 160)
      .replace(/(authorization|bearer\s+[a-z0-9._-]+)/gi, '[已过滤]'); // 防服务端回显凭据
    return { ok: false, status: r.status, error: `HTTP ${r.status}${body ? '：' + body : ''}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '连接超时（10 秒）' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
});

/* ---------------- 缓存管理 IPC ---------------- */
ipcMain.handle('cache:info', () => cacheInfo());
ipcMain.handle('cache:clean', (_e, olderThanDays) => cleanCache(olderThanDays));

/* ---------------- 缓存管理：统计与清理（userData/images 下的生成图片文件） ---------------- */
function cacheDir() {
  return path.join(app.getPath('userData'), 'images');
}

/** 统计缓存：文件数、总字节、最老文件天数 */
function cacheInfo() {
  const dir = cacheDir();
  let fileCount = 0, bytes = 0, oldestMs = Infinity;
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (!st.isFile()) continue;
        fileCount += 1;
        bytes += st.size;
        if (st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      }
    }
  } catch (e) { /* 目录不存在/不可读按空处理 */ }
  const oldestDays = Number.isFinite(oldestMs) ? Math.max(0, Math.floor((Date.now() - oldestMs) / 86400000)) : 0;
  return { fileCount, bytes, oldestDays };
}

/** 被历史方案引用的图片集合（清缓存时保护，防方案图片失效） */
function referencedSchemeImages() {
  const set = new Set();
  try {
    const list = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    for (const rec of list) {
      for (const p of rec.images || []) {
        if (typeof p === 'string' && p) set.add(path.resolve(p));
      }
    }
  } catch (e) { /* manifest 缺失/损坏时无保护项 */ }
  return set;
}

/** 清理缓存：olderThanDays=0 清空全部；>0 仅删 mtime 早于该天数的文件；返回删除的文件数 */
function cleanCache(olderThanDays) {
  const days = Math.max(0, Number(olderThanDays) || 0);
  const dir = cacheDir();
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  if (!fs.existsSync(dir)) return { removed };
  const protectedSet = referencedSchemeImages(); // 方案引用的图片一律保留（含生成图与导入图），方案完整性优先
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (protectedSet.has(path.resolve(full))) continue;
    try {
      const st = fs.statSync(full);
      if (st.isFile() && (days === 0 || st.mtimeMs < cutoff)) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (e) { /* 单个文件失败跳过 */ }
  }
  return { removed };
}

/* ---------------- 启动 ---------------- */
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
