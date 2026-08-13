/* settings-panel.js - 设置页逻辑（M6，F6）
 * 兼容：CEP 8/9（Chromium 57/61，ES5）。配置统一从 psNode（node/main.js）读写：
 * 文生图（key/接口/模型/默认尺寸）+ 默认文档参数（盒型/尺寸/DPI/出血）+ 历史管理 + 临时文件清理 + 关于。 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var st = window.psState || (window.psState = {});
  var statusEl = $('set-status');

  function setStatus(msg, ok) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (ok ? ' ok' : (ok === false ? ' err' : ''));
  }

  /* ---- 加载配置到表单 ---- */
  function loadConfig() {
    if (!window.psNode) { setStatus('⚠ CEP Node 不可用，设置无法读写', false); return; }
    var cfg = window.psNode.getConfig();
    $('set-apikey').value = cfg.apiKey || '';
    $('set-baseurl').value = cfg.imageBaseUrl || '';
    $('set-model').value = cfg.model || '';
    $('set-size').value = cfg.size || '2048x2048';
    $('set-boxtype').value = cfg.defaultBoxType || 'tianDiGai';
    $('set-bw').value = (cfg.defaultSize && cfg.defaultSize.w) || 200;
    $('set-bd').value = (cfg.defaultSize && cfg.defaultSize.d) || 130;
    $('set-bh').value = (cfg.defaultSize && cfg.defaultSize.h) || 60;
    $('set-dpi').value = cfg.defaultDpi || 300;
    $('set-bleed').value = cfg.defaultBleed || 3;
  }

  /* ---- 保存配置（校验后写 config.json） ---- */
  function saveConfig() {
    if (!window.psNode) { setStatus('⚠ CEP Node 不可用', false); return; }
    var dpi = Number($('set-dpi').value);
    var bleed = Number($('set-bleed').value);
    if (!(dpi >= 72 && dpi <= 1200)) { setStatus('DPI 需在 72~1200 之间', false); return; }
    if (!(bleed >= 0 && bleed <= 50)) { setStatus('出血需在 0~50mm 之间', false); return; }
    var w = Number($('set-bw').value), d = Number($('set-bd').value), h = Number($('set-bh').value);
    if (!(w >= 10 && w <= 800 && d >= 10 && d <= 800 && h >= 10 && h <= 800)) {
      setStatus('盒型长/宽/高需在 10~800mm 之间', false);
      return;
    }
    try {
      window.psNode.saveConfig({
        apiKey: $('set-apikey').value.trim(),
        imageBaseUrl: $('set-baseurl').value.trim(),
        model: $('set-model').value.trim(),
        size: $('set-size').value,
        defaultBoxType: $('set-boxtype').value,
        defaultSize: { w: w, d: d, h: h },
        defaultDpi: dpi,
        defaultBleed: bleed,
      });
      // 同步 psState（模板页/AI 页即时生效）
      st.boxType = $('set-boxtype').value;
      st.size = { w: w, d: d, h: h };
      st.dpi = dpi;
      st.bleed = bleed;
      // 同步 AI 页生成尺寸下拉（存在则更新，即时生效）
      var aiSize = document.getElementById('ai-size');
      if (aiSize) aiSize.value = $('set-size').value;
      setStatus('✅ 设置已保存（写 %APPDATA%\\ToyBoxDesignerPlugin\\config.json）', true);
    } catch (e) {
      setStatus('❌ 保存失败：' + (e && e.message || e), false);
    }
  }
  $('btn-set-save').addEventListener('click', saveConfig);

  /* ---- 历史管理 ---- */
  function refreshHistory() {
    if (!window.psNode) return;
    var h = window.psNode.getHistory();
    var el = $('set-history');
    var p0 = h.length ? String(h[0].prompt || '') : '';
    el.textContent = h.length
      ? '共 ' + h.length + ' 条生成记录（最近：' + fmtTime(h[0].time) + '，' + p0.slice(0, 20) + (p0.length > 20 ? '…' : '') + '）'
      : '暂无生成记录';
    el.className = 'hint' + (h.length ? '' : ' muted');
  }
  function fmtTime(iso) {
    try {
      var t = new Date(iso);
      return (t.getMonth() + 1) + '/' + t.getDate() + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
    } catch (e) { return ''; }
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  $('btn-set-clear-history').addEventListener('click', function () {
    if (!window.psNode) return;
    var ok = window.psNode.clearHistory();
    refreshHistory();
    setStatus(ok ? '🗑 生成历史已清空' : '⚠ 清空失败（history.json 不存在或无法删除）', ok);
  });

  /* ---- 临时文件 ---- */
  function refreshTemp() {
    if (!window.psNode) return;
    var t = window.psNode.getTempStats();
    var el = $('set-temp');
    el.textContent = t.count
      ? t.count + ' 个文件，' + (t.bytes / 1024 / 1024).toFixed(1) + 'MB（' + t.dir + '）'
      : '无残留临时文件';
    el.className = 'hint' + (t.count ? '' : ' muted');
    el.title = t.dir;
  }
  $('btn-set-clear-temp').addEventListener('click', function () {
    if (!window.psNode) return;
    var r = window.psNode.clearTempFiles();
    refreshTemp();
    setStatus('🗑 已清理 ' + r.removed + ' 个临时文件', true);
  });

  /* ---- 初始化 ---- */
  window.psState = st;
  loadConfig();
  refreshHistory();
  refreshTemp();
})();
