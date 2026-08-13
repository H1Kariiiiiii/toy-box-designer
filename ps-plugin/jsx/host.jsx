// 玩具包装盒设计助手 - ExtendScript 宿主（M1 骨架 / M2 placeImage / M3 刀模线+合规文字）
// 运行环境：Photoshop 2018~2020（CEP 8/9）的 ExtendScript 引擎（ES3）
// 面板通过 evalScript 调用 hostHandleCommand('{"name":"...","args":{...}}')，
// 统一返回 JSON 字符串：{ ok:true, result } 或 { ok:false, error }。
// 注意：本文件是 manifest 的 ScriptPath（首个加载的 jsx），不要在这里用 $.fileName。

function hostHandleCommand(cmdJson) {
  var cmd;
  try {
    cmd = JSON.parse(cmdJson);
  } catch (e) {
    return '{"ok":false,"error":"参数解析失败"}';
  }
  if (!cmd || typeof cmd.name !== 'string') {
    return '{"ok":false,"error":"缺少命令名"}';
  }
  try {
    var result = hostDispatch(cmd.name, cmd.args || {});
    return JSON.stringify({ ok: true, result: result });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e.message || e) });
  }
}

function hostDispatch(name, args) {
  switch (name) {
    case 'ping':
      return { pong: true, ps: app.name + ' ' + app.version, doc: app.documents.length };
    case 'createDoc':
      return hostCreateDoc(args);
    case 'createLayerGroup':
      return hostCreateLayerGroup(args);
    case 'placeImage':
      return hostPlaceImage(args);
    case 'drawDieLine':
      return hostDrawDieLine(args);
    case 'placeText':
      return hostPlaceText(args);
    default:
      throw new Error('未知命令: ' + name);
  }
}

// 新建展开图文档：mm → px 换算（1mm = dpi/25.4 px，300dpi 下 1mm ≈ 11.811px）
// args: { w, h, dpi, bleed, name } —— w/h 为展开图净尺寸（不含出血），bleed 出血 mm（M3 起）
function hostCreateDoc(args) {
  var wMm = Number(args.w);
  var hMm = Number(args.h);
  var dpi = Number(args.dpi || 300);
  var bleed = Number(args.bleed) || 0;
  if (!(wMm > 0) || !(hMm > 0) || !(dpi >= 72) || !(dpi <= 1200)) {
    throw new Error('无效尺寸参数（宽/高须 >0，dpi 72~1200）');
  }
  if (!(bleed >= 0) || !(bleed <= 50)) {
    throw new Error('出血参数无效（0~50mm）');
  }
  if (wMm + bleed * 2 > 2000 || hMm + bleed * 2 > 2000) {
    throw new Error('尺寸超上限（含出血 ≤2000mm）');
  }
  var wPx = Math.round((wMm + bleed * 2) * dpi / 25.4);
  var hPx = Math.round((hMm + bleed * 2) * dpi / 25.4);
  var name = String(args.name || '玩具包装展开图');
  var doc = app.documents.add(wPx, hPx, dpi, name, NewDocumentMode.RGB, DocumentFill.WHITE);
  return { docId: doc.id, widthPx: wPx, heightPx: hPx, widthMm: wMm + bleed * 2, heightMm: hMm + bleed * 2, bleed: bleed };
}

// 在当前活动文档创建图层组（后续刀模线/合规/条码都放各自图层组）
function hostCreateLayerGroup(args) {
  var doc = app.activeDocument;
  if (!doc) {
    throw new Error('没有打开的文档，请先新建或打开一个文档');
  }
  var grp = doc.layerSets.add();
  grp.name = String(args.name || '新图层组');
  return { docId: doc.id, groupName: grp.name };
}

