/* compliance-panel.js - 合规页逻辑（M3，F3）
 * 兼容：CEP 8/9（Chromium 57/61，ES5）。依赖 js/compliance.js（ComplianceData）+ js/templates.js。
 * 布局规则移植自独立版 renderer/app.js drawComplianceBlock：
 *   - 合规块排入 compliancePanel 面板上半部
 *   - 文本行：品名/货号/材质/执行标准/制造商/警告（有值的行）
 *   - 字号随面板宽自适应（下限 6px 画布像素）；与条码同面板时块高上限 50%，否则 85%
 *   - CE/CCC 标志：加粗文字放块右侧（圆框为 M5 打磨项） */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var PS_DPI = 300;
  var PX_PER_MM = PS_DPI / 25.4;

  var statusEl = $('comp-status');
  var st = window.psState || (window.psState = {});

  function setStatus(msg, ok) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (ok ? ' ok' : (ok === false ? ' err' : ''));
  }

  /* ---- 目标市场多选 chips ---- */
  var markets = {}; // id → true
  var CD = window.ComplianceData;

  function renderMarkets() {
    var wrap = $('comp-markets');
    wrap.innerHTML = '';
    Object.keys(CD.markets).forEach(function (id) {
      var m = CD.markets[id];
      var chip = document.createElement('span');
      chip.className = 'chip' + (markets[id] ? ' active' : '');
      chip.textContent = m.name;
      chip.addEventListener('click', function () {
        markets[id] = !markets[id];
        renderMarkets();
      });
      wrap.appendChild(chip);
    });
    // 提示清单（选中市场必印项，帮助设计师自查）
    var list = $('comp-list');
    list.innerHTML = '';
    var any = false;
    Object.keys(CD.markets).forEach(function (id) {
      if (!markets[id]) return;
      any = true;
      CD.markets[id].items.forEach(function (it) {
        var div = document.createElement('div');
        div.className = 'comp-item';
        div.textContent = '· ' + it.label;
        div.title = it.ref;
        list.appendChild(div);
      });
    });
    if (!any) {
      list.innerHTML = '<div class="hint">👆 勾选目标市场，显示该市场包装必印信息清单（供自查）</div>';
    }
  }
  renderMarkets();

  /* ---- 字段输入 ---- */
  var FIELD_DEFS = [
    ['comp-name', '品名'], ['comp-sku', '货号'], ['comp-material', '材质'],
    ['comp-standard', '执行标准'], ['comp-maker', '制造商'], ['comp-warning', '警告'],
  ];

  function collectFields() {
    var f = {};
    FIELD_DEFS.forEach(function (d) { f[d[1]] = $(d[0]).value.trim(); });
    return f;
  }

  /* ---- 排入文档 ---- */
  $('btn-place-comp').addEventListener('click', function () {
    var layout = st.layout;
    if (!layout) { setStatus('请先在「模板」页选择盒型并新建/打开文档', false); return; }
    var pid = layout.compliancePanel;
    if (!pid) { setStatus('该盒型无合规面板', false); return; }
    var p = null;
    for (var i = 0; i < layout.panels.length; i++) {
      if (layout.panels[i].id === pid) { p = layout.panels[i]; break; }
    }
    if (!p) { setStatus('合规面板未找到', false); return; }

    var f = collectFields();
    var rows = [
      ['品名', f['品名']], ['货号', f['货号']], ['材质', f['材质']],
      ['执行标准', f['执行标准']], ['制造商', f['制造商']], ['警告', f['警告']],
    ].filter(function (r) { return r[1] !== ''; });
    var hasFlags = Object.keys(markets).some(function (id) { return markets[id]; });
    if (!rows.length && !hasFlags) { setStatus('请至少填写一个字段或勾选目标市场', false); return; }

    // 合规块：与条码同面板时无条件限 0.5h（50/50 上下分区，顺序无关）；否则 0.85h
    var shared = layout.barcodePanel === pid;
    var maxBhMm = p.h * (shared ? 0.5 : 0.85);
    // 字号：px = max(6, 面板宽px * 0.032)，再换算 pt（1pt = dpi/72 px）
    var fsPx = Math.max(6, p.w * PX_PER_MM * 0.032);
    while (fsPx > 6 && rows.length * (fsPx * 1.55) + fsPx * 1.55 * 0.5 > maxBhMm * PX_PER_MM) {
      fsPx -= 1;
    }
    var bhPx = Math.min(maxBhMm * PX_PER_MM, Math.max(p.h * PX_PER_MM * 0.46, rows.length * (fsPx * 1.55) + fsPx * 1.55 * 0.5));
    var sizePt = Math.max(1.5, Math.round(fsPx * 72 / PS_DPI * 10) / 10); // 与 fsPx(≥6px) 对齐：6px≈1.5pt

    // 逐行生成文字项（mm 坐标）
    var bx = p.x + 5, bw = p.w - 10;
    var lh = fsPx * 1.55 / PX_PER_MM; // 行高 mm
    var flagW = hasFlags ? bhPx * 1.05 / PX_PER_MM : 0;
    var maxTextWpx = (bw - 10 - flagW) * PX_PER_MM;
    var items = [];
    var ty = p.y + 4 + lh; // 首行基线
    for (var r = 0; r < rows.length; r++) {
      var line = rows[r][0] + '：' + rows[r][1];
      if (line.length * fsPx > maxTextWpx) {
        line = line.slice(0, Math.max(6, Math.floor(maxTextWpx / fsPx))) + '…';
      }
      items.push({ text: line, xMm: bx + 5, yMm: ty, sizePt: sizePt, align: 'left', color: '#1f2630', name: rows[r][0] });
      ty += lh;
      if (ty > p.y + 4 + bhPx / PX_PER_MM - lh * 0.4) break;
    }
    // 标志（CE/CCC）：M5 起带椭圆框（圆框+文字），块右侧竖直排列
    if (hasFlags) {
      var d = bhPx * 0.5 / PX_PER_MM;      // 圆直径 mm
      var fy = p.y + 4 + d / 2;            // 圆心 y
      var fx = bx + bw - d - 4;            // 圆心 x（从右往左排）
      if (markets['eu']) {
        items.push({
          text: 'CE', xMm: fx, yMm: fy - d * 0.12, sizePt: Math.max(8, sizePt * 1.4),
          align: 'center', color: '#1f2630', name: 'CE 标志', bold: true,
          circle: true, circleCx: fx, circleCy: fy, circleR: d / 2,
        });
        fx -= d + 4;
      }
      if (markets['cn']) {
        items.push({
          text: 'CCC', xMm: fx, yMm: fy - d * 0.12, sizePt: Math.max(8, sizePt * 1.2),
          align: 'center', color: '#1f2630', name: 'CCC 标志', bold: true,
          circle: true, circleCx: fx, circleCy: fy, circleR: d / 2,
        });
      }
    }

    setStatus('📝 排入合规信息（' + rows.length + ' 行' + (hasFlags ? ' + 标志' : '') + ' @ ' + pid + '）…');
    psbridge.placeText({ items: items, group: '合规信息', bleed: st.bleed }).then(function (r) {
      setStatus('✅ 合规信息已排入「' + r.group + '」图层组（' + r.created + ' 个文字图层）', true);
    }).catch(function (e) {
      setStatus('❌ ' + e.message, false);
    });
  });
})();
