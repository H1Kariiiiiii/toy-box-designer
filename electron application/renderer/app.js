/**
 * 渲染进程逻辑：需求表单 → 组装提示词 → 调 Seedream 出图 → 贴进盒型展开图 → 导出 PNG
 * v0.2 新能力：Seedream 5.0 模型档位 / Seed 复现 / 图生图参考图 / 条码叠加 / 合规清单 / 出血导出
 */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  templates: null,
  currentType: null,
  currentImage: null, // dataURL（当前应用到展开图的图）
  generatedImages: [], // 本次生成的所有图 { dataUrl, localPath }
  activeIndex: 0,
  refImage: null,     // 图生图参考图 dataURL
  lastSeed: null,
  barcode: null,      // { format, value }
  theme: 'light',     // 界面主题：light（默认浅色）| dark | system（跟随系统）
  markets: new Set(), // 目标市场（cn/eu/us）
  compDone: new Set(),// 已勾选的合规项
  compAuto: false,    // 自动排版合规信息到展开图
  compFields: { name: '', sku: '', material: '', standard: 'GB 6675', maker: '', warning: '', origin: '' },
  layout: { template: 'farm', brand: '', product: '', series: '', sellTitle: '', sellSub: '', gridItems: [], decoOn: true, blocks: {} }, // 版面套版（中改）；blocks=拖拽位置覆盖（大改）
  process: 'none', // 工艺预览：none|matte|gloss|uv|gold|silver（仅预览模拟，不入导出/存档）
  boxWin: { wPct: 55, hPct: 60, xPct: 22.5, yPct: 8, shape: 'rect' }, // 开窗窗口（% 占正面面板；shape: rect|round|ellipse|circle）
  badges: { age0to3: false, recycle: false, trash: false, gc: false }, // 底部标志（合规块右侧；CE/CCC 按市场自动）
  winDrawMode: false, // 窗口画板绘制模式（画板拖框定窗口）
  batchMode: false,   // 当前结果区是否处于批量方案模式
  schemes: [],        // 当前批量方案 [{ seed, images }]
  schemeArchive: [],  // 历史方案库（manifest）
  lastAutoPrompt: '',
};

/** 组图第 N 张的视图描述 */
const SHOT_NAMES = ['正面主视觉', '背面', '侧面', '顶部俯视', '平面展开图', '细节特写'];

/* ================= 多配置档（文生图 + 视觉质检各自独立 Key） ================= */
let appProfiles = [];
let appActiveIdx = 0;

/** 旧配置（无 profiles）迁移为单档 */
function normalizeProfiles(cfg) {
  if (Array.isArray(cfg.profiles) && cfg.profiles.length) {
    appProfiles = cfg.profiles.map((p) => ({
      name: p.name,
      apiKey: p.apiKey || '',
      imageBaseUrl: p.imageBaseUrl || '',
      model: p.model || '',
      visionModel: p.visionModel || 'mimo-v2.5',
      visionBaseUrl: p.visionBaseUrl || '',
      visionApiKey: p.visionApiKey || '',
      // 旧版 noWatermark 布尔迁移：一律视为「关闭」（与旧火山写死 watermark:false 行为一致）
      watermark: p.watermark || 'off',
    }));
    appActiveIdx = Math.min(Math.max(0, cfg.activeIndex || 0), appProfiles.length - 1);
  } else {
    appProfiles = [{
      name: '默认档',
      apiKey: cfg.apiKey || '',
      imageBaseUrl: cfg.imageBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
      model: cfg.model || '',
      visionModel: cfg.visionModel || 'mimo-v2.5',
      visionBaseUrl: cfg.visionBaseUrl || 'https://api.xiaomimimo.com/v1',
      visionApiKey: cfg.visionApiKey || '',
      watermark: 'off',
    }];
    appActiveIdx = 0;
  }
}

function renderProfileSelect() {
  const sel = $('cfg-profile');
  sel.innerHTML = '';
  appProfiles.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = (i === appActiveIdx ? '⭐ ' : '') + (p.name || ('档位 ' + (i + 1)));
    sel.appendChild(o);
  });
  sel.value = appActiveIdx;
  $('cfg-profileName').value = appProfiles[appActiveIdx].name || '';
}

function profileToForm(idx) {
  const p = appProfiles[idx];
  $('cfg-apiKey').value = p.apiKey || '';
  $('cfg-imageBaseUrl').value = p.imageBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3';
  $('cfg-model').value = p.model || '';
  $('cfg-visionModel').value = p.visionModel || 'mimo-v2.5';
  $('cfg-visionBaseUrl').value = p.visionBaseUrl || 'https://api.xiaomimimo.com/v1';
  $('cfg-visionApiKey').value = p.visionApiKey || '';
  $('cfg-watermark').value = ['off', 'default', 'on'].includes(p.watermark) ? p.watermark : 'off';
  updateQuickStatus();
}

function formToProfile(idx) {
  const p = appProfiles[idx];
  p.name = $('cfg-profileName').value.trim() || ('档位 ' + (idx + 1));
  p.apiKey = $('cfg-apiKey').value.trim();
  p.imageBaseUrl = $('cfg-imageBaseUrl').value.trim();
  p.model = $('cfg-model').value.trim();
  p.visionModel = $('cfg-visionModel').value.trim();
  p.visionBaseUrl = $('cfg-visionBaseUrl').value.trim();
  p.visionApiKey = $('cfg-visionApiKey').value.trim();
  p.watermark = $('cfg-watermark').value;
  return p;
}

function bindProfileEvents() {
  const persist = () => window.api.setConfig({ profiles: appProfiles, activeIndex: appActiveIdx });
  $('cfg-profile').addEventListener('change', async (e) => {
    formToProfile(appActiveIdx); // 保存当前编辑到旧档
    appActiveIdx = Number(e.target.value);
    renderProfileSelect();
    profileToForm(appActiveIdx);
    await persist(); // 切换即落盘
    const s = $('gen-status');
    s.textContent = `✅ 已切换到配置档「${appProfiles[appActiveIdx].name}」，下面表单显示的是该档内容，可直接编辑`;
    s.className = 'status ok';
  });
  $('btn-profile-new').addEventListener('click', async () => {
    formToProfile(appActiveIdx);
    // 新档序号从 1 递增，自动跳过已占用名称（第一个新建档叫「新档 1」，不重名）
    let seq = 1;
    const names = new Set(appProfiles.map((p) => p.name));
    while (names.has('新档 ' + seq)) seq++;
    appProfiles.push({
      name: '新档 ' + seq,
      apiKey: '',
      imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: '',
      visionModel: 'mimo-v2.5',
      visionBaseUrl: 'https://api.xiaomimimo.com/v1',
      visionApiKey: '',
      watermark: 'off',
    });
    appActiveIdx = appProfiles.length - 1;
    renderProfileSelect();
    profileToForm(appActiveIdx);
    await persist();
    const s = $('gen-status');
    s.textContent = '✅ 已新建配置档（空 Key），填好后点「保存设置」';
    s.className = 'status ok';
  });
  let delArmed = false; // 删除两段确认（避免原生 confirm 对话框导致输入法/焦点卡死）
  $('btn-profile-del').addEventListener('click', async () => {
    if (appProfiles.length <= 1) {
      const s = $('gen-status');
      s.textContent = '⚠ 至少保留一个配置档';
      s.className = 'status err';
      return;
    }
    if (!delArmed) {
      delArmed = true;
      $('btn-profile-del').textContent = '⚠ 再点一次确认删除';
      setTimeout(() => {
        delArmed = false;
        $('btn-profile-del').textContent = '🗑 删除档';
      }, 3000);
      return;
    }
    delArmed = false;
    $('btn-profile-del').textContent = '🗑 删除档';
    const name = appProfiles[appActiveIdx].name || '当前档';
    appProfiles.splice(appActiveIdx, 1);
    appActiveIdx = Math.max(0, appActiveIdx - 1);
    renderProfileSelect();
    profileToForm(appActiveIdx);
    await persist();
    const s = $('gen-status');
    s.textContent = `🗑 已删除「${name}」，当前为「${appProfiles[appActiveIdx].name}」`;
    s.className = 'status ok';
  });
}

/* ================= 初始化 ================= */
async function init() {  const cfg = await window.api.getConfig();
  normalizeProfiles(cfg);
  renderProfileSelect();
  profileToForm(appActiveIdx);
  bindProfileEvents();
  // 主题：从配置恢复（默认浅色），随后绑定切换与系统跟随
  state.theme = ['light', 'dark', 'system'].includes(cfg.theme) ? cfg.theme : 'light';
  applyTheme();
  bindTheme();

  // 图片尺寸：新配置用 比例+清晰度 选择器；旧配置（size 像素/档位）自动推断恢复
  const sizeMap = { '1K': '1024x1024', '2K': '2048x2048', '4K': '4096x4096' };
  const oldSize = sizeMap[cfg.size] || cfg.size || '2048x2048';
  let ratio = cfg.ratio, quality = cfg.quality;
  if (!ratio || !quality) {
    const inferred = inferRatioQuality(oldSize);
    ratio = inferred.ratio; quality = inferred.quality;
  }
  $('cfg-ratio').value = ratio;
  $('cfg-quality').value = quality;
  if (ratio !== 'custom' && quality !== 'custom') $('cfg-size').value = calcSize(ratio, quality);
  else if (/^\d+x\d+$/.test(oldSize)) $('cfg-size').value = oldSize;
  else $('cfg-size').value = '2048x2048';
  updateSizePreview();
  ['cfg-ratio', 'cfg-quality', 'cfg-size'].forEach((id) => $(id).addEventListener('change', updateSizePreview));
  $('cfg-size').addEventListener('input', updateSizePreview);

  state.templates = window.BoxTemplates;

  // 测试连接 / 设为使用中
  $('btn-testApi').addEventListener('click', testApi);
  $('btn-setActive').addEventListener('click', setActive);

  // 缓存管理
  $('btn-cache-clean7').addEventListener('click', () => cleanCache(7));
  $('btn-cache-cleanAll').addEventListener('click', () => cleanCache(0));
  refreshCacheInfo();

  // 结果区大图前后切换（← → 按钮 + 键盘左右键）
  $('btn-result-prev').addEventListener('click', () => switchResult(-1));
  $('btn-result-next').addEventListener('click', () => switchResult(1));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && !e.target.closest('input, textarea, select')) switchResult(-1);
    else if (e.key === 'ArrowRight' && !e.target.closest('input, textarea, select')) switchResult(1);
  });
  const ids = Object.keys(state.templates);
  renderBoxList(ids); // 盒型页
  renderBoxList(ids, 'boxTypeMini'); // 设计页快速切换
  selectBoxType(ids[0]);

  // 页签导航
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => showPage(t.dataset.page));
  });
  $('btn-goto-box').addEventListener('click', () => showPage('box'));

  ['req-theme', 'req-age', 'req-style', 'req-extra'].forEach((id) => {
    $(id).addEventListener('input', autoBuildPrompt);
  });
  $('btn-generate').addEventListener('click', generate);
  $('btn-reroll').addEventListener('click', () => generate(true));
  $('btn-batch').addEventListener('click', batchGenerate);
  $('btn-export').addEventListener('click', exportPng);
  $('btn-pdfx').addEventListener('click', exportPdfX);
  $('btn-saveConfig').addEventListener('click', saveConfig);
  ['size-w', 'size-d', 'size-h'].forEach((id) => {
    $(id).addEventListener('input', () => { renderLayout(); updateQuickStatus(); updateBoxSizeText(); });
  });
  $('req-refimage').addEventListener('change', onRefImage);
  $('req-count').addEventListener('change', () => { autoBuildPrompt(); updateCountHint(); });
  $('cfg-model').addEventListener('input', updateCountHint);
  $('opt-bleed').addEventListener('change', renderLayout);
  bindBarcodeDrag();
  bindLayoutDrag();
  bindWindowDrag();
  const resetBtn = $('btn-layout-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => { state.layout.blocks = {}; renderLayout(); }); // 预览区条码直接拖拽/缩放
  $('barcode-enabled').addEventListener('change', updateBarcode);
  ['barcode-format', 'barcode-value'].forEach((id) => {
    $(id).addEventListener('input', updateBarcode);
  });
  ['barcode-w', 'barcode-h', 'barcode-x', 'barcode-y'].forEach((id) => {
    $(id).addEventListener('input', updateBarcode);
  });
  $('comp-auto').addEventListener('change', () => { state.compAuto = $('comp-auto').checked; renderLayout(); });
  ['comp-name', 'comp-sku', 'comp-material', 'comp-standard', 'comp-maker', 'comp-warning', 'comp-origin'].forEach((id) => {
    $(id).addEventListener('input', () => { state.compFields[id.replace('comp-', '')] = $(id).value.trim(); renderLayout(); });
  });
  $('btn-import-scheme').addEventListener('click', importSchemeFile);
  $('btn-qc-run').addEventListener('click', () => { renderQc(runQualityCheck()); });
  $('btn-qc-vision').addEventListener('click', runVisionCheck);

  renderCompliance();
  autoBuildPrompt();
  checkGs();
  loadSchemes();
  updateQuickStatus();
  // ===== 版面套版输入监听（中改：填内容即套版）=====
  const layoutInputs = [
    ['layout-template', 'template'],
    ['layout-brand', 'brand'],
    ['layout-product', 'product'],
    ['layout-series', 'series'],
    ['layout-sell-title', 'sellTitle'],
    ['layout-sell-sub', 'sellSub'],
  ];
  layoutInputs.forEach((pair) => {
    const el = $(pair[0]);
    if (el) el.addEventListener('input', () => { state.layout[pair[1]] = el.value.trim(); renderLayout(); });
  });
  const layoutGridEl = $('layout-grid');
  if (layoutGridEl) layoutGridEl.addEventListener('input', () => {
    state.layout.gridItems = layoutGridEl.value.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => {
      const parts = s.split(',');
      return { no: (parts[0] || '').trim(), name: parts.slice(1).join(',').trim() };
    });
    renderLayout();
  });
  const winDrawBtn = $('btn-win-draw');
  if (winDrawBtn) winDrawBtn.addEventListener('click', () => {
    state.winDrawMode = !state.winDrawMode;
    winDrawBtn.classList.toggle('active', state.winDrawMode);
    const areaEl = $('preview-area');
    if (areaEl) areaEl.style.cursor = state.winDrawMode ? 'crosshair' : '';
  });
  const winShapeEl = $('boxwin-shape');
  if (winShapeEl) winShapeEl.addEventListener('change', () => { state.boxWin.shape = winShapeEl.value; renderLayout(); });
  ['boxwin-w', 'boxwin-h', 'boxwin-x', 'boxwin-y'].forEach((wid) => {
    const wel = $(wid);
    if (wel) wel.addEventListener('input', () => {
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
      state.boxWin = { wPct: num($('boxwin-w').value), hPct: num($('boxwin-h').value), xPct: num($('boxwin-x').value), yPct: num($('boxwin-y').value) };
      renderLayout();
    });
  });
  ['badge-age0to3', 'badge-recycle', 'badge-trash', 'badge-gc'].forEach((bid) => {
    const bel = $(bid);
    if (bel) bel.addEventListener('change', () => { state.badges[bid.replace('badge-', '')] = bel.checked; renderLayout(); });
  });
  const warnTplEl = $('warning-template');
  if (warnTplEl) warnTplEl.addEventListener('change', () => {
    const txt = composeWarning(warnTplEl.value);
    if (txt) {
      const w = $('comp-warning');
      if (w) w.value = txt;
      state.compFields.warning = txt;
      renderLayout();
    }
    warnTplEl.value = '';
  });
  const processEl = $('process-select');
  if (processEl) processEl.addEventListener('change', () => { state.process = processEl.value; renderLayout(); });
  const layoutDecoEl = $('layout-deco');
  if (layoutDecoEl) layoutDecoEl.addEventListener('change', () => { state.layout.decoOn = layoutDecoEl.checked; renderLayout(); });
  renderQuickThemes();
  // 3D mockup 懒初始化：进入「预览」页签时才创建 renderer（隐藏元素内创建会得到 0 尺寸 canvas）
}