// 放置图片（AI 生成图入文档，M2；M3 起支持 bleed 出血偏移）
// args: { filePath, xMm, yMm, wMm, hMm, group, bleed }
//   filePath — Node 侧 preparePlaceImage 写出的 PNG/JPEG 临时文件路径
//   xMm/yMm/wMm/hMm — 目标区域（毫米，相对展开图左上角；bleed 由本函数统一平移）；图按等比 contain 居中于该区域
//   group — 目标图层组名（不存在则创建）
//   bleed — 出血 mm（文档含出血时，坐标平移 bleed 使内容落在展开图区域）
// 实现：doc.place 放置为智能对象 → bounds 量取实际尺寸 → 等比缩放到目标区域 → translate 定位 → 移入图层组
function hostPlaceImage(args) {
  var doc = app.activeDocument;
  if (!doc) {
    throw new Error('没有打开的文档，请先新建或打开一个文档');
  }
  var filePath = String(args.filePath || '');
  if (!filePath) {
    throw new Error('缺少图片文件路径');
  }
  var file = new File(filePath);
  if (!file.exists) {
    throw new Error('图片文件不存在: ' + filePath);
  }
  var wMm = Number(args.wMm);
  var hMm = Number(args.hMm);
  if (!(wMm > 0) || !(hMm > 0)) {
    throw new Error('目标宽高必须 > 0（mm）');
  }
  var bleed = Number(args.bleed) || 0;
  if (!(bleed >= 0) || !(bleed <= 50)) {
    throw new Error('出血参数无效（0~50mm）');
  }
  var xMm = Number(args.xMm) + bleed;   // 相对展开图 → 画布坐标（含出血平移）
  var yMm = Number(args.yMm) + bleed;

  var dpi = doc.resolution;                    // 300dpi 下 1mm = 300/25.4 ≈ 11.811px
  var pxPerMm = dpi / 25.4;
  var targetW = wMm * pxPerMm;
  var targetH = hMm * pxPerMm;

  doc.place(file);                             // 放置后 activeLayer 为智能对象图层
  var layer = doc.activeLayer;

  // 量取放置后的实际像素尺寸
  var cur = hostLayerSizePx(layer);
  if (cur.w <= 0 || cur.h <= 0) {
    throw new Error('图片放置失败（尺寸无效）');
  }

  // 等比缩放（contain），避免拉伸变形
  var scale = Math.min(targetW / cur.w, targetH / cur.h);
  layer.resize(scale * 100, scale * 100, AnchorPosition.MIDDLECENTER);

  // 缩放后重新量取并平移到目标区域左上角（+ 居中偏移）
  // 注意：translate 的数字参数按当前标尺单位解释（可能不是像素），必须显式包成 UnitValue px
  var b2 = hostLayerBoundsPx(layer);
  var w2 = b2[2] - b2[0];
  var h2 = b2[3] - b2[1];
  var targetX = xMm * pxPerMm;
  var targetY = yMm * pxPerMm;
  var offX = (targetW - w2) / 2;
  var offY = (targetH - h2) / 2;
  layer.translate(
    new UnitValue(targetX + offX - b2[0], 'px'),
    new UnitValue(targetY + offY - b2[1], 'px')
  );

  // 移入目标图层组（不存在则创建）
  var groupName = '';
  if (args.group) {
    groupName = String(args.group);
    var grp = hostFindLayerSet(doc, groupName);
    if (!grp) {
      grp = doc.layerSets.add();
      grp.name = groupName;
    }
    layer.move(grp, ElementPlacement.INSIDE);
  }

  return {
    docId: doc.id,
    placed: true,
    layerName: layer.name,
    group: groupName,
    targetMm: { x: xMm, y: yMm, w: wMm, h: hMm },
    actualMm: { w: w2 / pxPerMm, h: h2 / pxPerMm },
    scalePct: Math.round(scale * 10000) / 100,
  };
}

// 图层 bounds → [left, top, right, bottom]（px 数值）
function hostLayerBoundsPx(layer) {
  var b = layer.bounds;
  return [b[0].as('px').value, b[1].as('px').value, b[2].as('px').value, b[3].as('px').value];
}
// 图层像素宽高
function hostLayerSizePx(layer) {
  var b = hostLayerBoundsPx(layer);
  return { w: b[2] - b[0], h: b[3] - b[1] };
}
// 按名称查找顶层图层组，找不到返回 null
function hostFindLayerSet(doc, name) {
  var sets = doc.layerSets;
  for (var i = 0; i < sets.length; i++) {
    if (sets[i].name === name) return sets[i];
  }
  return null;
}

/* ================= M3：刀模线 / 合规文字 ================= */

