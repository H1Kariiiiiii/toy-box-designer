/* panel.js - 面板主逻辑（M1：页签切换 + PS 连接/文档验证）
 * 兼容：CEP 8/9（Chromium 57/61），ES5 语法。 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  /* ---- 页签切换 ---- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  function switchTab(name) {
    tabs.forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    pages.forEach(function (p) {
      p.classList.toggle('active', p.id === 'page-' + name);
    });
    // 3D 页签激活钩子：容器可见后再初始化/渲染（防隐藏时 0 尺寸）
    if (name === 'preview' && window.toyboxMockup) {
      window.toyboxMockup.init();
      window.toyboxMockup.renderMockup().catch(function () { /* 初始化失败静默，3D 页有按钮可重试 */ });
    }
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
  });

  /* ---- 状态显示 ---- */
  function setStatus(el, msg, ok) {
    el.textContent = msg;
    el.className = 'status' + (ok ? ' ok' : (ok === false ? ' err' : ''));
  }

  /* ---- 测试 PS 连接 ---- */
  var btnPing = $('btn-ping');
  var psStatus = $('ps-status');
  btnPing.addEventListener('click', function () {
    psStatus.textContent = '测试中…';
    psStatus.className = 'ps-status';
    psbridge.ping().then(function (r) {
      psStatus.textContent = '已连接 PS ' + r.ps;
      psStatus.className = 'ps-status ok';
    }).catch(function (e) {
      psStatus.textContent = '连接失败';
      psStatus.className = 'ps-status err';
    });
  });
  // 启动时自动测试一次
  psbridge.ping().then(function (r) {
    psStatus.textContent = '已连接 PS ' + r.ps;
    psStatus.className = 'ps-status ok';
  }).catch(function () {
    psStatus.textContent = '未连接';
    psStatus.className = 'ps-status';
  });

  /* ---- 新建展开图文档（验证 mm→px 换算） ---- */
  var btnDoc = $('btn-create-doc');
  var docStatus = $('doc-status');
  btnDoc.addEventListener('click', function () {
    var w = Number($('doc-w').value);
    var h = Number($('doc-h').value);
    var dpi = Number($('doc-dpi').value);
    var name = $('doc-name').value || '玩具包装展开图';
    setStatus(docStatus, '创建中…');
    psbridge.createDoc({ w: w, h: h, dpi: dpi, name: name }).then(function (r) {
      setStatus(docStatus, '✅ 已创建 ' + r.widthPx + '×' + r.heightPx + 'px @' + dpi + 'dpi（' + r.widthMm + '×' + r.heightMm + 'mm）', true);
    }).catch(function (e) {
      setStatus(docStatus, '❌ ' + e.message, false);
    });
  });

  /* ---- 创建图层组 ---- */
  var btnGrp = $('btn-add-group');
  var grpStatus = $('grp-status');
  btnGrp.addEventListener('click', function () {
    var name = $('grp-name').value || '新图层组';
    setStatus(grpStatus, '创建中…');
    psbridge.createLayerGroup({ name: name }).then(function (r) {
      setStatus(grpStatus, '✅ 图层组「' + r.groupName + '」已创建', true);
    }).catch(function (e) {
      setStatus(grpStatus, '❌ ' + e.message, false);
    });
  });
})();