/* ================= 3D mockup ================= */
let mockupTimer = null;
function initMockupModule() {
  // mockup 已用 esbuild 打包为经典 script（window.MockupModule），无异步加载
  if (window.MockupModule && !window.__mockup) {
    window.__mockup = {
      initMockup: window.MockupModule.initMockup,
      renderMockup: window.MockupModule.renderMockup,
    };
    window.MockupModule.initMockup();
    scheduleMockup();
  }
}

/** 防抖：展开图/盒型/尺寸/图变化后重建 3D 盒子 */
function scheduleMockup() {
  clearTimeout(mockupTimer);
  mockupTimer = setTimeout(() => {
    if (window.__mockup && state.currentType && state.templates) {
      window.__mockup.renderMockup(state.templates[state.currentType], getSize());
    }
  }, 250);
}

/* ================= Ghostscript 状态（PDF/X 依赖） ================= */
async function checkGs() {
  const el = $('gs-status');
  try {
    const st = await window.api.gsStatus();
    window.__gsAvailable = !!(st.available && st.icc);
    updateQuickStatus();
    if (st.available && st.icc) {
      el.textContent = '✓ PDF/X 引擎就绪';
      el.className = 'gs-status ok';
      $('btn-pdfx').disabled = false;
    } else {
      el.textContent = st.available ? '✗ 缺 CMYK ICC 配置' : '✗ 缺 Ghostscript 引擎';
      el.className = 'gs-status err';
    }
  } catch (e) {
    window.__gsAvailable = false;
    el.textContent = '✗ PDF/X 引擎检查失败';
    el.className = 'gs-status err';
  }
}

/* ================= 页签切换 ================= */
function showPage(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.page === name);
  });
  document.querySelectorAll('.page').forEach((p) => {
    p.classList.toggle('active', p.id === 'page-' + name);
  });
  // 切回设计/预览页时同步当前盒型/展开图/3D 状态；3D 仅在预览页（可见时）初始化
  if (name === 'preview') initMockupModule();
  if (name === 'design' || name === 'preview') {
    renderLayout();
    scheduleMockup();
  }
}

/* ================= 盒型选择 ================= */
function renderBoxList(ids, targetId = 'boxTypeList') {
  const wrap = $(targetId);
  if (!wrap) return;
  wrap.innerHTML = '';
  ids.forEach((id) => {
    const t = state.templates[id];
    const card = document.createElement('div');
    card.className = 'box-card';
    card.dataset.id = id;
    card.innerHTML = `<div class="bc-name">${escXml(t.name)}</div><div class="bc-desc">${escXml(t.desc)}</div>`;
    card.addEventListener('click', () => selectBoxType(id));
    wrap.appendChild(card);
  });
}

function selectBoxType(id) {
  state.currentType = id;
  document.querySelectorAll('.box-card').forEach((c) => {
    c.classList.toggle('active', c.dataset.id === id);
  });
  const t = state.templates[id];
  $('size-w').value = t.defaultSize.w;
  $('size-d').value = t.defaultSize.d;
  $('size-h').value = t.defaultSize.h;
  $('preview-name').textContent = t.name;
  const winSet = $('boxwin-settings');
  if (winSet) winSet.hidden = id !== 'kaiChuangHe'; // 窗口可调仅开窗盒
  const winDrawBtn2 = $('btn-win-draw');
  if (winDrawBtn2) winDrawBtn2.style.display = id === 'kaiChuangHe' ? '' : 'none';
  updateBoxSizeText();
  updateQuickStatus();
  renderLayout();
}

/** 预览页「当前盒型」尺寸说明文字（盒型页改尺寸时同步刷新） */
function updateBoxSizeText() {
  const t = state.templates[state.currentType];
  const st = $('box-size-text');
  if (st && t) {
    const s = getSize();
    st.textContent = `当前：${t.name}（${s.w} × ${s.d} × ${s.h} mm）— 长 × 宽 × 高，可到「盒型」页调整`;
  }
}

function getSize() {
  // 上/下限 clamp：超大尺寸会让 300dpi 导出生成超 canvas 上限（16384px）的画布（3000mm → 10 万级像素必炸）
  const clamp = (v, lo, hi, def) => {
    const n = Number(v);
    return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : def));
  };
  return {
    w: clamp($('size-w').value, 20, 500, 200),
    d: clamp($('size-d').value, 20, 500, 130),
    h: clamp($('size-h').value, 10, 500, 60),
    win: state.boxWin, // 开窗窗口参数（仅开窗盒使用；其他盒型忽略）
  };
}

/** 设计页「当前配置」卡实时刷新 */
function updateQuickStatus() {
  const t = (state.templates && state.currentType) ? state.templates[state.currentType] : null;
  const el = (id) => document.getElementById(id);
  if (el('qs-box') && t) el('qs-box').textContent = t.name;
  if (el('qs-size')) {
    const s = getSize();
    el('qs-size').textContent = `${s.w} × ${s.d} × ${s.h} mm`;
  }
  if (el('qs-img')) {
    const ratio = document.getElementById('cfg-ratio').value;
    const quality = document.getElementById('cfg-quality').value;
    el('qs-img').textContent = (ratio === 'custom' || quality === 'custom')
      ? (document.getElementById('cfg-size').value || '2048x2048')
      : calcSize(ratio, quality);
  }
  if (el('qs-model')) el('qs-model').textContent = document.getElementById('cfg-model').value || '未设置';
  if (el('qs-gs')) {
    const ok = window.__gsAvailable;
    el('qs-gs').textContent = ok ? '✅ PDF/X 就绪' : (ok === false ? '❌ 不可用' : '检测中…');
  }
}

/* ================= 快捷主题 ================= */
const QUICK_THEMES = ['恐龙积木', '遥控赛车', '拼图', '过家家套装', '毛绒玩具', '积木城堡', '泡泡机', '遥控船'];
function renderQuickThemes() {
  const wrap = document.getElementById('quick-themes');
  if (!wrap) return;
  wrap.innerHTML = '';
  QUICK_THEMES.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'qt-chip';
    chip.textContent = t;
    chip.title = '点击填入产品主题';
    chip.onclick = () => {
      $('req-theme').value = t;
      autoBuildPrompt();
      const s = $('gen-status');
      s.textContent = `✅ 已填入主题「${t}」，可直接生成`;
      s.className = 'status ok';
    };
    wrap.appendChild(chip);
  });
}

/* ================= 提示词 ================= */
function autoBuildPrompt() {
  const theme = $('req-theme').value.trim();
  const age = $('req-age').value;
  const style = $('req-style').value.trim();
  const extra = $('req-extra').value.trim();
  const n = Number($('req-count').value) || 1;
  const subject = theme ? `${theme}玩具包装盒` : '玩具包装盒';
  let prompt =
    `${subject}主视觉插画，${style || '可爱卡通'}风格，适合${age}儿童，` +
    `高饱和明快色彩，主体居中，四周留出安全边距，干净背景，高清细节，` +
    `无任何文字，无logo，无水印，无边框${extra ? '，' + extra : ''}`;
  if (state.refImage) {
    prompt += '，以参考图中的产品为主体，为其重新绘制包装主视觉插画';
  }
  if (n > 1) {
    const shots = [];
    for (let i = 0; i < n; i++) {
      shots.push(`第${i + 1}张 ${SHOT_NAMES[i] || `视图${i + 1}`}`);
    }
    prompt += `。请生成 ${n} 张连贯成套的包装设计图：${shots.join('，')}。各张风格、配色、主体保持一致`;
  }
  $('req-prompt').value = prompt;
  state.lastAutoPrompt = prompt;
}

/** 组图与模型兼容性提示：5.0 pro 不支持组图 */
function updateCountHint() {
  const n = Number($('req-count').value) || 1;
  const model = $('cfg-model').value.trim();
  const isPro = /5-0-pro/.test(model);
  $('count-hint').classList.toggle('hidden', !(n > 1 && isPro));
}

/* ================= 参考图（图生图） ================= */
function onRefImage(e) {
  const f = e.target.files[0];
  const prev = $('refimage-preview');
  if (!f) {
    state.refImage = null;
    prev.classList.add('hidden');
    autoBuildPrompt();
    return;
  }
  if (!f.type || !f.type.startsWith('image/')) {
    state.refImage = null;
    prev.classList.add('hidden');
    const s = $('gen-status');
    s.textContent = '❌ 参考图仅支持图片文件（jpg/png/webp 等）';
    s.className = 'status err';
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.refImage = reader.result;
    // 属性赋值代替 innerHTML 拼接（FileReader 结果虽为安全 base64，双保险）
    prev.innerHTML = '';
    const img = document.createElement('img');
    img.src = reader.result;
    img.title = '参考图：将以它为主体图生图';
    prev.appendChild(img);
    prev.classList.remove('hidden');
    autoBuildPrompt();
  };
  reader.readAsDataURL(f);
}

/* ================= 生成 ================= */
/** 生成/视觉质检并发锁：防止等待期间重复点击导致多个请求并行、返回结果互相覆盖 */
let generating = false;
const GEN_BTNS = ['btn-generate', 'btn-batch', 'btn-reroll', 'btn-qc-vision'];
function lockGen() {
  if (generating) return false;
  generating = true;
  GEN_BTNS.forEach((id) => { const b = $(id); if (b) b.disabled = true; });
  return true;
}
function unlockGen() {
  generating = false;
  GEN_BTNS.forEach((id) => { const b = $(id); if (b) b.disabled = false; });
}

/* ===== 生成过程可视化：进度条 + 阶段文案 + 实时计时（避免干等待） ===== */
let genTimerId = null;
let genPhaseText = '';
/** 展示进度：phase 为阶段文案；ratio 为 0~1 确定进度，负数走不确定动画（单张生成无法预知耗时） */
function genProgress(phase, ratio) {
  genPhaseText = phase;
  const bar = $('gen-progress-bar');
  const wrap = $('gen-progress');
  if (!bar || !wrap) return;
  wrap.hidden = false;
  bar.classList.toggle('indeterminate', ratio < 0);
  if (ratio >= 0) bar.style.width = `${Math.max(2, Math.min(100, ratio * 100))}%`;
  const s = $('gen-status');
  if (s) { s.textContent = phase; s.className = 'status'; }
  // 结果区中央覆盖层（旋转圆圈 + 进度条 + 文案）同步
  const ov = $('gen-overlay');
  if (ov) {
    ov.hidden = false;
    const ob = $('gen-overlay-bar'); // 即 .gen-overlay-bar 内的进度条本体
    if (ob) {
      ob.classList.toggle('indeterminate', ratio < 0);
      if (ratio >= 0) ob.style.width = `${Math.max(2, Math.min(100, ratio * 100))}%`;
    }
    const ot = $('gen-overlay-text');
    if (ot) ot.textContent = phase;
  }
}
/** 启动 1 秒一跳的计时器，把「已等待 N 秒」拼到阶段文案后面 */
function genTimerStart() {
  const t0 = Date.now();
  genTimerStop();
  genTimerId = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    const text = `${genPhaseText}（已等待 ${sec} 秒）`;
    const s = $('gen-status');
    if (s && genPhaseText) s.textContent = text;
    const ot = $('gen-overlay-text');
    if (ot && genPhaseText) ot.textContent = text;
  }, 1000);
}
function genTimerStop() {
  if (genTimerId) { clearInterval(genTimerId); genTimerId = null; }
}
/** 结束：隐藏进度条与覆盖层、停计时（文案由调用方设置成功/失败结果） */
function genProgressDone() {
  genTimerStop();
  genPhaseText = '';
  const wrap = $('gen-progress');
  if (wrap) wrap.hidden = true;
  const bar = $('gen-progress-bar');
  if (bar) { bar.classList.remove('indeterminate'); bar.style.width = '0'; }
  const ov = $('gen-overlay');
  if (ov) {
    ov.hidden = true;
    const ob = $('gen-overlay-bar');
    if (ob) {
      ob.classList.remove('indeterminate');
      ob.style.width = '0';
    }
  }
}

/** 生成时水印约束：设置页「AI 水印」=关闭（off）时，追加到发送给模型的提示词末尾（API 参数之外的双保险，不改动输入框） */
function applyWatermarkGuard(prompt) {
  const guard = '画面干净，无任何水印、logo、文字、角标或装饰性符号';
  const p0 = appProfiles[appActiveIdx];
  if (!(p0 && p0.watermark === 'off')) return String(prompt || '').trim();
  const p = String(prompt || '').trim();
  return p ? p + '，' + guard : guard;
}

