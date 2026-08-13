/* main.js - CEP Node 代理（M2：AI 生图）
 * 运行环境：CEP 8（Node 7.7.4）/ CEP 9（Node 8.6），由面板 JS 通过 require('./node/main.js') 加载
 * 职责：配置读写（%APPDATA%\ToyBoxDesignerPlugin\config.json）、AI 文生图代理（OpenAI 兼容）、
 *       图片临时文件准备（供 host.jsx 的 placeImage 命令放置入文档）。
 * 兼容性约束（Node 7.7/8.6）：
 *  - 无 fetch / AbortController → 用内置 http/https 模块 + setTimeout 手动超时
 *  - 无可选链 ?. / 空合并 ?? / Object.entries / String.padStart / crypto.randomUUID
 *  - fs.mkdirSync 无 recursive 选项 → 手写 mkdirp
 *  - async/await 可用（Node 7.6+），Promise / 模板字符串 / const 可用
 * 网络请求统一走这里（面板 XHR 跨域受限）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var os = require('os');
var urlMod = require('url');

var DEFAULT_CONFIG = {
  apiKey: '',                                    // 文生图 API Key（与独立版同一 key 可复用）
  imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', // OpenAI 兼容文生图接口（火山方舟默认，可换任意平台）
  model: 'doubao-seedream-5-0-260128',           // 模型 ID（与独立版默认一致）
  size: '2048x2048',                             // 生成尺寸（像素或平台档位 2K/4K，透传）
  // M6：默认文档参数（模板页/设置页联动）
  defaultBoxType: 'tianDiGai',                   // 默认盒型
  defaultSize: { w: 200, d: 130, h: 60 },        // 默认盒型长宽高（mm）
  defaultDpi: 300,                               // 默认分辨率
  defaultBleed: 3,                               // 默认出血（mm）
};

var MAX_JSON_RESPONSE = 64 * 1024 * 1024;  // 文生图 JSON（含 b64_json）上限
var MAX_IMAGE_DOWNLOAD = 64 * 1024 * 1024; // 图片 url 下载上限

/* ================= 配置读写 ================= */
function configDir() {
  var base = process.env.APPDATA || (process.env.HOME || '');
  return path.join(base, 'ToyBoxDesignerPlugin');
}
function configPath() {
  return path.join(configDir(), 'config.json');
}

function clone(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) {
    var v = obj[k];
    // 深拷贝嵌套对象（defaultSize 等），防共享引用污染默认值
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      var nv = {};
      Object.keys(v).forEach(function (k2) { nv[k2] = v[k2]; });
      out[k] = nv;
    } else {
      out[k] = v;
    }
  });
  return out;
}

/** 读配置：文件不存在/损坏时返回默认值（不抛错） */
function getConfig() {
  var cfg = clone(DEFAULT_CONFIG);
  try {
    var raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    Object.keys(raw).forEach(function (k) { cfg[k] = raw[k]; });
  } catch (e) { /* 首次运行或文件损坏：用默认值 */ }
  return cfg;
}

/** 原子写配置：先写临时文件再 rename，避免崩溃损坏 config.json */
function saveConfig(patch) {
  var cfg = getConfig();
  Object.keys(patch || {}).forEach(function (k) { cfg[k] = patch[k]; });
  mkdirp(configDir());
  var tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, configPath());
  return cfg;
}

/* ================= 工具 ================= */
/** 递归建目录（Node 7/8 的 fs.mkdirSync 无 recursive 选项）
 * 实现：path.parse 取 root（'C:\' 或 '\\server\share\'），去掉 root 后的相对段逐级拼接创建；
 * 不能把盘符段 'C:' 再拼进 root（path.join('C:\','C:') 会得到非法路径）。 */
function mkdirp(dir) {
  if (!dir) return;
  var abs = path.resolve(dir);
  var root = path.parse(abs).root || path.sep;
  var parts = abs.slice(root.length).split(path.sep);
  var cur = root;
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    cur = path.join(cur, parts[i]);
    try { fs.mkdirSync(cur); } catch (e) { /* 已存在则忽略 */ }
  }
}

/** 按魔数识别 PNG/JPEG，返回 { mime, ext }；非图片返回 null */
function detectImageFormat(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  return null;
}

/** 简易随机串（Node 7/8 无 crypto.randomUUID） */
function randId() {
  return Date.now().toString(36) + '_' + Math.floor(Math.random() * 0xffffff).toString(36);
}

/* ================= HTTP 请求（无 fetch 版） ================= */
/**
 * 发起请求并收集完整响应体（带超时与体积上限）。
 * @param {string} url 完整 URL（仅 http/https）
 * @param {object} opts { method, headers, body, timeoutMs, maxBytes, label }
 * @returns Promise<{ status, headers, body: Buffer }>
 */