// 绘制刀模线（M3，F2）
// args: { panels:[{id,x,y,w,h,foldEdges:[]}], bleed }
// 面板坐标 mm（相对展开图左上角）；出血偏移由本函数统一平移（bleed 出血 mm）。
// 渲染：刀线=黑色实线、折线=橙色实线、出血框=橙色实线（虚线增强列为 M5 打磨项），
// 全部画在「刀模线」图层组内单个像素图层上，完成后锁定图层组。
function hostDrawDieLine(args) {
  var doc = app.activeDocument;
  if (!doc) {
    throw new Error('没有打开的文档，请先新建或打开一个文档');
  }
  var dpi = doc.resolution;
  var pxPerMm = dpi / 25.4;
  var bleed = Number(args.bleed) || 0;
  if (!(bleed >= 0) || !(bleed <= 50)) {
    throw new Error('出血参数无效（0~50mm）');
  }
  var bo = bleed * pxPerMm;
  // 虚线周期随分辨率换算（1.4mm 实 + 1.0mm 空；段数超限时加大空距防卡顿）
  var dash = Math.max(6, Math.round(1.4 * pxPerMm));
  var gap = Math.max(4, Math.round(1.0 * pxPerMm));
  var bleedDash = Math.max(6, Math.round(2.0 * pxPerMm));
  var bleedGap = Math.max(4, Math.round(1.2 * pxPerMm));
  var grp = hostFindLayerSet(doc, '刀模线');
  if (!grp) {
    grp = doc.layerSets.add();
    grp.name = '刀模线';
  }
  var layer = doc.artLayers.add();
  layer.name = '刀模线-线稿';
  layer.move(grp, ElementPlacement.INSIDE);

  var black = hostRgbColor(20, 20, 20);       // 刀线
  var orange = hostRgbColor(255, 140, 79);    // 折线 / 出血框（与独立版预览一致）
  var panels = args.panels || [];
  for (var i = 0; i < panels.length; i++) {
    var p = panels[i];
    if (!p) continue;
    var x = Number(p.x) * pxPerMm + bo;
    var y = Number(p.y) * pxPerMm + bo;
    var w = Number(p.w) * pxPerMm;
    var h = Number(p.h) * pxPerMm;
    if (!(w > 0) || !(h > 0)) continue;
    hostStrokeRect(doc, x, y, w, h, black, 2);
    var fe = p.foldEdges || [];
    for (var j = 0; j < fe.length; j++) {
      var e = fe[j];
      // M5：折线渲染为虚线（周期随分辨率换算；段数超限自动加大空距防卡顿）
      var g = (e === 'top' || e === 'bottom') ? hostAdjustGap(w, dash, gap) : hostAdjustGap(h, dash, gap);
      if (e === 'top') hostStrokeDashedLine(doc, x, y, x + w, y, orange, dash, g);
      else if (e === 'bottom') hostStrokeDashedLine(doc, x, y + h, x + w, y + h, orange, dash, g);
      else if (e === 'left') hostStrokeDashedLine(doc, x, y, x, y + h, orange, dash, g);
      else if (e === 'right') hostStrokeDashedLine(doc, x + w, y, x + w, y + h, orange, dash, g);
    }
  }
  if (bleed > 0) {
    // 出血框 = 展开图净尺寸边界（裁切线示意，位于画布内）：[bo, bo] 起，尺寸 = 净宽高，虚线
    var docW = doc.width.as('px').value;
    var docH = doc.height.as('px').value;
    var bg = hostAdjustGap(Math.max(docW, docH), bleedDash, bleedGap); // 按最长边估算（覆盖四条边）
    hostStrokeDashedRect(doc, bo, bo, docW - bo * 2, docH - bo * 2, orange, bleedDash, bg);
  }
  doc.selection.deselect();
  grp.allLocked = true;
  return { docId: doc.id, panels: panels.length, bleedMm: bleed, group: '刀模线' };
}

// 合规文字图层组（M3，F3）
// args: { items:[{text, xMm, yMm, sizePt, align:'left'|'center'|'right', color:'#rrggbb', font}], group, bleed }
// 坐标 mm（相对展开图左上角；bleed 由本函数平移），字号 pt。
function hostPlaceText(args) {
  var doc = app.activeDocument;
  if (!doc) {
    throw new Error('没有打开的文档，请先新建或打开一个文档');
  }
  var dpi = doc.resolution;
  var pxPerMm = dpi / 25.4;
  var bleed = Number(args.bleed) || 0;
  if (!(bleed >= 0) || !(bleed <= 50)) {
    throw new Error('出血参数无效（0~50mm）');
  }
  var bo = bleed * pxPerMm;
  var groupName = String(args.group || '合规信息');
  var grp = hostFindLayerSet(doc, groupName);
  if (!grp) {
    grp = doc.layerSets.add();
    grp.name = groupName;
  }
  var items = args.items || [];
  var created = 0;
  var flagLayer = null; // CE/CCC 圆框像素图层（组内，避免画到文字层/智能对象上）
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var text = String(it && it.text || '');
    if (!text) continue;
    // M5：CE/CCC 圆框（画在专用像素图层上，防止栅格化智能对象/文字层）
    if (it.circle && Number(it.circleR) > 0) {
      if (!flagLayer) {
        flagLayer = doc.artLayers.add();
        flagLayer.name = groupName + '-标志框';
        flagLayer.move(grp, ElementPlacement.INSIDE);
      }
      var prevActive = doc.activeLayer;
      doc.activeLayer = flagLayer;
      hostStrokeCircle(doc, Number(it.circleCx) * pxPerMm + bo, Number(it.circleCy) * pxPerMm + bo, Number(it.circleR) * pxPerMm, hostRgbColor(31, 38, 48), 2);
      doc.selection.deselect();
      doc.activeLayer = prevActive;
    }
    var layer = doc.artLayers.add();
    layer.kind = LayerKind.TEXT;
    layer.name = String(it.name || '合规文字') + (created > 0 ? '_' + created : '');
    var ti = layer.textItem;
    ti.contents = text;
    ti.size = Number(it.sizePt) > 0 ? Number(it.sizePt) : 12;
    var px = Number(it.xMm) * pxPerMm + bo;
    var py = Number(it.yMm) * pxPerMm + bo;
    ti.position = [new UnitValue(px, 'px'), new UnitValue(py, 'px')];
    if (it.align === 'center') ti.justification = Justification.CENTER;
    else if (it.align === 'right') ti.justification = Justification.RIGHT;
    else ti.justification = Justification.LEFT;
    if (it.color) ti.color = hostHexColor(it.color);
    if (it.font) ti.font = String(it.font);
    if (it.bold) ti.fauxBold = true; // 加粗（CE/CCC 标志等）
    layer.move(grp, ElementPlacement.INSIDE);
    created++;
  }
  return { docId: doc.id, created: created, group: groupName };
}

