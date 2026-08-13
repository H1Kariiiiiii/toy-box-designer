/* preview-mock.js - 无 Photoshop 浏览器预览模式（仅开发预览，不进 ZXP 包）
 * 用法：preview/build-preview.ps1 生成 preview/index.html 后，浏览器打开 ps-plugin/preview/index.html
 * 注入三样东西：
 *   1) window.require  —— mock CEP Node（ai.js 用它加载 node/main.js），提供内存版 config/假生图/历史
 *   2) window.CSInterface —— mock PS 桥：所有 PS 操作返回"预览模式：未连接 Photoshop"
 *   3) window.psNode   —— 同 require 返回的对象（settings-panel.js 直接读 window.psNode）
 * 效果：AI 页可"生成"假图（渐变+文字）、3D 页贴图/旋转/截图、设置页可保存（内存）、
 *       模板/合规/条码的 PS 写入按钮提示不可用。 */
(function () {
  'use strict';

  /* ---- 内存配置（默认值与生产 node/main.js 一致） ---- */
  var cfg = {
    apiKey: 'sk-预览模式（不真实调用）',
    imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-5-0-260128',
    size: '2048x2048',
    defaultBoxType: 'tianDiGai',
    defaultSize: { w: 200, d: 130, h: 60 },
    defaultDpi: 300,
    defaultBleed: 3,
  };
  var history = [];
  var tempCount = 3;

  /* ---- 假生成图：渐变 + 文字（seed 决定色相） ---- */
  function fakeImageDataUrl(seed) {
    var c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    var ctx = c.getContext('2d');
    var hue = ((seed || 1) * 47) % 360;
    var g = ctx.createLinearGradient(0, 0, 256, 256);
    g.addColorStop(0, 'hsl(' + hue + ',70%,68%)');
    g.addColorStop(1, 'hsl(' + ((hue + 70) % 360) + ',70%,42%)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('预览模式生成图', 128, 118);
    ctx.font = '15px "Microsoft YaHei", sans-serif';
    ctx.fillText('seed=' + seed, 128, 150);
    return c.toDataURL('image/png');
  }

  function fakeGenerate(opts) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var seed = opts.seed || (Math.floor(Math.random() * 90000) + 10000);
        var img = fakeImageDataUrl(seed);
        recordHistory({
          time: new Date().toISOString(),
          prompt: String(opts.prompt || '').slice(0, 200),
          model: opts.model || cfg.model,
          size: opts.size || cfg.size,
          seed: seed,
          count: 1,
        });
        resolve({ images: [{ dataUrl: img }], usage: null });
      }, 400);
    });
  }

  function recordHistory(e) {
    history.unshift(e);
    if (history.length > 200) history.length = 200;
  }

  /* ---- psNode mock（对应 node/main.js 导出） ---- */
  var psNode = {
    getConfig: function () { return JSON.parse(JSON.stringify(cfg)); },
    saveConfig: function (patch) {
      Object.keys(patch || {}).forEach(function (k) { cfg[k] = patch[k]; });
      return cfg;
    },
    generateImage: fakeGenerate,
    preparePlaceImage: function (dataUrl) {
      return { path: '预览模式-临时文件.png', mime: 'image/png', bytes: String(dataUrl || '').length };
    },
    recordHistory: recordHistory,
    getHistory: function () { return history; },
    clearHistory: function () { history = []; return true; },
    getTempStats: function () { return { count: tempCount, bytes: 1234567, dir: '预览模式（无真实文件）' }; },
    clearTempFiles: function () { var n = tempCount; tempCount = 0; return { removed: n }; },
  };

  /* ---- require mock（ai.js 加载 node/main.js 用） ---- */
  window.require = function (p) {
    if (/node\/main\.js$/.test(String(p))) return psNode;
    throw new Error('预览模式：未提供模块 ' + p);
  };

  /* ---- CSInterface mock（PS 操作返回不可用提示） ---- */
  window.CSInterface = {
    evalScript: function (script, cb) {
      setTimeout(function () {
        cb('{"ok":false,"error":"预览模式：未连接 Photoshop（仅 UI 与 3D 可预览）"}');
      }, 50);
    },
  };

  window.psNode = psNode;
  window.__PREVIEW__ = true;
})();