async function generate(reroll) {
  const status = $('gen-status');
  const prompt = applyWatermarkGuard($('req-prompt').value.trim());
  if (!prompt) { status.textContent = '请填写提示词'; status.className = 'status err'; return; }
  if (!lockGen()) {
    status.textContent = '⏳ 已有生成/质检任务进行中，请等待完成';
    status.className = 'status';
    return;
  }

  const model = $('cfg-model').value.trim();
  const size = getEffectiveSize();
  const apiKey = $('cfg-apiKey').value.trim();
  const maxImages = Math.min(6, Math.max(1, Number($('req-count').value) || 1));

  let seed = $('req-seed').value.trim() || '';
  // seed 校验：仅 1~2147483647 的整数（火山方舟 Seedream 允许范围），非法/0/超范围按空处理并提示
  if (seed !== '' && !(/^\d+$/.test(seed) && Number(seed) >= 1 && Number(seed) <= 2147483647)) {
    seed = '';
    $('req-seed').value = '';
    const sw = $('gen-status');
    sw.textContent = '⚠ seed（画面编号）需为 1~2147483647 的整数，本次已忽略';
    sw.className = 'status';
  }
  if (reroll && !seed && state.lastSeed !== null) {
    seed = String(state.lastSeed); // 同 seed 再来
    $('req-seed').value = seed;
  }
  if (seed !== '') state.lastSeed = Number(seed);

  status.textContent = maxImages > 1 ? `🕐 AI 组图生成中（${maxImages} 张 ${size} 约 30-90 秒）…` : `🕐 AI 生成中（${size} 约 15-40 秒）…`;
  status.className = 'status';
  genProgress(maxImages > 1 ? `🕐 AI 组图生成中（${maxImages} 张 ${size}）…` : `🕐 AI 生成中（${size}）…`, -1);
  genTimerStart();

  try {
    const res = await window.api.generateImage({
      prompt, model, size,
      imageBaseUrl: $('cfg-imageBaseUrl').value.trim(),
      seed: seed === '' ? undefined : seed,
      image: state.refImage || undefined,
      maxImages,
      apiKey,
      watermark: appProfiles[appActiveIdx].watermark || 'off',
    });
    state.generatedImages = res.images;
    state.activeIndex = 0;
    state.batchMode = false;
    state.currentImage = res.images[0].dataUrl;
    renderResults();
    renderLayout();
    $('btn-export').disabled = false;
    status.textContent = `✅ 已生成 ${res.images.length} 张，当前应用第 1 张（点缩略图切换）` + (seed !== '' ? `（seed=${seed}）` : '');
    status.className = 'status ok';
    saveScheme('single', res.images, seed === '' ? undefined : seed);
  } catch (err) {
    status.textContent = '❌ ' + err.message;
    status.className = 'status err';
  } finally {
    genProgressDone();
    unlockGen();
  }
}

/* ================= 批量出图 ================= */
/** 批量数量 clamp：与 SMOKE 测试共用同一实现（防镜像漂移） */
function clampBatchCount(v) {
  return Math.min(12, Math.max(1, Number(v) || 4)); // 上限 12，防止误配超大批量烧额度
}

async function batchGenerate() {
  const status = $('gen-status');
  const n = clampBatchCount($('batch-count').value);
  const prompt = applyWatermarkGuard($('req-prompt').value.trim());
  if (!prompt) { status.textContent = '请填写提示词'; status.className = 'status err'; return; }
  if (!lockGen()) {
    status.textContent = '⏳ 已有生成/质检任务进行中，请等待完成';
    status.className = 'status';
    return;
  }
  const model = $('cfg-model').value.trim();
  const size = getEffectiveSize();
  const apiKey = $('cfg-apiKey').value.trim();

  const baseSeed = Math.floor(Math.random() * 90000) + 10000;
  const schemes = [];
  genTimerStart();
  try {
    for (let i = 0; i < n; i++) {
      genProgress(`🕐 批量生成中 ${i + 1}/${n}（Seed ${baseSeed + i}，每个约 15-40 秒）…`, n > 1 ? i / n : -1);
      const res = await window.api.generateImage({ prompt, model, size, imageBaseUrl: $('cfg-imageBaseUrl').value.trim(), seed: baseSeed + i, apiKey, watermark: appProfiles[appActiveIdx].watermark || 'off' });
      schemes.push({ seed: baseSeed + i, images: res.images });
    }
    state.batchMode = true;
    state.schemes = schemes;
    state.generatedImages = schemes.map((s) => s.images[0]);
    state.activeIndex = 0;
    state.currentImage = state.generatedImages[0].dataUrl;
    renderResults();
    renderLayout();
    $('btn-export').disabled = false;
    status.textContent = `✅ 批量完成：${n} 个方案（Seed ${baseSeed}~${baseSeed + n - 1}），点缩略图切换方案`;
    status.className = 'status ok';
    for (const s of schemes) await saveScheme('batch', s.images, s.seed);
  } catch (err) {
    if (schemes.length) {
      // 部分成功：保留已生成的方案（额度已花，成果不能丢），提示部分完成
      state.batchMode = true;
      state.schemes = schemes;
      state.generatedImages = schemes.map((s) => s.images[0]);
      state.activeIndex = 0;
      state.currentImage = state.generatedImages[0].dataUrl;
      renderResults();
      renderLayout();
      $('btn-export').disabled = false;
      for (const s of schemes) await saveScheme('batch', s.images, s.seed);
      status.textContent = `⚠ 批量部分完成：${schemes.length}/${n} 个方案已保留（第 ${schemes.length + 1} 个失败：${err.message}）`;
      status.className = 'status';
      return;
    }
    status.textContent = '❌ ' + err.message;
    status.className = 'status err';
  } finally {
    genProgressDone();
    unlockGen();
  }
}

/* ================= 历史方案库 ================= */
async function saveScheme(kind, images, seed) {
  if (!images || !images.length) return;
  try {
    await window.api.saveScheme({
      kind,
      prompt: $('req-prompt').value.trim(),
      model: $('cfg-model').value.trim(),
      size: normSize($('cfg-size').value) || '2048x2048',
      seed: seed ?? '',
      boxType: state.currentType,
      boxSize: getSize(),
      images: images.map((i) => i.localPath),
      // 合规排版信息随方案存档：载入/导出/导入时完整恢复（品名/货号/材质/标准/制造商/警告/市场/条码/出血）
      compAuto: state.compAuto,
      compFields: state.compFields,
      markets: [...state.markets],
      barcode: state.barcode,
      bleed: $('opt-bleed').checked,
    });
    loadSchemes();
  } catch (e) {
    console.error('方案存档失败:', e);
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function loadSchemes() {
  try {
    state.schemeArchive = await window.api.listSchemes();
    renderSchemes();
  } catch (e) { /* 列表失败不打扰 */ }
}

async function renderSchemes() {
  const wrap = $('scheme-list');
  if (!state.schemeArchive || !state.schemeArchive.length) {
    wrap.innerHTML = '<div class="hint">生成后自动存档，点击可载入复用</div>';
    return;
  }
  wrap.innerHTML = '';
  for (const rec of state.schemeArchive.slice(0, 30)) {
    const item = document.createElement('div');
    item.className = 'scheme-item';
    const tName = (state.templates && state.templates[rec.boxType] && state.templates[rec.boxType].name) || rec.boxType || '';
    item.innerHTML = `<img alt="" /><div class="si-info"><div class="si-time">${fmtTime(rec.ts)} · ${rec.kind === 'batch' ? '批量' : '单图'} · ${escXml(tName)}</div><div class="si-desc">${escXml(rec.prompt || '')}</div></div><button class="si-exp" title="导出为 .toybox.json 文件">⤴</button><button class="si-save" title="用当前状态更新此方案（条码/合规/尺寸等）">💾</button><button class="si-del" title="删除">✕</button>`;
    const img = item.querySelector('img');
    if ((rec.images || []).filter(Boolean)[0]) {
      window.api.readImage(rec.images.filter(Boolean)[0]).then((d) => { img.src = d; }).catch(() => {});
    }
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('si-del')) return;
      loadScheme(rec);
    });
    item.querySelector('.si-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.deleteScheme(rec.id);
      loadSchemes();
    });
    item.querySelector('.si-save').addEventListener('click', async (e) => {
      e.stopPropagation();
      const status = $('gen-status');
      try {
        const r = await window.api.updateScheme(rec.id, {
          kind: rec.kind,
          prompt: $('req-prompt').value.trim(),
          model: $('cfg-model').value.trim(),
          size: normSize($('cfg-size').value) || '2048x2048',
          seed: $('req-seed').value.trim(),
          boxType: state.currentType,
          boxSize: getSize(),
          compAuto: state.compAuto,
          compFields: state.compFields,
          markets: [...state.markets],
          barcode: state.barcode,
          bleed: $('opt-bleed').checked,
          layout: state.layout,
          badges: state.badges,
        });
        if (r && r.ok) {
          status.textContent = '✅ 方案已更新（当前条码/合规/尺寸等状态已存入）';
          status.className = 'status ok';
          loadSchemes();
        } else {
          status.textContent = '❌ 更新失败：' + ((r && r.error) || '未知错误');
          status.className = 'status err';
        }
      } catch (err) {
        status.textContent = '❌ 更新失败：' + err.message;
        status.className = 'status err';
      }
    });
    item.querySelector('.si-exp').addEventListener('click', async (e) => {
      e.stopPropagation();
      const status = $('gen-status');
      try {
        const r = await window.api.exportScheme(rec.id);
        status.textContent = r.saved ? `✅ 方案已导出：${r.filePath}` : '已取消导出';
        status.className = r.saved ? 'status ok' : 'status';
      } catch (err) {
        status.textContent = '❌ 导出失败：' + err.message;
        status.className = 'status err';
      }
    });
    wrap.appendChild(item);
  }
}

async function loadScheme(rec) {
  const status = $('gen-status');
  status.textContent = '🕐 载入方案…';
  status.className = 'status';
  try {
    const paths = (rec.images || []).filter(Boolean); // 跳过空路径（安全净化后可能为 ''）
    const dataUrls = await Promise.all(paths.map((p) => window.api.readImage(p)));
    const images = dataUrls.map((dataUrl, i) => ({ dataUrl, localPath: paths[i] }));
    if (state.templates && state.templates[rec.boxType]) {
      selectBoxType(rec.boxType);
      if (rec.boxSize) {
        $('size-w').value = rec.boxSize.w;
        $('size-d').value = rec.boxSize.d;
        $('size-h').value = rec.boxSize.h;
        if (rec.boxSize.win) {
          state.boxWin = { wPct: 55, hPct: 60, xPct: 22.5, yPct: 8, shape: 'rect', ...rec.boxSize.win };
          const sw = (id, v) => { const el = $(id); if (el) el.value = v; };
          sw('boxwin-w', state.boxWin.wPct); sw('boxwin-h', state.boxWin.hPct);
          sw('boxwin-x', state.boxWin.xPct); sw('boxwin-y', state.boxWin.yPct);
          const sh = $('boxwin-shape'); if (sh) sh.value = state.boxWin.shape || 'rect';
        }
      }
    }
    if (rec.prompt) $('req-prompt').value = rec.prompt;
    if (rec.seed) $('req-seed').value = rec.seed;
    if (rec.model) $('cfg-model').value = rec.model;
    if (rec.size) {
      // 恢复尺寸选择器（匹配比例/清晰度预设，匹配不上进自定义输入）
      const inf = inferRatioQuality(rec.size);
      $('cfg-ratio').value = inf.ratio;
      $('cfg-quality').value = inf.quality;
      $('cfg-size').value = normSize(rec.size) || '2048x2048';
      updateSizePreview();
    }
    state.batchMode = false;
    state.generatedImages = images;
    state.activeIndex = 0;
    state.currentImage = images.length ? images[0].dataUrl : null; // 无图方案不崩溃（曾对 images[0] 解引用抛错）
    // 合规排版信息恢复（旧方案无这些字段时保持当前状态）
    // 合规自动排版恢复：方案有合规内容（品名/货号等任一字段）时自动开启——
    // 兼容保存时漏勾/旧方案：内容在就应排版（用户填了内容即期望排版，而非手动重勾）
    const hasCompContent = !!(rec.compFields && Object.values(rec.compFields).some((v) => typeof v === 'string' && v));
    const compAutoOn = hasCompContent || (typeof rec.compAuto === 'boolean' && rec.compAuto);
    state.compAuto = compAutoOn;
    const compAutoEl = $('comp-auto');
    if (compAutoEl) compAutoEl.checked = compAutoOn;
    if (rec.compFields && typeof rec.compFields === 'object') {
      state.compFields = { name: '', sku: '', material: '', standard: '', maker: '', warning: '' };
      for (const fk of ['name', 'sku', 'material', 'standard', 'maker', 'warning', 'origin']) {
        if (typeof rec.compFields[fk] === 'string' && rec.compFields[fk]) {
          state.compFields[fk] = rec.compFields[fk];
          const fiel = $('comp-' + fk);
          if (fiel) fiel.value = rec.compFields[fk];
        }
      }
    }
    if (Array.isArray(rec.markets)) {
      state.markets = new Set(rec.markets.filter((m) => typeof m === 'string'));
  renderCompliance();
    }
    if (rec.layout && typeof rec.layout === 'object') {
      const l = rec.layout;
      state.layout = {
        template: typeof l.template === 'string' ? l.template : 'farm',
        brand: l.brand || '', product: l.product || '', series: l.series || '',
        sellTitle: l.sellTitle || '', sellSub: l.sellSub || '',
        gridItems: Array.isArray(l.gridItems) ? l.gridItems : [],
        decoOn: l.decoOn !== false,
      };
      const setV = (id, v) => { const el = $(id); if (el) el.value = v; };
      setV('layout-template', state.layout.template);
      setV('layout-brand', state.layout.brand);
      setV('layout-product', state.layout.product);
      setV('layout-series', state.layout.series);
      setV('layout-sell-title', state.layout.sellTitle);
      setV('layout-sell-sub', state.layout.sellSub);
      setV('layout-grid', state.layout.gridItems.map((g) => (g.no || '') + ',' + (g.name || '')).join('\n'));
      const ld = $('layout-deco');
      if (ld) ld.checked = state.layout.decoOn;
    }
    if (rec.badges && typeof rec.badges === 'object') {
      state.badges = { age0to3: false, recycle: false, trash: false, gc: false, ...rec.badges };
      const setB = (id, k) => { const el = $(id); if (el) el.checked = !!state.badges[k]; };
      setB('badge-age0to3', 'age0to3'); setB('badge-recycle', 'recycle');
      setB('badge-trash', 'trash'); setB('badge-gc', 'gc');
    }
    if (rec.barcode && rec.barcode.format && rec.barcode.value) {
      const bf = $('barcode-format'), bv = $('barcode-value'), be = $('barcode-enabled');
      if (bf) bf.value = rec.barcode.format;
      if (bv) bv.value = rec.barcode.value;
      if (be) be.checked = true;
      // 自定义大小/位置参数恢复（null/缺省 → 留空=自动）
      const setNum = (id, v) => {
        const el = $(id);
        if (el) el.value = (typeof v === 'number' && Number.isFinite(v)) ? v : '';
      };
      setNum('barcode-w', rec.barcode.w);
      setNum('barcode-h', rec.barcode.h);
      setNum('barcode-x', rec.barcode.x);
      setNum('barcode-y', rec.barcode.y);
      updateBarcode();
    }
    if (typeof rec.bleed === 'boolean') {
      const ob = $('opt-bleed');
      if (ob) ob.checked = rec.bleed;
    }
    renderResults();
    renderLayout();
    if (images.length) $('btn-export').disabled = false; // 载入有图方案即可导出（首用用户直接载入历史方案也可导出）
    status.textContent = '✅ 已载入历史方案（可直接导出/继续编辑）';
    status.className = 'status ok';
  } catch (err) {
    status.textContent = '❌ 载入失败：' + err.message;
    status.className = 'status err';
  }
}