// 建 RGB 颜色
function hostRgbColor(r, g, b) {
  var c = new SolidColor();
  c.rgb.red = r;
  c.rgb.green = g;
  c.rgb.blue = b;
  return c;
}
// '#rrggbb' → SolidColor
function hostHexColor(hex) {
  var s = String(hex || '').replace('#', '');
  if (s.length !== 6) return hostRgbColor(0, 0, 0);
  return hostRgbColor(parseInt(s.substr(0, 2), 16), parseInt(s.substr(2, 2), 16), parseInt(s.substr(4, 2), 16));
}
// 矩形选区描边（实线）
function hostStrokeRect(doc, x, y, w, h, color, width) {
  var pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  doc.selection.select(pts, SelectionType.REPLACE, 0, false);
  doc.selection.stroke(color, width, StrokeLocation.INSIDE);
}
// 线段描边：沿线段垂直方向扩出 width/2 的矩形选区再描 1px
function hostStrokeLine(doc, x1, y1, x2, y2, color, width) {
  var dx = x2 - x1, dy = y2 - y1;
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len <= 0) return;
  var hw = Number(width) / 2;
  var nx = -dy / len * hw;
  var ny = dx / len * hw;
  var pts = [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]];
  doc.selection.select(pts, SelectionType.REPLACE, 0, false);
  doc.selection.stroke(color, 1, StrokeLocation.INSIDE);
}

// 虚线段数保护：单条线估算段数 > 400 时成倍加大 gap（疏化虚线防大尺寸卡顿）
function hostAdjustGap(lenPx, dash, gap) {
  var period = dash + gap;
  var seg = Math.floor(lenPx / period);
  if (seg <= 400) return gap;
  var scale = Math.ceil(seg / 400);
  return gap * scale;
}

// 虚线（M5）：沿线拆成 实-空 交替小段，逐段描边（PS 选区/描边无原生 dash，用拆段模拟）
function hostStrokeDashedLine(doc, x1, y1, x2, y2, color, dash, gap) {  var dx = x2 - x1, dy = y2 - y1;
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len <= 0) return;
  var period = dash + gap;
  var n = Math.max(1, Math.floor(len / period));
  for (var i = 0; i < n; i++) {
    var s0 = i * period;
    var s1 = Math.min(s0 + dash, len);
    hostStrokeLine(doc, x1 + dx * s0 / len, y1 + dy * s0 / len, x1 + dx * s1 / len, y1 + dy * s1 / len, color, 2);
  }
}
// 虚线矩形（出血框用）：四条边分别虚线
function hostStrokeDashedRect(doc, x, y, w, h, color, dash, gap) {
  hostStrokeDashedLine(doc, x, y, x + w, y, color, dash, gap);
  hostStrokeDashedLine(doc, x + w, y, x + w, y + h, color, dash, gap);
  hostStrokeDashedLine(doc, x + w, y + h, x, y + h, color, dash, gap);
  hostStrokeDashedLine(doc, x, y + h, x, y, color, dash, gap);
}

// 椭圆框（CE/CCC 标志圆框，M5）：以 (cx, cy) 为圆心半径 r（px）画椭圆选区描边
function hostStrokeCircle(doc, cx, cy, r, color, width) {
  var bounds = [cx - r, cy - r, cx + r, cy + r];
  doc.selection.selectEllipse(bounds, SelectionType.REPLACE, 0, true);
  doc.selection.stroke(color, width, StrokeLocation.INSIDE);
}