function request(url, opts) {
  return new Promise(function (resolve, reject) {
    var o = opts || {};
    var u;
    try { u = new urlMod.URL(String(url)); } catch (e) {
      reject(new Error('无效的接口地址: ' + url));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('仅允许 http/https 请求'));
      return;
    }
    var mod = u.protocol === 'https:' ? https : http;
    var timeoutMs = o.timeoutMs || 120000;
    var maxBytes = o.maxBytes || MAX_JSON_RESPONSE;
    var label = o.label || '';
    var done = false;

    var req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: o.method || 'GET',
      headers: o.headers || {},
    }, function (res) {
      // 拒绝重定向（3xx）：防凭据跟随外泄，与独立版 safeFetch redirect:'error' 行为一致
      if (res.statusCode >= 300 && res.statusCode < 400) {
        done = true;
        clearTimeout(timer);
        req.abort();
        reject(new Error((label || '请求') + '遇到重定向（HTTP ' + res.statusCode + '），已拒绝'));
        return;
      }
      var chunks = [];
      var total = 0;
      res.on('data', function (c) {
        total += c.length;
        if (total > maxBytes) {
          done = true;
          clearTimeout(timer);
          req.abort();
          reject(new Error('响应体过大（超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB）'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', function (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error((label ? label + '失败：' : '') + (e && e.message ? e.message : String(e))));
    });
    // 独立总超时计时器：覆盖连接建立（req.setTimeout 仅对已连接 socket 的空闲生效，
    // connect 挂起时无兜底；Node 7/8 亦然），超时后 abort 并报友好中文错误
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      req.abort();
      reject(new Error((label || '请求') + '超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒）'));
    }, timeoutMs);
    if (o.body) req.write(o.body);
    req.end();
  });
}

/* ================= AI 文生图（OpenAI 兼容） ================= */
/**
 * 文生图。默认火山方舟 Seedream（与独立版同 key/模型可复用），接口 OpenAI 兼容可换任意平台。
 * @param {object} opts { prompt, model, size, seed, maxImages, apiKey, baseUrl }
 * @returns Promise<{ images:[{dataUrl}], usage }>
 */
async function generateImage(opts) {
  if (!opts || !opts.apiKey) throw new Error('尚未配置 API Key，请在「AI 生成」页的接口设置中填写');
  var prompt = String(opts.prompt || '').trim();
  if (!prompt) throw new Error('提示词为空');
  var model = String(opts.model || '').trim();
  if (!model) throw new Error('未配置模型 ID');
  var base = String(opts.baseUrl || DEFAULT_CONFIG.imageBaseUrl).trim().replace(/\/+$/, '');
  var size = String(opts.size || DEFAULT_CONFIG.size).trim() || '2048x2048';
  var maxImages = Math.min(6, Math.max(1, Number(opts.maxImages) || 1));

  var body = {
    model: model,
    prompt: prompt,
    size: size,
    n: 1,
    response_format: 'b64_json',
  };
  // seed 必须为整数（OpenAI 兼容 schema 拒绝字符串）；非法/超范围忽略（面板已前置校验，这里兜底）
  if (opts.seed !== undefined && opts.seed !== '' && opts.seed !== null) {
    var seedNum = Number(opts.seed);
    if (isFinite(seedNum) && seedNum >= 1 && seedNum <= 2147483647) {
      body.seed = seedNum;
    }
  }
  // 组图（一次多张）仅火山方舟支持：独立版同款参数
  if (/volces\.com|volcengine/i.test(base) && maxImages > 1) {
    body.sequential_image_generation = 'auto';
    body.sequential_image_generation_options = { max_images: maxImages };
  }

  // 超时按张数动态计算（组图/4K 远高于单图）
  var apiTimeout = 120000 + Math.max(0, maxImages - 1) * 60000;
  var resp = await request(base + '/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + opts.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeoutMs: apiTimeout,
    maxBytes: MAX_JSON_RESPONSE,
    label: '文生图',
  });

  var json = null;
  try { json = JSON.parse(resp.body.toString('utf8')); } catch (e) { /* 解析失败按空处理 */ }
  if (resp.status < 200 || resp.status >= 300 || !json || !json.data || !json.data.length) {
    var msg = json && json.error && json.error.message ? json.error.message : JSON.stringify(json);
    throw new Error('文生图 API 调用失败（HTTP ' + resp.status + '）：' + msg);
  }

  var images = [];
  for (var i = 0; i < json.data.length; i++) {
    var d = json.data[i];
    var buf = null;
    var det = null;
    if (d.b64_json) {
      buf = Buffer.from(d.b64_json, 'base64');
    } else if (d.url) {
      var imgResp = await request(String(d.url), {
        timeoutMs: 120000,
        maxBytes: MAX_IMAGE_DOWNLOAD,
        label: '图片下载',
      });
      if (imgResp.status < 200 || imgResp.status >= 300) throw new Error('图片下载失败（HTTP ' + imgResp.status + '）');
      buf = imgResp.body;
    }
    if (!buf) continue;
    det = detectImageFormat(buf);
    if (!det) throw new Error('API 返回了非图片数据');
    images.push({ dataUrl: 'data:' + det.mime + ';base64,' + buf.toString('base64') });
  }
  if (!images.length) throw new Error('文生图 API 未返回任何图片');

  // M6：成功即入历史（参数 + 时间，上限 200 条；含临时图 7 天自动清理）
  recordHistory({
    time: new Date().toISOString(),
    prompt: prompt.slice(0, 200),
    model: model,
    size: size,
    seed: body.seed !== undefined ? body.seed : null,
    count: images.length,
  });

  return { images: images, usage: json.usage || null };
}