async function importSchemeFile() {
  const status = $('gen-status');
  try {
    const r = await window.api.importScheme();
    if (!r.imported) {
      status.textContent = '已取消导入';
      status.className = 'status';
      return;
    }
    loadSchemes();
    await loadScheme(r.scheme); // 导入后直接载入预览
    status.textContent = `✅ 已导入：${r.file}`;
    status.className = 'status ok';
  } catch (err) {
    status.textContent = '❌ 导入失败：' + err.message;
    status.className = 'status err';
  }
}

/* ================= 结果区（多图浏览） ================= */
/** 切换结果：批量模式 = 切换方案首图；组图模式 = 切换第 N 张；支持循环 */
function switchResult(delta) {
  const total = state.generatedImages.length;
  if (total < 2) return;
  state.activeIndex = (state.activeIndex + delta + total) % total;
  state.currentImage = state.generatedImages[state.activeIndex].dataUrl;
  renderResults();
  renderLayout();
}

function renderResults() {
  const area = $('result-area');
  const thumbs = $('result-thumbs');
  const navPrev = $('btn-result-prev');
  const navNext = $('btn-result-next');
  const counter = $('result-counter');
  if (!state.generatedImages.length) {
    area.innerHTML = '<div class="placeholder">输入需求后点击"生成主视觉"<br/>AI 将产出玩具包装主视觉插画</div>';
    thumbs.classList.add('hidden');
    navPrev.classList.add('hidden');
    navNext.classList.add('hidden');
    counter.classList.add('hidden');
    return;
  }
  const img = state.generatedImages[state.activeIndex];
  area.innerHTML = `<img src="${img.dataUrl}" alt="生成结果 第 ${state.activeIndex + 1} 张" />`;

  const multi = state.generatedImages.length > 1;
  navPrev.classList.toggle('hidden', !multi);
  navNext.classList.toggle('hidden', !multi);
  if (multi) {
    counter.textContent = state.batchMode ? `方案 ${state.activeIndex + 1}/${state.generatedImages.length}` : `第 ${state.activeIndex + 1}/${state.generatedImages.length} 张`;
    counter.classList.remove('hidden');
  } else {
    counter.classList.add('hidden');
  }

  if (multi) {
    thumbs.innerHTML = state.generatedImages
      .map((g, i) => {
        const name = state.batchMode ? `方案${i + 1}` : (SHOT_NAMES[i] || `第${i + 1}张`);
        return `<div><img class="${i === state.activeIndex ? 'active' : ''}" data-i="${i}" src="${g.dataUrl}" title="${name}" /><div class="thumb-tag">${name}</div></div>`;
      })
      .join('');
    thumbs.classList.remove('hidden');
    thumbs.querySelectorAll('img').forEach((t) => {
      t.onclick = () => {
        // 批量模式：点缩略图切换方案（载入该方案的完整视图）
        if (state.batchMode && state.schemes[t.dataset.i]) {
          const s = state.schemes[t.dataset.i];
          state.batchMode = false;
          state.generatedImages = s.images;
          state.activeIndex = 0;
          state.currentImage = s.images[0].dataUrl;
          renderResults();
          renderLayout();
          return;
        }
        state.activeIndex = Number(t.dataset.i);
        state.currentImage = state.generatedImages[state.activeIndex].dataUrl;
        renderResults();
        renderLayout();
      };
    });
  } else {
    thumbs.classList.add('hidden');
  }
}

/* ================= 条码 ================= */
function updateBarcode() {
  const on = $('barcode-enabled').checked;
  const format = $('barcode-format').value;
  const value = $('barcode-value').value.trim();
  // 即时校验：位数/校验位错误时提示且不绘制（此前非法条码被 JsBarcode 静默吞掉，用户无感知）
  let msg = '';
  if (on && value) {
    if (format === 'EAN13') {
      if (!/^\d{13}$/.test(value)) msg = `⚠ EAN-13 需要 13 位数字（当前 ${value.length} 位）`;
      else if (!checkEan13(value)) msg = '⚠ EAN-13 校验位不正确，条码将不会被绘制';
    } else if (format === 'UPC') {
      if (!/^\d{12}$/.test(value)) msg = `⚠ UPC-A 需要 12 位数字（当前 ${value.length} 位）`;
      else if (!checkUpcA(value)) msg = '⚠ UPC-A 校验位不正确，条码将不会被绘制';
    }
  }
  state.barcode = on && value && !msg ? { format, value, ...collectBarcodePos() } : null;
  const hint = $('barcode-hint');
  if (hint) {
    hint.textContent = msg;
    hint.style.display = msg ? '' : 'none';
  }
  renderLayout();
}

/** 读取条码自定义大小/位置参数（宽/高 mm、水平/垂直 %；留空返回 null=自动） */
function collectBarcodePos() {
  const num = (id) => {
    const v = $(id).value.trim();
    const n = Number(v);
    return v && Number.isFinite(n) ? n : null;
  };
  return { w: num('barcode-w'), h: num('barcode-h'), x: num('barcode-x'), y: num('barcode-y') };
}

/** 用 JsBarcode 生成条码 SVG（返回 innerHTML 与原始宽高；非法值返回 null） */
function makeBarcode(format, value) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(svg, value, {
      format, displayValue: true, width: 2, height: 60,
      margin: 4, fontSize: 16, flat: true, background: 'transparent',
    });
  } catch (e) {
    return null;
  }
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  if (!w || !h || !svg.innerHTML) return null;
  return { inner: svg.innerHTML, w, h };
}

/* ================= 合规清单 ================= */
function renderCompliance() {
  const CD = window.ComplianceData;
  const wrap = $('compliance-markets');
  wrap.innerHTML = '';
  for (const [id, m] of Object.entries(CD.markets)) {
    const chip = document.createElement('div');
    chip.className = 'market-chip' + (state.markets.has(id) ? ' active' : '');
    chip.textContent = m.name;
    chip.onclick = () => {
      if (state.markets.has(id)) state.markets.delete(id);
      else state.markets.add(id);
  renderCompliance();
    };
    wrap.appendChild(chip);
  }

  const itemsWrap = $('compliance-items');
  itemsWrap.innerHTML = '';
  if (state.markets.size === 0) {
    itemsWrap.innerHTML = '<div class="hint">👆 勾选目标市场，显示该市场包装必印信息清单</div>';
  } else {
    let total = 0, done = 0;
    for (const id of state.markets) {
      for (const it of CD.markets[id].items) {
        total++;
        const key = id + '::' + it.label;
        const checked = state.compDone.has(key);
        if (checked) done++;
        const div = document.createElement('div');
        div.className = 'comp-item' + (checked ? ' done' : '');
        div.innerHTML = `<label class="check"><input type="checkbox" ${checked ? 'checked' : ''} /><span>${escXml(it.label)}<span class="ref">${escXml(it.ref)}</span></span></label>`;
        div.querySelector('input').onchange = (e) => {
          if (e.target.checked) state.compDone.add(key);
          else state.compDone.delete(key);
  renderCompliance();
        };
        itemsWrap.appendChild(div);
      }
    }
    const head = document.createElement('div');
    head.className = 'hint';
    head.textContent = `已勾选 ${done}/${total} 项（勾选=已安排到版面）`;
    // 全部勾选 / 取消全部（作用于当前选中的市场清单）
    const selRow = document.createElement('div');
    selRow.className = 'comp-select-row';
    const mkSelBtn = (text, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.onclick = fn;
      return b;
    };
    selRow.appendChild(mkSelBtn('☑ 全部勾选', () => {
      for (const id of state.markets) {
        for (const it of CD.markets[id].items) state.compDone.add(id + '::' + it.label);
      }
  renderCompliance();
    }));
    selRow.appendChild(mkSelBtn('☐ 取消全部', () => {
      for (const id of state.markets) {
        for (const it of CD.markets[id].items) state.compDone.delete(id + '::' + it.label);
      }
  renderCompliance();
    }));
    itemsWrap.prepend(selRow);
    itemsWrap.prepend(head);
  }

  // 印刷参数常驻提示
  const printDiv = document.createElement('div');
  printDiv.className = 'comp-print';
  printDiv.innerHTML = CD.printing.map((p) => `<div class="comp-item"><span>🖨 ${escXml(p.label)}</span></div>`).join('');
  itemsWrap.appendChild(printDiv);
}

/* ================= 展开图渲染 ================= */
/** XML 转义（合规字段值可能含特殊字符） */
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 合规信息块：排入 compliancePanel 面板上半部；含文本行 + CE/3C 标志 */
function drawComplianceBlock(parts, layout, px, off) {
  const pid = layout.compliancePanel;
  if (!state.compAuto || !pid) return;
  const p = layout.panels.find((x) => x.id === pid);
  if (!p) return;
  const f = state.compFields;
  const rows = [];
  const pushRow = (k, v) => {
    if (!v) return;
    String(v).split('\n').forEach((line) => { const t = line.trim(); if (t) rows.push([k, t]); });
  };
  pushRow('品名', f.name); pushRow('货号', f.sku); pushRow('材质', f.material);
  pushRow('执行标准', f.standard); pushRow('制造商', f.maker); pushRow('警告', f.warning); pushRow('原产地', f.origin);
  // 底部标志列表：CE/CCC 按市场自动 + 手动勾选（0-3 禁婴儿/回收/垃圾桶/海湾 GC）
  const badges = [];
  if (state.markets.has('eu')) badges.push('ce');
  if (state.markets.has('cn')) badges.push('ccc');
  const bl = state.badges || {};
  if (bl.age0to3) badges.push('age0to3');
  if (bl.recycle) badges.push('recycle');
  if (bl.trash) badges.push('trash');
  if (bl.gc) badges.push('gc');
  if (!rows.length && !badges.length) return;

  const bx = px(p.x) + off + px(5);
  const bw = px(p.w) - px(10);
  // 块高按行数自适应：优先保证行数完整显示（字号下限 6px）；与条码同面板时上限 50%（H3 条码区从 50% 起），否则 85%
  const panelH = px(p.h);
  const sharedBarcode = layout.barcodePanel === pid && !!state.barcode;
  const maxBh = panelH * (sharedBarcode ? 0.5 : 0.85);
  let fs = Math.max(6, px(p.w) * 0.032); // 字号随面板宽
  const fit = (s) => rows.length * (s * 1.55) + s * 1.55 * 0.5 <= maxBh;
  while (fs > 6 && !fit(fs)) fs -= 1;
  const bh = Math.min(maxBh, Math.max(panelH * 0.46, rows.length * (fs * 1.55) + fs * 1.55 * 0.5));
  const by = px(p.y) + off + px(4);
  parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${px(2)}" fill="#f4f6f8" stroke="#c9d2dc" stroke-width="${px(0.25)}"/>`);

  const lh = fs * 1.55;
  const flagW = badges.length ? bh * 1.05 : 0; // 预留标志区
  const maxTextW = bw - px(10) - flagW;
  let ty = by + lh;

  for (const [k, v] of rows) {
    let line = k ? `${k}：${v}` : v;
    // 超宽截断（按中文字符估算）
    if (line.length * fs > maxTextW) {
      line = line.slice(0, Math.max(6, Math.floor(maxTextW / fs))) + '…';
    }
    parts.push(`<text x="${bx + px(5)}" y="${ty}" font-size="${fs}" fill="#1f2630">${escXml(line)}</text>`);
    ty += lh;
    if (ty > by + bh - lh * 0.4) break;
  }

  if (badges.length) {
    const n = badges.length;
    const d = Math.min(bh * 0.5, (bw - px(10)) / (n * 1.25));
    const fy = by + px(4);
    let fx = bx + bw - d / 2 - px(4);
    for (const b of badges) {
      drawBadge(parts, b, fx, fy + d / 2, d);
      fx -= d * 1.25;
    }
  }
}

