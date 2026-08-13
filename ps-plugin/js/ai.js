/* ai.js - AI 生成页逻辑（M2：CEP Node 代理 → 缩略图 → 一键入文档）
 * 兼容：CEP 8/9（Chromium 57/61，ES5 语法）；Node 代理经 require('./node/main.js') 加载。
 * 网络请求全部走 CEP Node 侧（面板 XHR 跨域受限）。 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  /* ---- CEP Node 代理加载（--enable-nodejs 注入 require） ----
   * 注意：CEP 8（Node 7.7.4）的 require 只认绝对路径（相对路径失效），
   * 用 window.location.pathname 推导扩展根目录。 */
  var nodeMain = null;
  var nodeError = '';
  try {
    var _loc = window.location.pathname;
    var _extDir;
    try { _extDir = decodeURI(_loc.substring(1, _loc.lastIndexOf('/'))); } catch (e3) { _extDir = ''; }
    nodeMain = require(_extDir + '/node/main.js');
  } catch (e) {
    try { nodeMain = require('./node/main.js'); } catch (e2) { /* 双保险均失败则降级 */ }
    if (!nodeMain) nodeError = String(e && e.message || e);
  }

  /* ---- 状态 ---- */
  var state = {
    images: [],       // [{ dataUrl, tag }]
    active: -1,       // 选中缩略图下标
    lastSeed: null,   // 最近一次成功生成的 seed
    busy: false,      // 生成锁
  };

  var statusEl = $('ai-status');
  var thumbsEl = $('ai-thumbs');
  var actionsEl = $('ai-actions');
  var placeInfoEl = $('ai-place-info');

  function setStatus(msg, ok) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (ok ? ' ok' : (ok === false ? ' err' : ''));
  }

  /* ---- 接口配置（M6：统一由「设置」页管理，这里只读共享 config） ---- */
  function genCfg() {
    var cfg = nodeMain ? nodeMain.getConfig() : {};
    return {
      apiKey: cfg.apiKey || '',
      baseUrl: cfg.imageBaseUrl || '',
      model: cfg.model || '',
      size: $('ai-size').value || cfg.size || '2048x2048',
    };
  }

  /* ---- 提示词组装（复用独立版风格逻辑） ---- */
  function buildPrompt() {
    var subject = $('ai-prompt').value.trim();
    if (!subject) return '';
    var style = $('ai-style').value.trim() || '可爱卡通';
    return subject + '，' + style + '风格，玩具包装盒主视觉插画，干净背景，色彩明亮，无文字无水印';
  }

  /* ---- seed 校验（与独立版一致：1~2147483647 整数） ---- */
  function parseSeed(raw) {
    var s = String(raw || '').trim();
    if (s === '') return null;
    if (!/^\d+$/.test(s)) return null;
    var n = Number(s);
    if (!(n >= 1 && n <= 2147483647)) return null;
    return n;
  }

  /* ---- 生成锁 ---- */
  function lockGen() {
    if (state.busy) return false;
    state.busy = true;
    setGenButtonsDisabled(true);
    return true;
  }
  function unlockGen() {
    state.busy = false;
    setGenButtonsDisabled(false);
  }
  function setGenButtonsDisabled(disabled) {
    ['btn-ai-gen', 'btn-ai-reroll', 'btn-ai-batch'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = disabled;
    });
  }

  /* ---- 生成（单次；seed 传 null 表示随机） ---- */
  function doGenerate(seed, label) {
    if (!nodeMain) {
      setStatus('❌ CEP Node 代理不可用：' + nodeError, false);
      return Promise.reject(new Error('node 不可用'));
    }
    if (!lockGen()) {
      setStatus('⏳ 已有生成任务进行中，请等待完成');
      return Promise.resolve();
    }
    var prompt = buildPrompt();
    if (!prompt) {
      setStatus('请填写提示词', false);
      unlockGen();
      return Promise.resolve();
    }
    var size = $('ai-size').value;
    setStatus('🕐 ' + (label || 'AI 生成中') + '（' + size + '，约 15-40 秒）…');
    var cfg = genCfg();
    return nodeMain.generateImage({
      prompt: prompt,
      model: cfg.model,
      size: cfg.size,
      seed: seed === null ? undefined : seed,
      maxImages: 1,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
    }).then(function (res) {
      state.images = res.images;
      state.active = 0;
      if (seed !== null) state.lastSeed = seed;
      renderThumbs();
      setStatus('✅ 已生成 ' + res.images.length + ' 张' + (seed !== null ? '（seed=' + seed + '）' : '') + '，点缩略图选中后「放入文档」', true);
      return res;
    }).catch(function (err) {
      setStatus('❌ ' + (err && err.message || err), false);
      return null;
    }).then(function (r) {
      unlockGen();
      return r;
    });
  }

  /* ---- 批量（种子递增，独立版同款：上限 6） ---- */
  function doBatch() {
    if (!nodeMain) {
      setStatus('❌ CEP Node 代理不可用：' + nodeError, false);
      return;
    }
    if (!lockGen()) {
      setStatus('⏳ 已有生成任务进行中，请等待完成');
      return;
    }
    var prompt = buildPrompt();
    if (!prompt) {
      setStatus('请填写提示词', false);
      unlockGen();
      return;
    }
    var n = Math.min(6, Math.max(1, Number($('ai-count').value) || 1));
    var size = $('ai-size').value;
    var cfg = genCfg();
    var baseSeed = Math.floor(Math.random() * 90000) + 10000;
    var images = [];
    var failed = null;
    setStatus('🕐 批量生成中 0/' + n + '（Seed ' + baseSeed + '~' + (baseSeed + n - 1) + '）…');

    function one(i) {
      if (failed) return Promise.resolve();
      if (i >= n) return Promise.resolve();
      setStatus('🕐 批量生成中 ' + (i + 1) + '/' + n + '（Seed ' + (baseSeed + i) + '）…');
      return nodeMain.generateImage({
        prompt: prompt,
        model: cfg.model,
        size: cfg.size,
        seed: baseSeed + i,
        maxImages: 1,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
      }).then(function (res) {
        if (res && res.images && res.images.length) {
          images.push({ dataUrl: res.images[0].dataUrl, tag: 'seed ' + (baseSeed + i) });
        }
        return one(i + 1);
      }).catch(function (err) {
        failed = err;
        return Promise.resolve();
      });
    }

    one(0).then(function () {
      if (images.length) {
        state.images = images;
        state.active = 0;
        state.lastSeed = baseSeed + images.length - 1;
        renderThumbs();
        setStatus(failed
          ? '⚠ 批量部分完成：' + images.length + '/' + n + ' 张已保留（失败：' + failed.message + '）'
          : '✅ 批量完成：' + images.length + ' 张（Seed ' + baseSeed + '~' + (baseSeed + n - 1) + '）', failed ? '' : true);
      } else {
        setStatus('❌ ' + (failed && failed.message || '批量生成失败'), false);
      }
      unlockGen();
    }).catch(function () { // 纯防御：链内已逐项捕获，理论上到不了这里
      unlockGen();
    });
  }

  /* ---- 缩略图渲染 ---- */
  function renderThumbs() {
    thumbsEl.innerHTML = '';
    actionsEl.style.display = state.images.length ? '' : 'none';
    if (!state.images.length) return;
    state.images.forEach(function (img, i) {
      var div = document.createElement('div');
      div.className = 'ai-thumb' + (i === state.active ? ' active' : '');
      div.innerHTML = '<img src="' + img.dataUrl + '" alt="生成图 ' + (i + 1) + '" />' +
        '<div class="thumb-tag">' + (img.tag || ('第 ' + (i + 1) + ' 张')) + '</div>';
      div.addEventListener('click', function () {
        state.active = i;
        renderThumbs();
      });
      thumbsEl.appendChild(div);
    });
    var cur = state.images[state.active];
    if (cur) {
      placeInfoEl.textContent = '已选第 ' + (state.active + 1) + ' 张' + (cur.tag ? '（' + cur.tag + '）' : '');
    }
  }

  /* ---- 放入文档 ---- */
  function placeSelected() {
    if (state.active < 0 || !state.images[state.active]) {
      setStatus('请先生成图片并选中一张缩略图', false);
      return;
    }
    var img = state.images[state.active];
    var xMm, yMm, wMm, hMm;
    // M5：已选盒型时自动放入 front 面板区域（内缩 4mm；开窗盒避开透明窗，贴窗下品牌区）；无盒型时用输入框值
    var stBox = window.psState || {};
    var front = null;
    if (stBox.layout) {
      for (var fi = 0; fi < stBox.layout.panels.length; fi++) {
        if (stBox.layout.panels[fi].id === stBox.layout.panel) { front = stBox.layout.panels[fi]; break; }
      }
    }
    if (front) {
      xMm = front.x + 4; yMm = front.y + 4;
      wMm = front.w - 8; hMm = front.h - 8;
      // 开窗盒：front 面板内有 window 子面板 → 主视觉只贴窗口下方区域（不盖透明窗）
      for (var wi = 0; wi < stBox.layout.panels.length; wi++) {
        var wp = stBox.layout.panels[wi];
        if (wp.kind !== 'window') continue;
        if (wp.x < front.x + front.w && wp.x + wp.w > front.x && wp.y < front.y + front.h && wp.y + wp.h > front.y) {
          yMm = wp.y + wp.h + 4;              // 从窗口底部往下
          hMm = front.y + front.h - 4 - yMm;  // 到 front 底部
          break;
        }
      }
      if (!(hMm > 4)) { xMm = front.x + 4; yMm = front.y + 4; wMm = front.w - 8; hMm = front.h - 8; } // 兜底：区域过小回退整面
    } else {
      xMm = Number($('ai-x').value) || 0;
      yMm = Number($('ai-y').value) || 0;
      wMm = Number($('ai-w').value);
      hMm = Number($('ai-h').value);
      if (!(wMm > 0) || !(hMm > 0)) {
        setStatus('放入位置宽/高必须 > 0（mm）', false);
        return;
      }
    }
    setStatus('📥 准备图片并放入文档（' + Math.round(wMm) + '×' + Math.round(hMm) + 'mm' + (front ? ' @ ' + front.label : '@ ' + xMm + ',' + yMm) + '）…');
    var filePath = '';
    try {
      filePath = nodeMain.preparePlaceImage(img.dataUrl).path;
    } catch (e) {
      setStatus('❌ 图片准备失败：' + (e && e.message || e), false);
      return;
    }
    psbridge.placeImage({
      filePath: filePath,
      xMm: xMm, yMm: yMm, wMm: wMm, hMm: hMm,
      group: '主视觉',
      bleed: (window.psState && window.psState.bleed) || 0,
    }).then(function (r) {
      var msg = '✅ 已放入文档' + (r.actualMm ? '（实际 ' + Math.round(r.actualMm.w * 10) / 10 + '×' + Math.round(r.actualMm.h * 10) / 10 + 'mm，等比缩放 ' + r.scalePct + '%）' : '') + '，图层组「' + (r.group || '主视觉') + '」';
      setStatus(msg, true);
    }).catch(function (e) {
      setStatus('❌ 放入失败：' + e.message, false);
    });
  }

  /* ---- 事件绑定 ---- */
  $('btn-ai-gen').addEventListener('click', function () {
    var seed = parseSeed($('ai-seed').value);
    doGenerate(seed, seed === null ? 'AI 生成中' : 'AI 生成中（seed=' + seed + '）');
  });
  $('btn-ai-reroll').addEventListener('click', function () {
    // 同 seed 再来一张（效果相近可微调）；无 seed 则随机
    var seed = state.lastSeed;
    doGenerate(seed, seed === null ? 'AI 生成中' : 'AI 生成中（seed=' + seed + '，同种子微调）');
  });
  $('btn-ai-batch').addEventListener('click', doBatch);
  $('btn-ai-place').addEventListener('click', placeSelected);

  /* ---- 初始化 ---- */
  // 暴露给其他页签复用（模板页条码入文档等走同一 Node 代理；3D 页读当前生成图）
  window.psNode = nodeMain;
  window.psAiState = state;
  if (!nodeMain) {
    setStatus('⚠ CEP Node 不可用（' + nodeError + '），AI 生成不可用；请确认 manifest 含 --enable-nodejs 且为 PS 2018+', false);
  } else {
    // 生成尺寸默认值取自设置页（config.json）
    try {
      var _cfg0 = nodeMain.getConfig();
      if (_cfg0.size) $('ai-size').value = _cfg0.size;
    } catch (e) { /* 忽略 */ }
  }
})();