/* ================= 图片临时文件准备（供 host.jsx placeImage） ================= */
/**
 * 把 dataURL 图片写入临时目录，返回文件路径（host.jsx 用 new File() 放置）。
 * @param {string} dataUrl data:image/png;base64,... 或 data:image/jpeg;base64,...
 * @returns { path, mime, bytes }
 */
function preparePlaceImage(dataUrl) {
  var m = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) throw new Error('图片数据格式无效（需 base64 dataURL）');
  var buf = Buffer.from(m[2], 'base64');
  var det = detectImageFormat(buf);
  if (!det) throw new Error('图片数据不是有效的 PNG/JPEG');
  var dir = path.join(os.tmpdir(), 'toybox_psplugin');
  mkdirp(dir);
  cleanupOldTempFiles(dir); // 顺带清理 7 天前的旧临时图，防长期堆积
  var filePath = path.join(dir, 'place_' + randId() + '.' + det.ext);
  fs.writeFileSync(filePath, buf);
  return { path: filePath, mime: det.mime, bytes: buf.length };
}

/** 清理临时目录中超过 7 天的旧文件（失败静默） */
function cleanupOldTempFiles(dir) {
  var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  var names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (var i = 0; i < names.length; i++) {
    var p = path.join(dir, names[i]);
    try {
      var st = fs.statSync(p);
      // Node 7.7 无 st.mtimeMs（Node 8.1+ 才有），用 mtime.getTime()
      if (st.isFile() && st.mtime.getTime() < cutoff) fs.unlinkSync(p);
    } catch (e) { /* 忽略单文件失败 */ }
  }
}

/* ================= 生成历史 / 临时文件管理（M6） ================= */
var HISTORY_MAX = 200;

function historyPath() {
  return path.join(configDir(), 'history', 'history.json');
}

/** 记录一次生成（入列头部，上限 HISTORY_MAX 条）；失败静默 */
function recordHistory(entry) {
  var arr = [];
  try { arr = JSON.parse(fs.readFileSync(historyPath(), 'utf8')); } catch (e) { /* 首次/损坏 */ }
  if (!Array.isArray(arr)) arr = [];
  arr.unshift(entry);
  if (arr.length > HISTORY_MAX) arr = arr.slice(0, HISTORY_MAX);
  try {
    mkdirp(path.dirname(historyPath()));
    fs.writeFileSync(historyPath(), JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
}

/** 历史列表（最新在前；过滤损坏/非对象条目） */
function getHistory() {
  var arr = [];
  try { arr = JSON.parse(fs.readFileSync(historyPath(), 'utf8')); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter(function (it) { return it && typeof it === 'object' && typeof it.time === 'string'; });
}

/** 清空历史 */
function clearHistory() {
  try { fs.unlinkSync(historyPath()); return true; } catch (e) { return false; }
}

/** 临时目录统计（数量/字节） */
function getTempStats() {
  var dir = path.join(os.tmpdir(), 'toybox_psplugin');
  var count = 0, bytes = 0;
  try {
    var names = fs.readdirSync(dir);
    for (var i = 0; i < names.length; i++) {
      var st = fs.statSync(path.join(dir, names[i]));
      if (st.isFile()) { count++; bytes += st.size; }
    }
  } catch (e) { /* 目录不存在 */ }
  return { count: count, bytes: bytes, dir: dir };
}

/** 清理临时文件（全部），返回删除数 */
function clearTempFiles() {
  var dir = path.join(os.tmpdir(), 'toybox_psplugin');
  var removed = 0;
  try {
    var names = fs.readdirSync(dir);
    for (var i = 0; i < names.length; i++) {
      var p = path.join(dir, names[i]);
      var st = fs.statSync(p);
      if (st.isFile()) { fs.unlinkSync(p); removed++; }
    }
  } catch (e) { /* 目录不存在 */ }
  return { removed: removed };
}

/* ================= 导出（供面板 require） ================= */
module.exports = {
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  getConfig: getConfig,
  saveConfig: saveConfig,
  generateImage: generateImage,
  preparePlaceImage: preparePlaceImage,
  recordHistory: recordHistory,
  getHistory: getHistory,
  clearHistory: clearHistory,
  getTempStats: getTempStats,
  clearTempFiles: clearTempFiles,
  _internals: { detectImageFormat: detectImageFormat, mkdirp: mkdirp, request: request },
};