/** 合规标志绘制（底部标志：CE/CCC/0-3 禁婴儿/回收/垃圾桶/海湾 GC） */
function drawBadge(parts, type, cx, cy, d) {
  const r = d / 2;
  if (type === 'ce') {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1f2630" stroke-width="${Math.max(1, d * 0.07)}"/>`);
    parts.push(`<text x="${cx}" y="${cy + d * 0.28}" text-anchor="middle" font-size="${d * 0.5}" font-weight="bold" fill="#1f2630">CE</text>`);
  } else if (type === 'ccc') {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1f2630" stroke-width="${Math.max(1, d * 0.07)}"/>`);
    parts.push(`<text x="${cx}" y="${cy + d * 0.24}" text-anchor="middle" font-size="${d * 0.4}" font-weight="bold" fill="#1f2630">CCC</text>`);
  } else if (type === 'age0to3') {
    // 红色 0-3 禁婴儿（婴儿头+身+斜杠+0-3）
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#e30613"/>`);
    parts.push(`<circle cx="${cx - r * 0.25}" cy="${cy - r * 0.18}" r="${r * 0.2}" fill="#ffffff"/>`);
    parts.push(`<ellipse cx="${cx - r * 0.25}" cy="${cy + r * 0.28}" rx="${r * 0.26}" ry="${r * 0.3}" fill="#ffffff"/>`);
    parts.push(`<line x1="${cx - r * 0.72}" y1="${cy + r * 0.72}" x2="${cx + r * 0.72}" y2="${cy - r * 0.72}" stroke="#ffffff" stroke-width="${d * 0.08}" stroke-linecap="round"/>`);
    parts.push(`<text x="${cx + r * 0.3}" y="${cy + r * 0.34}" text-anchor="middle" font-size="${d * 0.4}" font-weight="bold" fill="#ffffff">0-3</text>`);
  } else if (type === 'recycle') {
    // 绿色回收（三箭头 120° 旋转近似）
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#009639"/>`);
    const ap = `M ${cx} ${cy - r * 0.72} L ${cx + r * 0.18} ${cy - r * 0.2} L ${cx - r * 0.18} ${cy - r * 0.2} Z`;
    for (let i = 0; i < 3; i++) {
      parts.push(`<path d="${ap}" fill="#ffffff" transform="rotate(${i * 120} ${cx} ${cy})"/>`);
    }
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.14}" fill="#009639"/>`);
  } else if (type === 'trash') {
    // 垃圾桶（WEEE：桶+盖+轮+红叉）
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1f2630" stroke-width="${Math.max(1, d * 0.06)}"/>`);
    parts.push(`<line x1="${cx - r * 0.5}" y1="${cy - r * 0.3}" x2="${cx + r * 0.5}" y2="${cy - r * 0.3}" stroke="#1f2630" stroke-width="${d * 0.08}" stroke-linecap="round"/>`);
    parts.push(`<rect x="${cx - r * 0.34}" y="${cy - r * 0.16}" width="${r * 0.68}" height="${r * 0.58}" fill="none" stroke="#1f2630" stroke-width="${d * 0.07}"/>`);
    parts.push(`<circle cx="${cx - r * 0.17}" cy="${cy + r * 0.52}" r="${r * 0.1}" fill="none" stroke="#1f2630" stroke-width="${d * 0.05}"/>`);
    parts.push(`<circle cx="${cx + r * 0.17}" cy="${cy + r * 0.52}" r="${r * 0.1}" fill="none" stroke="#1f2630" stroke-width="${d * 0.05}"/>`);
    parts.push(`<line x1="${cx - r * 0.24}" y1="${cy - r * 0.42}" x2="${cx + r * 0.24}" y2="${cy + r * 0.42}" stroke="#e30613" stroke-width="${d * 0.06}"/>`);
    parts.push(`<line x1="${cx + r * 0.24}" y1="${cy - r * 0.42}" x2="${cx - r * 0.24}" y2="${cy + r * 0.42}" stroke="#e30613" stroke-width="${d * 0.06}"/>`);
  } else if (type === 'gc') {
    // 海湾认证 GC（圆角方块 + GC）
    parts.push(`<rect x="${cx - r}" y="${cy - r}" width="${d}" height="${d}" rx="${r * 0.28}" fill="none" stroke="#1f2630" stroke-width="${d * 0.08}"/>`);
    parts.push(`<text x="${cx}" y="${cy + d * 0.3}" text-anchor="middle" font-size="${d * 0.52}" font-weight="bold" fill="#1f2630">GC</text>`);
  }
}

/** 展开图预览/导出配色：跟随当前主题（浅色=白底设计稿风格，深色=暗色画布风格） */
function themeColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return dark ? {
    bg: '#2a3140', panelFill: '#333d4d', panelStroke: '#6b7a92', faceNoImg: '#454f61',
    side: '#3b4453', flap: '#313a48', flapStroke: '#546072',
    windowFill: 'rgba(255,255,255,0.28)', windowStroke: '#4f8cff',
    label: 'rgba(255,255,255,0.55)', barcodeTag: '#9fb0c4', sizeText: '#aab4c4',
  } : {
    bg: '#ffffff', panelFill: '#eef1f6', panelStroke: '#9aa7b8', faceNoImg: '#e2e8f1',
    side: '#eef1f6', flap: '#f6f8fb', flapStroke: '#b6c0cf',
    windowFill: 'rgba(61,123,240,0.08)', windowStroke: '#3d7bf0',
    label: 'rgba(34,42,53,0.40)', barcodeTag: '#67738a', sizeText: '#67738a',
  };
}

