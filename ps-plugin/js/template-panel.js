/* template-panel.js - 模板页逻辑（M3，F2 展开图刀模 + F4 条码）
 * 兼容：CEP 8/9（Chromium 57/61，ES5）。依赖 js/templates.js（BoxTemplates）。
 * 共享状态存 window.psState（模板页/合规页/AI 页共用）。 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var PS_DPI = 300; // 插件默认 300dpi（展开图文档按此换算）
  var MM_PER_PX = 25.4 / PS_DPI;

  /* ---- 共享状态 ---- */
  window.psState = window.psState || {
    boxType: 'tianDiGai',
    size: { w: 200, d: 130, h: 60 },
    dpi: PS_DPI,
    bleed: 3,
    layout: null,       // 当前盒型 build(size) 结果（面板坐标 mm）
  };
  var st = window.psState;

  /* ---- 盒型选择 ---- */
  var typeCards = document.querySelectorAll('.box-type-card');
  var boxStatus = $('box-status');
  var boxInfo = $('box-info');

  function setStatus(msg, ok) {
    boxStatus.textContent = msg;
    boxStatus.className = 'status' + (ok ? ' ok' : (ok === false ? ' err' : ''));
  }

  function refreshLayout() {
    var t = BoxTemplates[st.boxType];
    if (!t) return null;
    st.size = {
      w: Number($('size-w').value) || t.defaultSize.w,
      d: Number($('size-d').value) || t.defaultSize.d,
      h: Number($('size-h').value) || t.defaultSize.h,
    };
    st.layout = t.build(st.size);
    var bl = st.bleed;
    boxInfo.textContent = '展开 ' + st.layout.width + '×' + st.layout.height + 'mm' +
      (bl > 0 ? '（含出血 ' + (st.layout.width + bl * 2) + '×' + (st.layout.height + bl * 2) + 'mm）' : '') +
      '｜ 主视觉面：' + (st.layout.panel || '-') +
      '｜ 条码面：' + (st.layout.barcodePanel || '-') +
      '｜ 合规面：' + (st.layout.compliancePanel || '-');
    return st.layout;
  }

  function selectBoxType(id) {
    st.boxType = id;
    typeCards.forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-type') === id);
    });
    var t = BoxTemplates[id];
    if (t) {
      $('size-w').value = t.defaultSize.w;
      $('size-d').value = t.defaultSize.d;
      $('size-h').value = t.defaultSize.h;
    }
    refreshLayout();
  }
  typeCards.forEach(function (c) {
    c.addEventListener('click', function () { selectBoxType(c.getAttribute('data-type')); });
  });
  ['size-w', 'size-d', 'size-h', 'bleed-mm'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      st.bleed = Number($('bleed-mm').value);
      if (!(st.bleed >= 0) || !(st.bleed <= 50)) {
        st.bleed = 3;
        $('bleed-mm').value = st.bleed; // 非法输入回写默认值，UI 与状态同步
      }
      refreshLayout();
    });
  });

  /* ---- 新建展开图文档（M3 盒型工作流；手动创建走 M1 的 btn-create-doc，见 panel.js） ---- */
  $('btn-create-box').addEventListener('click', function () {
    var layout = refreshLayout();
    if (!layout) { setStatus('盒型数据加载失败', false); return; }
    var name = $('doc-name2').value.trim() || (BoxTemplates[st.boxType].name + '_' + st.size.w + 'x' + st.size.d + 'x' + st.size.h);
    setStatus('创建文档中（' + layout.width + '×' + layout.height + 'mm @' + st.dpi + 'dpi' + (st.bleed > 0 ? ' +' + st.bleed + 'mm 出血' : '') + '）…');
    psbridge.createDoc({
      w: layout.width, h: layout.height,
      dpi: st.dpi, bleed: st.bleed, name: name,
    }).then(function (r) {
      setStatus('✅ 已创建 ' + r.widthMm + '×' + r.heightMm + 'mm（含出血）→ ' + r.widthPx + '×' + r.heightPx + 'px', true);
    }).catch(function (e) {
      setStatus('❌ ' + e.message, false);
    });
  });

  /* ---- 画刀模线 ---- */
  $('btn-draw-die').addEventListener('click', function () {
    var layout = refreshLayout();
    if (!layout) { setStatus('盒型数据加载失败', false); return; }
    setStatus('绘制刀模线中（' + layout.panels.length + ' 个面板）…');
    psbridge.drawDieLine({ panels: layout.panels, bleed: st.bleed }).then(function (r) {
      setStatus('✅ 刀模线已绘制（' + r.panels + ' 面板' + (r.bleedMm > 0 ? ' + ' + r.bleedMm + 'mm 出血框' : '') + '），图层组「' + r.group + '」已锁定', true);
    }).catch(function (e) {
      setStatus('❌ ' + e.message, false);
    });
  });

  /* ---- 条码 ---- */
  var barHint = $('barcode-hint');
  function currentBar() {
    var format = $('barcode-format').value;
    var value = $('barcode-value').value.trim();
    var v = window.toyboxBarcode.validate(format, value);
    if (barHint) {
      barHint.textContent = v.msg;
      barHint.style.display = v.ok && value ? 'none' : '';
    }
    return v.ok ? { format: format, value: value } : null;
  }
  ['barcode-format', 'barcode-value'].forEach(function (id) {
    $(id).addEventListener('input', currentBar);
  });

  $('btn-place-barcode').addEventListener('click', function () {
    var bar = currentBar();
    var layout = st.layout || refreshLayout();
    if (!bar) { setStatus('条码校验未通过，请检查货号', false); return; }
    if (!layout || !layout.barcodePanel) { setStatus('无条码放置面板（请先选择盒型）', false); return; }
    var png = window.toyboxBarcode.makeBarcodePng(bar.format, bar.value);
    if (!png) { setStatus('❌ 条码生成失败（JsBarcode 未加载？）', false); return; }
    // 计算目标区域（mm）：参考独立版 autoS 适配 + shared 下移避让合规块
    var bp = null;
    for (var i = 0; i < layout.panels.length; i++) {
      if (layout.panels[i].id === layout.barcodePanel) { bp = layout.panels[i]; break; }
    }
    if (!bp) { setStatus('条码面板未找到', false); return; }
    // shared：合规与条码同面板 → 无条件 50/50 上下分区（条码从 50% 线下方排起，留 3mm 间隙）
    var shared = layout.compliancePanel === layout.barcodePanel;
    var barWmm = png.w * MM_PER_PX;
    var barHmm = png.h * MM_PER_PX;
    var autoS = Math.min(bp.w * 0.72 / barWmm, bp.h * (shared ? 0.45 : 0.6) / barHmm);
    var targetW = barWmm * autoS;
    var targetH = barHmm * autoS;
    var cx = bp.x + bp.w / 2;
    // shared：条码从 50% 线下方排起（留 3mm 间隙避让合规块底部边距）
    var cy = shared ? bp.y + bp.h * 0.5 + targetH / 2 + 3 : bp.y + bp.h / 2;
    var xMm = cx - targetW / 2;
    var yMm = cy - targetH / 2;
    setStatus('📥 条码入文档（' + bar.format + '，' + Math.round(targetW) + '×' + Math.round(targetH) + 'mm @ ' + bp.id + '）…');
    var filePath;
    try {
      filePath = window.psNode.preparePlaceImage(png.dataUrl).path;
    } catch (e) {
      setStatus('❌ 图片准备失败：' + (e && e.message || e), false);
      return;
    }
    psbridge.placeImage({ filePath: filePath, xMm: xMm, yMm: yMm, wMm: targetW, hMm: targetH, group: '条码', bleed: st.bleed }).then(function (r) {
      setStatus('✅ 条码已放入「' + r.group + '」图层组（' + Math.round(r.actualMm.w * 10) / 10 + '×' + Math.round(r.actualMm.h * 10) / 10 + 'mm）', true);
    }).catch(function (e) {
      setStatus('❌ ' + e.message, false);
    });
  });

  /* ---- 初始化（M6：默认参数取自设置页 config.json，无则用内置默认） ---- */
  (function () {
    if (window.psNode) {
      try {
        var cfg = window.psNode.getConfig();
        if (cfg.defaultBoxType) st.boxType = cfg.defaultBoxType;
        if (cfg.defaultDpi) st.dpi = cfg.defaultDpi;
        if (cfg.defaultBleed !== undefined) st.bleed = cfg.defaultBleed;
      } catch (e) { /* 忽略 */ }
    }
    selectBoxType(st.boxType); // 切换盒型并回填该盒型默认尺寸
    if (window.psNode) {
      try {
        var cfg2 = window.psNode.getConfig();
        if (cfg2.defaultSize) {
          st.size = { w: cfg2.defaultSize.w, d: cfg2.defaultSize.d, h: cfg2.defaultSize.h };
          $('size-w').value = st.size.w;
          $('size-d').value = st.size.d;
          $('size-h').value = st.size.h;
        }
      } catch (e2) { /* 忽略 */ }
    }
    $('bleed-mm').value = st.bleed;
    refreshLayout();
  })();
})();