function buildSvg(scale, opts = {}) {
  const TC = themeColors();
  const bleed = opts.bleed || 0; // mm 出血
  const showLabel = opts.showLabel !== false;
  const proc = opts.process || 'none'; // 工艺预览模拟：none|matte|gloss|uv|gold|silver // 预览显示尺寸标注；导出/3D 贴图去掉
  const t = state.templates[state.currentType];
  const layout = t.build(getSize());
  const px = (v) => v * scale;
  const off = px(bleed);
  const LABEL_H = showLabel ? 30 : 0; // 尺寸标注区（展开图下方，不遮挡）
  const W = px(layout.width) + off * 2;
  const H = px(layout.height) + off * 2 + LABEL_H;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Microsoft YaHei, sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${TC.bg}"/>`);

  // 工艺预览渐变 defs（仅预览注入；导出不含）
  if (proc !== 'none') {
    let defs = '<defs>';
    if (proc === 'gloss' || proc === 'gold' || proc === 'silver') {
      defs += '<linearGradient id="procGloss" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>' +
        '<stop offset="0.42" stop-color="#ffffff" stop-opacity="0.02"/>' +
        '<stop offset="0.58" stop-color="#ffffff" stop-opacity="0.02"/>' +
        '<stop offset="1" stop-color="#ffffff" stop-opacity="0.34"/>' +
        '</linearGradient>';
    }
    if (proc === 'gold' || proc === 'silver') {
      const m = proc === 'gold'
        ? ['#8a6d1f', '#f6e27a', '#d4af37', '#fff7c0', '#a8842c']
        : ['#6e6e6e', '#f2f2f2', '#c0c0c0', '#ffffff', '#8a8a8a'];
      defs += '<linearGradient id="procMetal" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="' + m[0] + '"/>' +
        '<stop offset="0.25" stop-color="' + m[1] + '"/>' +
        '<stop offset="0.5" stop-color="' + m[2] + '"/>' +
        '<stop offset="0.75" stop-color="' + m[3] + '"/>' +
        '<stop offset="1" stop-color="' + m[4] + '"/>' +
        '</linearGradient>';
    }
    if (proc === 'uv') {
      defs += '<radialGradient id="procUv" cx="0.5" cy="0.42" r="0.8">' +
        '<stop offset="0" stop-color="#ffffff" stop-opacity="0.32"/>' +
        '<stop offset="0.55" stop-color="#ffffff" stop-opacity="0.10"/>' +
        '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>' +
        '</radialGradient>';
    }
    parts.push(defs + '</defs>');
  }

  for (const p of layout.panels) {
    const x = px(p.x) + off, y = px(p.y) + off, w = px(p.w), h = px(p.h);
    let fill = TC.panelFill;
    let stroke = TC.panelStroke;
    let strokeW = 1.6;

    if (p.kind === 'face') {
      if (state.currentImage) {
        parts.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${state.currentImage}"/>`);
        fill = 'none';
      } else {
        fill = TC.faceNoImg;
      }
    } else if (p.kind === 'side') {
      fill = TC.side;
    } else if (p.kind === 'flap') {
      fill = TC.flap;
      stroke = TC.flapStroke;
    } else if (p.kind === 'window') {
      fill = TC.windowFill;
      stroke = TC.windowStroke;
      strokeW = 2;
    }

    if (p.kind === 'window' && (p.shape === 'ellipse' || p.shape === 'circle')) {
      // 圆形 = 内切正圆（直径=短边）；椭圆 = 按宽高
      const rr = p.shape === 'circle' ? Math.min(w, h) / 2 : 0;
      parts.push(`<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${p.shape === 'circle' ? rr : w / 2}" ry="${p.shape === 'circle' ? rr : h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"/>`);
    } else {
      const rx = p.kind === 'window' && p.shape === 'round' ? Math.min(w, h) * 0.18 : 0;
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"/>`);
    }

    // 折叠线（虚线）
    if (p.foldEdges) {
      for (const edge of p.foldEdges) {
        let line = '';
        if (edge === 'top') line = `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y}"/>`;
        if (edge === 'bottom') line = `<line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y + h}"/>`;
        if (edge === 'left') line = `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + h}"/>`;
        if (edge === 'right') line = `<line x1="${x + w}" y1="${y}" x2="${x + w}" y2="${y + h}"/>`;
        if (line) {
          parts.push(line.replace('<line ', '<line stroke="#ff8c4f" stroke-width="1.8" stroke-dasharray="7 5" '));
        }
      }
    }

    // 面板标注（window 不标文字，避免遮挡视觉）
    if (p.kind !== 'window' && w > 90 && h > 30) {
      const label = p.kind === 'face' && state.currentImage ? '' : p.label;
      if (label) {
        parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="13" fill="${TC.label}">${label}</text>`);
      }
    }
  }

  // 条码叠加到模板指定的条码面板（白底 + 缩放适配；与合规块同面板时下移避让；支持自定义大小/位置）
  // 版面套版区块（正面 + 背板；填内容即套版；网格自动配图）
  if (state.layout && (state.layout.brand || state.layout.product || state.layout.series || state.layout.sellTitle || (state.layout.gridItems && state.layout.gridItems.length))) {
    const tpl = LAYOUT_TEMPLATES[state.layout.template] || LAYOUT_TEMPLATES.farm;
    const imgs = (state.generatedImages || []).map((g) => (g && g.dataUrl) || null);
    const fp = layout.panels.find((p) => p.id === layout.panel);
    if (fp) {
      let sections = layoutSections(state.layout, { x: fp.x, y: fp.y, w: fp.w, h: fp.h }, imgs, 'front');
      sections = applyBlockOverrides(sections, state.layout.blocks); // 拖拽位置覆盖（大改）
      drawLayoutSections(parts, sections, px, off, proc);
      if (opts.interactive) drawLayoutHandles(parts, sections, px, off); // 拖拽手柄（仅预览）
      // 窗口拖拽手柄（仅开窗盒预览；自由定制）
      const wpp = layout.panels.find((p) => p.kind === 'window');
      if (wpp) {
        const wx = px(wpp.x) + off, wy = px(wpp.y) + off, ww = px(wpp.w), wh = px(wpp.h);
        parts.push(`<rect class="win-body" data-win="body" x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="transparent" style="cursor:move"/>`);
        const hs = 6;
        const dirs = [
          ['nw', wx, wy, 'nwse-resize'], ['ne', wx + ww, wy, 'nesw-resize'],
          ['se', wx + ww, wy + wh, 'nwse-resize'], ['sw', wx, wy + wh, 'nesw-resize'],
          ['n', wx + ww / 2, wy, 'ns-resize'], ['e', wx + ww, wy + wh / 2, 'ew-resize'],
          ['s', wx + ww / 2, wy + wh, 'ns-resize'], ['w', wx, wy + wh / 2, 'ew-resize'],
        ];
        for (const d of dirs) {
          parts.push(`<rect class="win-handle" data-win="${d[0]}" x="${d[1] - hs}" y="${d[2] - hs}" width="${hs * 2}" height="${hs * 2}" rx="1.5" fill="#ffffff" stroke="#3d7bf0" stroke-width="1" style="cursor:${d[3]}"/>`);
        }
      }
    }
    // 背板版面（模板指定面板且盒型存在：品牌条 + 网格 + 装饰条）
    if (tpl.back && tpl.back.panel) {
      const bp = layout.panels.find((p) => p.id === tpl.back.panel);
      if (bp) {
        const bl = { template: state.layout.template, brand: state.layout.brand, product: '', series: '', sellTitle: '', sellSub: '', gridItems: state.layout.gridItems, decoOn: state.layout.decoOn };
        const bs = layoutSections(bl, { x: bp.x, y: bp.y, w: bp.w, h: bp.h }, imgs, 'back');
        drawLayoutSections(parts, bs, px, off, proc);
      }
    }
  }
  if (state.barcode && layout.barcodePanel) {
    const bp = layout.panels.find((p) => p.id === layout.barcodePanel);
    if (bp) {
      const bar = makeBarcode(state.barcode.format, state.barcode.value);
      if (bar) {
        const shared = state.compAuto && layout.compliancePanel === layout.barcodePanel;
        const b = state.barcode;
        // 大小：指定宽/高（mm）按指定（同时指定时允许非等比拉伸）；缺省自动适配面板
        const autoS = Math.min(px(bp.w) * 0.72 / bar.w, px(bp.h) * (shared ? 0.45 : 0.6) / bar.h);
        let bw, bh;
        if (typeof b.w === 'number' && Number.isFinite(b.w) && typeof b.h === 'number' && Number.isFinite(b.h)) {
          bw = px(b.w); bh = px(b.h);
        } else if (typeof b.w === 'number' && Number.isFinite(b.w)) {
          bw = px(b.w); bh = bar.h * (bw / bar.w);
        } else if (typeof b.h === 'number' && Number.isFinite(b.h)) {
          bh = px(b.h); bw = bar.w * (bh / bar.h);
        } else {
          bw = bar.w * autoS; bh = bar.h * autoS;
        }
        // 位置：指定水平/垂直 %（条码中心在面板内）；缺省水平居中、垂直自动（shared 在合规块下方）
        const hasX = typeof b.x === 'number' && Number.isFinite(b.x);
        const hasY = typeof b.y === 'number' && Number.isFinite(b.y);
        const cx = hasX
          ? px(bp.x) + off + px(bp.w) * (Math.min(100, Math.max(0, b.x)) / 100)
          : px(bp.x) + off + px(bp.w) / 2;
        const cy = hasY
          ? px(bp.y) + off + px(bp.h) * (Math.min(100, Math.max(0, b.y)) / 100)
          : px(bp.y) + off + (shared ? px(bp.h) * 0.5 + bh / 2 : px(bp.h) / 2);
        parts.push(`<rect x="${cx - bw / 2 - 5}" y="${cy - bh / 2 - 5}" width="${bw + 10}" height="${bh + 10}" rx="3" fill="#ffffff"/>`);
        parts.push(`<g transform="translate(${cx - bw / 2}, ${cy - bh / 2}) scale(${(bw / bar.w).toFixed(4)}, ${(bh / bar.h).toFixed(4)})">${bar.inner}</g>`);
        parts.push(`<text x="${cx}" y="${cy + bh / 2 + 14}" text-anchor="middle" font-size="11" fill="${TC.barcodeTag}">条码区（${state.barcode.format}）</text>`);
        // 预览交互层（仅 opts.interactive 时注入；导出/PDF/3D 不包含）：命中区 + 8 方向缩放手柄
        if (opts.interactive) {
          parts.push(`<rect class="bc-body" data-bc="body" x="${cx - bw / 2}" y="${cy - bh / 2}" width="${bw}" height="${bh}" fill="transparent" style="cursor:move"/>`);
          const hs = 7;
          const dirs = [
            ['nw', cx - bw / 2, cy - bh / 2, 'nwse-resize'],
            ['ne', cx + bw / 2, cy - bh / 2, 'nesw-resize'],
            ['se', cx + bw / 2, cy + bh / 2, 'nwse-resize'],
            ['sw', cx - bw / 2, cy + bh / 2, 'nesw-resize'],
            ['n', cx, cy - bh / 2, 'ns-resize'],
            ['e', cx + bw / 2, cy, 'ew-resize'],
            ['s', cx, cy + bh / 2, 'ns-resize'],
            ['w', cx - bw / 2, cy, 'ew-resize'],
          ];
          for (const [d, hx, hy, cur] of dirs) {
            parts.push(`<rect class="bc-handle" data-bc="${d}" x="${hx - hs}" y="${hy - hs}" width="${hs * 2}" height="${hs * 2}" rx="2" style="cursor:${cur}"/>`);
          }
        }
      }
    }
  }

  // 合规信息块（排在最上层）
  drawComplianceBlock(parts, layout, px, off);

  // 出血：成品线（虚线框）示意
  if (bleed > 0) {
    parts.push(`<rect x="${off}" y="${off}" width="${px(layout.width)}" height="${px(layout.height)}" fill="none" stroke="#ff8c4f" stroke-width="2" stroke-dasharray="10 6"/>`);
  }

  // 总尺寸标注（放在展开图下方独立标注区，不遮挡刀模图）
  if (showLabel) {
    const s = getSize();
    const bleedNote = bleed > 0 ? `（含 ${bleed}mm 出血）` : '';
    parts.push(
      `<text x="${W / 2}" y="${H - 10}" text-anchor="middle" font-size="14" fill="${TC.sizeText}">` +
      `展开尺寸 ${layout.width} × ${layout.height} mm ${bleedNote}｜ 盒体 ${s.w} × ${s.d} × ${s.h} mm</text>`
    );
  }
  // 工艺预览效果层（仅预览；模拟覆膜/UV/烫金视觉）
  if (proc === 'matte') {
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="rgba(255,255,255,0.06)"/>`);
  } else if (proc === 'gloss') {
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#procGloss)"/>`);
  } else if (proc === 'uv') {
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#procUv)"/>`);
  } else if (proc === 'gold' || proc === 'silver') {
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#procGloss)"/>`);
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="rgba(0,0,0,0.03)"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

/** 当前预览的 scale/出血（条码拖拽换算用；renderLayout 每次更新） */
let previewCfg = { scale: 1, bleed: 0 };
function renderLayout() {
  const area = $('preview-area');
  if (!state.currentType) return;
  // 等比例放大铺满：按容器可用宽度动态计算 scale（保持刀模比例，不拉伸变形），超出高度可滚动查看
  const layout = state.templates[state.currentType].build(getSize());
  const availW = Math.max(340, area.clientWidth - 28);
  const scale = +(availW / layout.width).toFixed(3);
  previewCfg = { scale, bleed: $('opt-bleed').checked ? 3 : 0 };
  area.innerHTML = buildSvg(scale, { bleed: previewCfg.bleed, interactive: true, process: state.process });
  scheduleMockup(); // 3D 盒子同步重建（防抖）
}

/* ============ 预览区条码直接拖拽/缩放（手柄在 buildSvg interactive 层） ============ */
/** 当前拖拽会话：null 或 { invCtm, mode, start, effW, effH, effX, effY, layout, bp, scale, off, shared } */
let bcDrag = null;
function svgPointFromCtm(ev, invCtm) {
  // 用 mousedown 时快照的逆屏幕矩阵换算 SVG 坐标：拖动中 SVG 会重绘（updateBarcode → renderLayout），
  // 旧元素引用会 detached、getScreenCTM 失效——快照矩阵不受影响（展开图整体尺寸不变，矩阵恒定）
  const pt = { x: ev.clientX, y: ev.clientY };
  const m = invCtm;
  const x = m.a * pt.x + m.c * pt.y + m.e;
  const y = m.b * pt.x + m.d * pt.y + m.f;
  return { x, y };
}
function initBarcodeDrag(svg, mode, ev) {
  const b = state.barcode;
  if (!b) return;
  const layout = state.templates[state.currentType].build(getSize());
  const bp = layout.panels.find((p) => p.id === layout.barcodePanel);
  if (!bp) return;
  const { scale } = previewCfg;
  const px = (v) => v * scale;
  const off = previewCfg.bleed * scale;
  const shared = state.compAuto && layout.compliancePanel === layout.barcodePanel;
  const bar = makeBarcode(b.format, b.value);
  if (!bar) return;
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  // 复刻 buildSvg 的条码实际布局（含自动模式），作为拖拽起点
  const autoS = Math.min(px(bp.w) * 0.72 / bar.w, px(bp.h) * (shared ? 0.45 : 0.6) / bar.h);
  const effW = typeof b.w === 'number' && Number.isFinite(b.w) ? px(b.w) : bar.w * autoS;
  const effH = typeof b.h === 'number' && Number.isFinite(b.h) ? px(b.h) : (typeof b.w === 'number' && Number.isFinite(b.w) ? bar.h * (px(b.w) / bar.w) : bar.h * autoS);
  const hasX = typeof b.x === 'number' && Number.isFinite(b.x);
  const hasY = typeof b.y === 'number' && Number.isFinite(b.y);
  const effX = hasX ? px(bp.x) + off + px(bp.w) * (Math.min(100, Math.max(0, b.x)) / 100) : px(bp.x) + off + px(bp.w) / 2;
  const effY = hasY ? px(bp.y) + off + px(bp.h) * (Math.min(100, Math.max(0, b.y)) / 100) : px(bp.y) + off + (shared ? px(bp.h) * 0.5 + effH / 2 : px(bp.h) / 2);
  bcDrag = { invCtm: ctm.inverse(), mode, start: svgPointFromCtm(ev, ctm.inverse()), effW, effH, effX, effY, layout, bp, scale, off, shared };
}
function applyBarcodeDrag(ev) {
  if (!bcDrag) return;
  try {
    const { invCtm, mode, start, effW, effH, effX, effY, bp, scale, off, shared } = bcDrag;
    const px = (v) => v * scale;
    const cur = svgPointFromCtm(ev, invCtm);
    const dx = cur.x - start.x, dy = cur.y - start.y;
  const setNum = (id, v) => {
    const el = $(id);
    if (el) el.value = Math.round(v * 10) / 10;
  };
  if (mode === 'body') {
    // 拖动：条码中心随鼠标位移（px → 面板 %）
    const xPct = Math.min(100, Math.max(0, ((effX - (px(bp.x) + off)) / px(bp.w)) * 100 + (dx / px(bp.w)) * 100));
    const yPct = Math.min(100, Math.max(0, ((effY - (px(bp.y) + off)) / px(bp.h)) * 100 + (dy / px(bp.h)) * 100));
    setNum('barcode-x', xPct);
    setNum('barcode-y', yPct);
    updateBarcode();
    return;
  }
  // 手柄缩放：对角锚定（拖哪个角，对角固定；边中点只改单维）
  const dirX = mode.includes('w') ? -1 : (mode.includes('e') ? 1 : 0);
  const dirY = mode.includes('n') ? -1 : (mode.includes('s') ? 1 : 0);
  const left0 = effX - effW / 2, right0 = effX + effW / 2, top0 = effY - effH / 2, bottom0 = effY + effH / 2;
  const anchorX = dirX > 0 ? left0 : right0; // 拖右/下 → 左/上为锚
  const anchorY = dirY > 0 ? top0 : bottom0;
  const cornerX = dirX !== 0 ? (dirX > 0 ? right0 + dx : left0 + dx) : effX;
  const cornerY = dirY !== 0 ? (dirY > 0 ? bottom0 + dy : top0 + dy) : effY;
  let nW, nH, nCx, nCy;
  if (dirX !== 0 && dirY !== 0) {
    // 四角手柄：等比缩放（宽高比例锁定，仅改变大小）。
    // 缩放系数 = 拖动点到锚点的投影距离 / 初始对角距离（沿对角线方向拖动最顺，垂直分量忽略）
    const c0x = dirX > 0 ? right0 : left0, c0y = dirY > 0 ? bottom0 : top0;
    const startDiag = Math.hypot(c0x - anchorX, c0y - anchorY);
    const ux = (c0x - anchorX) / startDiag, uy = (c0y - anchorY) / startDiag;
    const proj = (cornerX - anchorX) * ux + (cornerY - anchorY) * uy;
    const kMin = Math.max((10 * scale) / effW, (5 * scale) / effH); // 最小 10mm 宽 / 5mm 高
    const k = Math.max(proj / startDiag, kMin);
    nW = effW * k;
    nH = effH * k;
    const nCX = anchorX + ux * startDiag * k, nCY = anchorY + uy * startDiag * k;
    nCx = (anchorX + nCX) / 2;
    nCy = (anchorY + nCY) / 2;
  } else {
    // 边中点手柄：只改单维（n/s 改高、e/w 改宽），中心随之移动
    const nLeft = Math.min(anchorX, cornerX), nRight = Math.max(anchorX, cornerX);
    const nTop = Math.min(anchorY, cornerY), nBottom = Math.max(anchorY, cornerY);
    nW = Math.max(nRight - nLeft, 10 * scale); // 最小 10mm
    nH = Math.max(nBottom - nTop, 5 * scale); // 最小 5mm
    nCx = (nLeft + nRight) / 2;
    nCy = (nTop + nBottom) / 2;
  }
  setNum('barcode-w', nW / scale);
  setNum('barcode-h', nH / scale);
  setNum('barcode-x', Math.min(100, Math.max(0, ((nCx - (px(bp.x) + off)) / px(bp.w)) * 100)));
  setNum('barcode-y', Math.min(100, Math.max(0, ((nCy - (px(bp.y) + off)) / px(bp.h)) * 100)));
  updateBarcode();
  } catch (e) {
    bcDrag = null; // 换算异常（如重绘后矩阵失效）时终止拖拽，避免方向错乱
  }
}
/* ===== 套版区块拖拽（大改：拖拽版面编辑器；复用条码拖拽的 CTM 快照机制）===== */
let layoutDrag = null;
function initLayoutDrag(svg, id, dir, ev) {
  const layout = state.templates[state.currentType].build(getSize());
  const fp = layout.panels.find((p) => p.id === layout.panel);
  if (!fp) return;
  const { scale } = previewCfg;
  const offPx = previewCfg.bleed * scale;
  const auto = layoutSections(state.layout, { x: fp.x, y: fp.y, w: fp.w, h: fp.h }, null, 'front');
  const cur = (state.layout.blocks && state.layout.blocks[id]) || (auto.find((s) => s.id === id) || {});
  if (!(cur.w > 0) || !(cur.h > 0)) return;
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  layoutDrag = { id, dir, invCtm: ctm.inverse(), start: svgPointFromCtm(ev, ctm.inverse()), fp, scale, offPx, cur: { x: cur.x, y: cur.y, w: cur.w, h: cur.h } };
}
function applyLayoutDrag(ev) {
  if (!layoutDrag) return;
  try {
    const { id, dir, invCtm, start, fp, scale, cur } = layoutDrag;
    const p = svgPointFromCtm(ev, invCtm);
    const dx = (p.x - start.x) / scale; // px → mm
    const dy = (p.y - start.y) / scale;
    let nx = cur.x, ny = cur.y, nw = cur.w, nh = cur.h;
    if (dir === 'body') {
      nx = cur.x + dx; ny = cur.y + dy;
    } else {
      const dirX = dir.indexOf('w') >= 0 ? -1 : (dir.indexOf('e') >= 0 ? 1 : 0);
      const dirY = dir.indexOf('n') >= 0 ? -1 : (dir.indexOf('s') >= 0 ? 1 : 0);
      if (dirX !== 0) {
        if (dirX > 0) nw = Math.max(8, cur.w + dx);
        else { nw = Math.max(8, cur.w - dx); nx = cur.x + (cur.w - nw); }
      }
      if (dirY !== 0) {
        if (dirY > 0) nh = Math.max(8, cur.h + dy);
        else { nh = Math.max(8, cur.h - dy); ny = cur.y + (cur.h - nh); }
      }
    }
    // clamp 到面板内
    nx = Math.min(Math.max(0, nx), fp.w - 4);
    ny = Math.min(Math.max(0, ny), fp.h - 4);
    nw = Math.min(nw, Math.max(8, fp.w - nx - 2));
    nh = Math.min(nh, Math.max(8, fp.h - ny - 2));
    if (!state.layout.blocks) state.layout.blocks = {};
    state.layout.blocks[id] = { x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10, w: Math.round(nw * 10) / 10, h: Math.round(nh * 10) / 10 };
    renderLayout();
  } catch (e) { layoutDrag = null; }
}
function bindLayoutDrag() {
  const area = $('preview-area');
  area.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (state.winDrawMode) return;
    const svg = t.ownerSVGElement || (t.tagName === 'svg' ? t : null);
    if (!svg || !t.dataset || !t.dataset.lay) return;
    e.preventDefault();
    initLayoutDrag(svg, t.dataset.lay, t.dataset.dir || 'body', e);
  });
  document.addEventListener('mousemove', (e) => {
    if (layoutDrag) { e.preventDefault(); applyLayoutDrag(e); }
  });
  document.addEventListener('mouseup', () => { layoutDrag = null; });
}
/* ===== 开窗窗口拖拽（自由定制：拖动/8 向缩放，换算回 boxWin 百分比）===== */
let winDrag = null;
function initWinDrag(svg, dir, ev) {
  const layout = state.templates[state.currentType].build(getSize());
  const fp = layout.panels.find((p) => p.id === layout.panel);
  const wp = layout.panels.find((p) => p.kind === 'window');
  if (!fp || !wp) return;
  const { scale } = previewCfg;
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  winDrag = { dir, invCtm: ctm.inverse(), start: svgPointFromCtm(ev, ctm.inverse()), fp, wp, scale, win0: Object.assign({}, state.boxWin) };
}
function applyWinDrag(ev) {
  if (!winDrag) return;
  try {
    const { dir, invCtm, start, fp, scale, win0 } = winDrag;
    const p = svgPointFromCtm(ev, invCtm);
    const dx = (p.x - start.x) / scale; // mm
    const dy = (p.y - start.y) / scale;
    const toPct = (v) => Math.round(v * 10) / 10;
    let x = win0.xPct, y = win0.yPct, w = win0.wPct, h = win0.hPct;
    if (dir === 'body') {
      x = toPct(win0.xPct + (dx / fp.w) * 100);
      y = toPct(win0.yPct + (dy / fp.h) * 100);
    } else {
      const dirX = dir.indexOf('w') >= 0 ? -1 : (dir.indexOf('e') >= 0 ? 1 : 0);
      const dirY = dir.indexOf('n') >= 0 ? -1 : (dir.indexOf('s') >= 0 ? 1 : 0);
      if (dirX !== 0) {
        if (dirX > 0) w = toPct(Math.max(10, win0.wPct + (dx / fp.w) * 100));
        else { w = toPct(Math.max(10, win0.wPct - (dx / fp.w) * 100)); x = toPct(win0.xPct + (win0.wPct - w)); }
      }
      if (dirY !== 0) {
        if (dirY > 0) h = toPct(Math.max(10, win0.hPct + (dy / fp.h) * 100));
        else { h = toPct(Math.max(10, win0.hPct - (dy / fp.h) * 100)); y = toPct(win0.yPct + (win0.hPct - h)); }
      }
    }
    x = Math.min(Math.max(0, x), 95); y = Math.min(Math.max(0, y), 95);
    w = Math.min(w, 100 - x); h = Math.min(h, 100 - y);
    state.boxWin = Object.assign({}, win0, { xPct: x, yPct: y, wPct: w, hPct: h });
    const sw = (id, v) => { const el = $(id); if (el) el.value = v; };
    sw('boxwin-w', w); sw('boxwin-h', h); sw('boxwin-x', x); sw('boxwin-y', y);
    renderLayout();
  } catch (e) { winDrag = null; }
}
/* ===== 窗口画板绘制（自由绘制：拖框直接画出窗口位置/大小）===== */
let winDraw = null;
function startWinDraw(ev) {
  const svg = document.querySelector('#preview-area svg');
  if (!svg) return;
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  const layout = state.templates[state.currentType].build(getSize());
  const fp = layout.panels.find((p) => p.id === layout.panel);
  if (!fp) return;
  const { scale } = previewCfg;
  const offPx = previewCfg.bleed * scale;
  const r = svg.getBoundingClientRect();
  winDraw = {
    startClient: { x: ev.clientX, y: ev.clientY },
    startSvg: svgPointFromCtm(ev, ctm.inverse()),
    fp, scale, offPx, svgRect: r,
    box: null,
  };
  const box = document.createElement('div');
  box.id = 'win-draw-box';
  box.style.cssText = 'position:absolute;border:1.5px dashed #3d7bf0;background:rgba(61,123,240,0.12);pointer-events:none;z-index:5;display:none;';
  document.getElementById('preview-area').appendChild(box);
  winDraw.box = box;
}
function moveWinDraw(ev) {
  if (!winDraw) return;
  const { startClient, box, svgRect } = winDraw;
  const x = Math.min(startClient.x, ev.clientX) - svgRect.left;
  const y = Math.min(startClient.y, ev.clientY) - svgRect.top;
  const w = Math.abs(ev.clientX - startClient.x);
  const h = Math.abs(ev.clientY - startClient.y);
  box.style.display = 'block';
  box.style.left = x + 'px';
  box.style.top = y + 'px';
  box.style.width = w + 'px';
  box.style.height = h + 'px';
}
function endWinDraw(ev) {
  if (!winDraw) return;
  const { startSvg, fp, scale, offPx, box } = winDraw;
  if (box) box.remove();
  const svg = document.querySelector('#preview-area svg');
  if (!svg) return;
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  const end = svgPointFromCtm(ev, ctm.inverse());
  const fpPx = { x: fp.x * scale + offPx, y: fp.y * scale + offPx, w: fp.w * scale, h: fp.h * scale };
  let x1 = Math.min(startSvg.x, end.x), y1 = Math.min(startSvg.y, end.y);
  let x2 = Math.max(startSvg.x, end.x), y2 = Math.max(startSvg.y, end.y);
  const wMm = (x2 - x1) / scale, hMm = (y2 - y1) / scale;
  const xMm = (x1 - fpPx.x) / scale, yMm = (y1 - fpPx.y) / scale;
  if (wMm < 5 || hMm < 5) { state.winDrawMode = false; const b2 = $('btn-win-draw'); if (b2) b2.classList.remove('active'); winDraw = null; return; }
  const xPct = Math.round(Math.min(Math.max(0, xMm / fp.w * 100), 95) * 10) / 10;
  const yPct = Math.round(Math.min(Math.max(0, yMm / fp.h * 100), 95) * 10) / 10;
  const wPct = Math.round(Math.min(Math.max(10, wMm / fp.w * 100), 100 - xPct) * 10) / 10;
  const hPct = Math.round(Math.min(Math.max(10, hMm / fp.h * 100), 100 - yPct) * 10) / 10;
  state.boxWin = Object.assign({}, state.boxWin, { xPct, yPct, wPct, hPct });
  const sw = (id, v) => { const el = $(id); if (el) el.value = v; };
  sw('boxwin-w', wPct); sw('boxwin-h', hPct); sw('boxwin-x', xPct); sw('boxwin-y', yPct);
  state.winDrawMode = false;
  const btn = $('btn-win-draw');
  if (btn) btn.classList.remove('active');
  renderLayout();
  winDraw = null;
}
function bindWindowDrag() {
  const area = $('preview-area');
  area.addEventListener('mousedown', (e) => {
    if (state.winDrawMode) { e.preventDefault(); startWinDraw(e); return; }
    const t = e.target;
    const svg = t.ownerSVGElement || (t.tagName === 'svg' ? t : null);
    if (!svg || !t.dataset || !t.dataset.win) return;
    e.preventDefault();
    initWinDrag(svg, t.dataset.win, e);
  });
  document.addEventListener('mousemove', (e) => {
    if (state.winDrawMode && winDraw) { e.preventDefault(); moveWinDraw(e); return; }
    if (winDrag) { e.preventDefault(); applyWinDrag(e); }
  });
  document.addEventListener('mouseup', (e) => {
    if (state.winDrawMode && winDraw) { endWinDraw(e); return; }
    winDrag = null;
  });
}
function bindBarcodeDrag() {
  const area = $('preview-area');
  area.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (state.winDrawMode) return;
    const svg = t.ownerSVGElement || (t.tagName === 'svg' ? t : null);
    if (!svg || !t.dataset || !t.dataset.bc) return;
    e.preventDefault();
    initBarcodeDrag(svg, t.dataset.bc, e);
  });
  document.addEventListener('mousemove', (e) => {
    if (bcDrag) { e.preventDefault(); applyBarcodeDrag(e); }
  });
  document.addEventListener('mouseup', () => { bcDrag = null; });
}

/* ================= 主题（浅色默认 / 深色 / 跟随系统） ================= */
function applyTheme() {
  const t = state.theme || 'light';
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
function bindTheme() {
  const sel = $('cfg-theme');
  if (!sel) return;
  sel.value = state.theme;
  sel.addEventListener('change', () => {
    state.theme = sel.value;
    applyTheme();
    renderLayout(); // 展开图预览配色随主题切换
  });
  // 跟随系统：系统深浅色变化时实时切换（system 模式）
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme();
  });
}

/* ================= 质检（本地规则 + AI 视觉） ================= */
let lastQcItems = [];

/** EAN-13 校验位验证 */
function checkEan13(v) {
  const d = v.split('').map(Number);
  if (d.length !== 13) return false;
  const sum = d.slice(0, 12).reduce((s, x, i) => s + x * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}

/** UPC-A 校验位验证（12 位：11 位数据 + 1 位校验，权重 3,1 交替且首位乘 3） */
function checkUpcA(v) {
  const d = v.split('').map(Number);
  if (d.length !== 12) return false;
  const sum = d.slice(0, 11).reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[11];
}

/** 本地规则质检：主视觉/必印信息/条码/出血/文字溢出/gs */
function runQualityCheck() {
  const items = [];
  const push = (level, msg) => items.push({ level, msg });
  const marketNames = { cn: '中国内销', eu: '欧盟', us: '美国' };

  if (!state.currentImage) {
    push('fail', '尚未生成主视觉图（先点「✨ 生成主视觉」）');
  }
  if (state.markets.size) {
    const names = [...state.markets].map((m) => marketNames[m] || m).join('、');
    if (!state.compAuto) {
      push('warn', `已选目标市场（${names}）但未开启合规自动排版，导出稿将缺必印信息`);
    } else {
      if (!state.compFields.name) push('fail', `合规块已启用但「品名」未填写（${names} 市场必印）`);
      if (state.markets.has('eu') && !state.compFields.warning) push('fail', '欧盟市场必填「年龄/警告语」（TSD 附件 V 要求）');
      if (state.markets.has('us') && !state.compFields.sku) push('warn', '美国市场建议填「货号」（Tracking Label 追溯）');
      if (state.markets.has('cn') && !state.compFields.standard) push('warn', '中国内销建议填「执行标准」（如 GB 6675）');
    }
  } else {
    push('warn', '未选择目标市场（合规清单为空）');
  }
  if (state.barcode) {
    const v = state.barcode.value;
    if (state.barcode.format === 'EAN13') {
      if (!/^\d{13}$/.test(v)) push('fail', 'EAN-13 条码需 13 位数字');
      else if (!checkEan13(v)) push('warn', 'EAN-13 校验位不正确，条码将不会被绘制');
    } else if (state.barcode.format === 'UPC' && !/^\d{12}$/.test(v)) {
      push('fail', 'UPC-A 条码需 12 位数字');
    }
  }
  if (!$('opt-bleed').checked) {
    push('warn', 'PNG 导出未勾选 3mm 出血（PDF/X 印刷稿恒带出血）');
  }
  if (state.compAuto) {
    for (const [k, v] of Object.entries(state.compFields)) {
      if (v && v.length > 30) push('warn', `「${k}」内容较长（${v.length} 字），合规块内可能被截断`);
    }
    // 合规面板高度检查：行数放不下时提示（与 drawComplianceBlock 同一套计算，单位用 mm 比值一致）
    try {
      const t = state.templates[state.currentType];
      const layout = t.build(getSize());
      const pid = layout.compliancePanel;
      const p = pid && layout.panels.find((x) => x.id === pid);
      if (p) {
        const rowCount = Object.values(state.compFields).filter((v) => v && v.trim()).length;
        const fs = Math.max(6, p.w * 0.032);
        const sharedBarcode = layout.barcodePanel === pid && !!state.barcode;
        const maxBh = p.h * (sharedBarcode ? 0.5 : 0.85);
        const needH = rowCount * (fs * 1.55) + fs * 1.55 * 0.5;
        if (needH > maxBh) push('warn', `合规面板高度不足以完整容纳 ${rowCount} 行信息（会缩小字号显示）`);
      }
    } catch (e) { /* 模板异常不阻塞质检 */ }
  }
  if (window.__gsAvailable === false) push('warn', 'PDF/X 引擎不可用，印刷稿导出不可用');
  if (!items.some((i) => i.level === 'fail') && !items.some((i) => i.level === 'warn')) {
    push('ok', '基础检查全部通过：主视觉就绪、必印信息齐全、条码有效、出血就绪');
  }
  lastQcItems = items;
  return items;
}

/** 渲染质检报告 */
function renderQc(items) {
  const wrap = $('qc-items');
  if (!items || !items.length) {
    wrap.innerHTML = '<div class="hint">点击「✅ 本地质检」运行检查</div>';
    return;
  }
  const fail = items.filter((i) => i.level === 'fail').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const head = fail ? `❌ ${fail} 项未通过 · ${warn} 项警告` : (warn ? `⚠ ${warn} 项警告` : '✅ 全部通过');
  wrap.innerHTML = `<div class="hint">${head}</div>` + items
    .map((i) => `<div class="qc-item ${i.level}">${i.level === 'fail' ? '❌' : i.level === 'warn' ? '⚠' : '✅'} ${escXml(i.msg)}</div>`)
    .join('');
}

/** 导出前强制检查：fail 阻止；warn 两段确认（再点一次导出即继续，避免原生 confirm 卡输入法）
 * type：'png' | 'pdfx'，两段确认按导出类型区分（PNG 确认后不会跳过 PDF/X 的确认） */
let exportArmed = null;
function qcGate(type) {
  const items = runQualityCheck();
  renderQc(items);
  const fails = items.filter((i) => i.level === 'fail');
  const warns = items.filter((i) => i.level === 'warn');
  if (fails.length) {
    exportArmed = null;
    return `❌ 质检未通过（${fails.length} 项）：\n- ${fails.map((f) => f.msg).join('\n- ')}`;
  }
  if (warns.length) {
    if (exportArmed !== type) {
      exportArmed = type;
      setTimeout(() => { if (exportArmed === type) exportArmed = null; }, 3000);
      return `⚠ 质检有 ${warns.length} 项警告：\n- ${warns.map((w) => w.msg).join('\n- ')}\n（再点一次导出按钮即继续）`;
    }
    exportArmed = null;
  }
  return null;
}

/** 图片压缩（视觉质检发送前，512px JPEG） */
function compressForVision(dataUrl, max = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = dataUrl;
  });
}

/** AI 视觉质检：doubao-vision 检查生成图有无文字/水印/畸形 */
async function runVisionCheck() {
  const status = $('gen-status');
  if (!state.currentImage) {
    status.textContent = '❌ 请先生成主视觉图';
    status.className = 'status err';
    return;
  }
  const apiKey = $('cfg-visionApiKey').value.trim();
  const visionModel = $('cfg-visionModel').value.trim();
  const visionBaseUrl = $('cfg-visionBaseUrl').value.trim();
  if (!apiKey) {
    status.textContent = '❌ 请先在设置中填写「视觉质检 API Key」（小米 MiMo 或其他视觉模型自己的 Key）';
    status.className = 'status err';
    return;
  }
  if (!lockGen()) {
    status.textContent = '⏳ 已有生成/质检任务进行中，请等待完成';
    status.className = 'status';
    return;
  }
  status.textContent = '🕐 AI 视觉质检中（约 5-15 秒）…';
  status.className = 'status';
  genProgress('🕐 AI 视觉质检中（约 5-15 秒）…', -1);
  genTimerStart();
  try {
    const small = await compressForVision(state.currentImage);
    const res = await window.api.visionCheck({ dataUrl: small, visionModel, visionBaseUrl, visionApiKey: apiKey });
    const p = res.parsed;
    if (!p) {
      renderQc([{ level: 'warn', msg: `视觉质检未返回结构化结果：${(res.raw || '').slice(0, 120)}` }]);
      status.textContent = '⚠ 视觉质检返回异常，请查看报告';
      status.className = 'status';
      return;
    }
    const items = [];
    if (p.hasText) items.push({ level: 'fail', msg: '🖼 图中检测到文字/数字（包装主视觉不应有文字，建议重新生成）' });
    if (p.hasWatermark) items.push({ level: 'warn', msg: '🖼 图中检测到水印/logo' });
    if (p.hasDeformity) items.push({ level: 'fail', msg: '🖼 主体疑似畸形残缺（多余手指/五官错乱）' });
    if (!items.length) items.push({ level: 'ok', msg: `🖼 视觉质检通过：无文字、无水印、主体正常（${p.notes || ''}）` });
    renderQc(items);
    lastQcItems = lastQcItems.concat(items);
    status.textContent = '✅ 视觉质检完成';
    status.className = 'status ok';
  } catch (err) {
    status.textContent = '❌ ' + err.message;
    status.className = 'status err';
  } finally {
    genProgressDone();
    unlockGen();
  }
}

/* ================= 导出 PNG（300dpi） ================= */
async function exportPng() {
  const status = $('gen-status');
  const gate = qcGate('png'); // 导出前质检：fail 阻止 / warn 确认
  if (gate) {
    status.textContent = gate;
    status.className = 'status err';
    return;
  }
  let scale = 300 / 25.4; // 300dpi
  const bleed = $('opt-bleed').checked ? 3 : 0;
  const layout0 = state.templates[state.currentType].build(getSize());
  // 画布上限防御：展开图任一边超 16384px（Chromium canvas 上限）时自动降 dpi（超大尺寸的保险，正常尺寸不触发）
  const maxEdge = (layout0.width + bleed * 2) * scale;
  if (maxEdge > 16384) {
    scale = 16384 / (layout0.width + bleed * 2); // 直接按 16384px 反推 dpi
    const dpi = Math.round(scale * 25.4);
    const s0 = $('gen-status');
    s0.textContent = `⚠ 展开图较大，导出分辨率已自动降至 ${dpi} dpi（浏览器画布上限保护）`;
    s0.className = 'status';
  }
  const svgText = buildSvg(scale, { bleed, showLabel: false });
  // Blob URL 替代超长 data URL：2K/4K 图内嵌的 SVG data URL 可达 20MB+，Blob 加载更快且无长度限制
  const svgUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));

  status.textContent = '🕐 正在渲染高清图…';
  status.className = 'status';
  try {
    const img = new Image();
    img.src = svgUrl;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG 渲染失败'));
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'dark' ? '#2a3140' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const t = state.templates[state.currentType];
    const res = await window.api.saveFile({
      defaultName: `${t.id}_${bleed ? 'bleed3mm_' : ''}${Date.now()}.png`,
      dataBase64: canvas.toDataURL('image/png'),
    });
    status.textContent = res.saved ? `✅ 已保存：${res.filePath}` : '已取消保存';
    status.className = res.saved ? 'status ok' : 'status';
  } catch (err) {
    status.textContent = '❌ 导出失败：' + err.message;
    status.className = 'status err';
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/* ================= 导出印刷 PDF/X（PDF/X-3 + CMYK + 3mm 出血） ================= */
async function exportPdfX() {
  const status = $('gen-status');
  const gate = qcGate('pdfx'); // 导出前质检：fail 阻止 / warn 确认
  if (gate) {
    status.textContent = gate;
    status.className = 'status err';
    return;
  }
  const t = state.templates[state.currentType];
  const layout = t.build(getSize());
  const scale = 300 / 25.4;
  const bleed = 3; // 印刷稿恒带出血
  const svg = buildSvg(scale, { bleed, showLabel: false });
  const widthMm = layout.width + bleed * 2;
  const heightMm = layout.height + bleed * 2;

  status.textContent = '🕐 正在生成印刷稿（printToPDF → Ghostscript 转 PDF/X-3 + CMYK）…';
  status.className = 'status';
  try {
    const res = await window.api.exportPdfX({
      svg, widthMm, heightMm,
      defaultName: `${t.id}_print_${Date.now()}.pdf`,
    });
    status.textContent = res.saved ? `✅ 印刷稿已保存：${res.filePath}` : '已取消保存';
    status.className = res.saved ? 'status ok' : 'status';
  } catch (err) {
    status.textContent = '❌ ' + err.message;
    status.className = 'status err';
  }
}

/** 自定义像素归一化：兼容 x / × / * / X 分隔（如 2048*2048、1920×1080 → 1920x1080）；非法返回空串 */
function normSize(s) {
  const v = String(s || '').trim().replace(/[×*xX]/g, 'x');
  return /^\d+x\d+$/.test(v) ? v : '';
}

/** 当前生效的图片尺寸：选择器计算值或自定义输入值 */
function getEffectiveSize() {
  const ratio = $('cfg-ratio').value;
  const quality = $('cfg-quality').value;
  if (ratio !== 'custom' && quality !== 'custom') return calcSize(ratio, quality);
  return normSize($('cfg-size').value) || '2048x2048';
}

/* ================= 图片比例 × 清晰度 → 像素 ================= */
const RATIOS = { '1:1': [1, 1], '4:3': [4, 3], '3:4': [3, 4], '3:2': [3, 2], '2:3': [2, 3], '16:9': [16, 9], '9:16': [9, 16], '21:9': [21, 9] };
const QUALITIES = { '720p': 720, '1080p': 1080, '2K': 2048, '4K': 4096 };

/** 比例 × 清晰度 → 像素字符串（短边=清晰度像素，长边按比例，长边封顶 4096） */
function calcSize(ratio, quality) {
  if (RATIOS[ratio] && QUALITIES[quality]) {
    const [rw, rh] = RATIOS[ratio];
    let w, h;
    if (rw >= rh) { h = QUALITIES[quality]; w = Math.round(h * rw / rh); }
    else { w = QUALITIES[quality]; h = Math.round(w * rh / rw); }
    if (Math.max(w, h) > 4096) {
      const scale = 4096 / Math.max(w, h);
      w = Math.round(w * scale); h = Math.round(h * scale);
    }
    return `${w}x${h}`;
  }
  return '2048x2048';
}

/** 从旧像素配置推断 比例+清晰度（匹配不上就 custom） */
function inferRatioQuality(sizeStr) {
  const m = String(sizeStr).match(/^(\d+)x(\d+)$/);
  if (!m) return { ratio: 'custom', quality: 'custom' };
  const w = +m[1], h = +m[2];
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, h);
  let ratio = 'custom';
  for (const [k, [rw, rh]] of Object.entries(RATIOS)) {
    if (w / d === rw && h / d === rh) { ratio = k; break; }
  }
  const short = Math.min(w, h);
  let quality = 'custom';
  for (const [k, p] of Object.entries(QUALITIES)) {
    if (short === p) { quality = k; break; }
  }
  return { ratio, quality };
}

/** 尺寸选择器联动：显示/隐藏自定义输入 + 实时预览 */
function updateSizePreview() {
  const ratio = $('cfg-ratio').value;
  const quality = $('cfg-quality').value;
  const custom = ratio === 'custom' || quality === 'custom';
  $('cfg-size-row').style.display = custom ? '' : 'none';
  let preview;
  if (custom) {
    const v = $('cfg-size').value.trim();
    const nv = normSize(v);
    preview = nv ? `自定义：将生成 ${nv}` : '自定义：输入 宽x高（支持 * 或 ×），如 1920x1080';
  } else {
    preview = `将生成 ${calcSize(ratio, quality)}（${ratio} · ${quality}）`;
  }
  $('size-preview').textContent = preview;
  updateQuickStatus();
}

/* ================= 保存配置 ================= */
async function saveConfig() {
  const ratio = $('cfg-ratio').value;
  const quality = $('cfg-quality').value;
  const size = (ratio === 'custom' || quality === 'custom')
    ? (normSize($('cfg-size').value) || '2048x2048')
    : calcSize(ratio, quality);
  formToProfile(appActiveIdx);
  try {
    await window.api.setConfig({
      profiles: appProfiles,
      activeIndex: appActiveIdx,
      size,
      ratio,
      quality,
      theme: state.theme,
    });
    renderProfileSelect();
    const s = $('gen-status');
    s.textContent = `✅ 设置已保存（图片 ${size}）`;
    s.className = 'status ok';
  } catch (e) {
    const s = $('gen-status');
    s.textContent = '❌ 保存失败：' + (e.message || e);
    s.className = 'status err';
  }
}

/* ================= 测试连接（设置页） ================= */
async function testApi() {
  const out = $('api-test-result');
  out.className = 'hint';
  out.textContent = '⏳ 正在测试文生图接口…';
  const parts = [];
  const imgBase = $('cfg-imageBaseUrl').value.trim();
  const imgKey = $('cfg-apiKey').value.trim();
  const visBase = $('cfg-visionBaseUrl').value.trim();
  const visKey = $('cfg-visionApiKey').value.trim();
  try {
    if (imgBase && imgKey) {
      const r = await window.api.testApi({ baseUrl: imgBase, apiKey: imgKey });
      parts.push(r.ok
        ? `🖼 文生图 ✅ 连通（${r.modelCount != null ? '列表 ' + r.modelCount + ' 个模型' : 'HTTP ' + r.status}${r.sample ? '，如「' + r.sample + '」' : ''}）`
        : `🖼 文生图 ❌ ${r.error || '连接失败'}`);
    } else {
      parts.push('🖼 文生图 ⚠ 未填接口地址或 Key，跳过');
    }
    if (visBase && visKey) {
      const r = await window.api.testApi({ baseUrl: visBase, apiKey: visKey });
      parts.push(r.ok
        ? `👁 视觉质检 ✅ 连通（${r.modelCount != null ? '列表 ' + r.modelCount + ' 个模型' : 'HTTP ' + r.status}${r.sample ? '，如「' + r.sample + '」' : ''}）`
        : `👁 视觉质检 ❌ ${r.error || '连接失败'}`);
    } else {
      parts.push('👁 视觉质检 ⚠ 未填接口地址或 Key，跳过');
    }
    out.textContent = parts.join('　');
  } catch (e) {
    out.textContent = '❌ 测试连接失败：' + (e.message || e);
  }
}

/* ================= 设为使用中（设置页） ================= */
async function setActive() {
  formToProfile(appActiveIdx); // 先把表单当前内容保存到当前档
  try {
    await window.api.setConfig({ profiles: appProfiles, activeIndex: appActiveIdx });
    renderProfileSelect();
    const s = $('gen-status');
    s.textContent = `⭐ 已将「${appProfiles[appActiveIdx].name}」设为使用中（生成与质检均使用该档）`;
    s.className = 'status ok';
    const out = $('api-test-result');
    out.textContent = '⭐ 当前使用中：' + appProfiles[appActiveIdx].name;
    out.className = 'hint';
  } catch (e) {
    const s = $('gen-status');
    s.textContent = '❌ 切换失败：' + (e.message || e);
    s.className = 'status err';
  }
}

/* ================= 缓存管理（设置页） ================= */
function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

async function refreshCacheInfo() {
  const st = $('cache-status');
  try {
    const info = await window.api.cacheInfo();
    st.textContent = info.fileCount
      ? `🧊 图片缓存 ${fmtBytes(info.bytes)}（${info.fileCount} 个文件${info.oldestDays ? '，最老 ' + info.oldestDays + ' 天前' : ''}）`
      : '🧊 图片缓存为空';
  } catch (e) {
    st.textContent = '缓存统计失败：' + (e.message || e);
  }
}

async function cleanCache(days) {
  const btn = days === 0 ? $('btn-cache-cleanAll') : $('btn-cache-clean7');
  const out = $('cache-result');
  // 清空缓存需要二次确认（两段式，避免误删）
  if (days === 0) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = '⚠ 再点一次确认清空';
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = '清空缓存';
      }, 3000);
      return;
    }
    delete btn.dataset.armed;
    btn.textContent = '清空缓存';
  }
  try {
    const r = await window.api.cleanCache(days);
    await refreshCacheInfo();
    out.textContent = days === 0
      ? (r.removed ? `✅ 已清空 ${r.removed} 个缓存文件` : '✅ 缓存已为空')
      : (r.removed ? `✅ 已清理 ${r.removed} 个 ${days} 天前的文件` : '没有早于 ' + days + ' 天的缓存文件');
  } catch (e) {
    out.textContent = '清理失败：' + (e.message || e);
  }
}

window.addEventListener('DOMContentLoaded', init);

// 测试钩子（本地应用，无害暴露，供冒烟测试使用）
window.__app = { state, renderLayout, buildSvg, renderCompliance, renderResults, autoBuildPrompt, loadSchemes, runQualityCheck, renderQc, getSize, checkEan13, generate, updateBarcode, saveConfig, loadScheme, selectBoxType, clampBatchCount, testApi, setActive, applyWatermarkGuard, formToProfile, getActiveIdx: () => appActiveIdx, switchResult, genProgress, genTimerStart, genTimerStop, genProgressDone };
