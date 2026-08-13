/**
 * 盒型模板库（PS 插件版，M3）——由独立版 electron application/templates/boxes.js 转译
 * 转译说明：独立版为 ES6（const/let/箭头/默认参数），CEP 面板 Chromium 57/61 需 ES5，
 * 本文件为 ES5 等价实现；业务逻辑（坐标/面板字段）与独立版保持一致。
 * 新增盒型：在注册表里加一个 build(size) 函数。
 *
 * 面板字段：
 *   id        唯一标识
 *   label     中文名（标注用）
 *   x,y,w,h   相对展开图左上角的坐标（单位 mm）
 *   kind      face=主视觉面板（AI 图贴这里）| side=围边 | flap=折边/插舌 | window=开窗区域
 *   foldEdges 该面板哪些边是折叠线（'top'|'bottom'|'left'|'right'），渲染为虚线
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoxTemplates = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function mm(n) { return n; } // 单位即 mm，保留此函数便于日后切换像素密度

  function buildTianDiGai(s) {
    var W = s.w, D = s.d, H = s.h; // 宽、深、高
    var flap = 15;                 // 折边宽
    var gap = 40;                  // 盖与底之间的间距
    function P(id, label, x, y, w, h, kind, foldEdges) {
      return { id: id, label: label, x: x, y: y, w: w, h: h, kind: kind, foldEdges: foldEdges === undefined ? [] : foldEdges };
    }

    // —— 盖（上）——
    var lidTop = P('lidTop', '盖面（主视觉）', flap + H, flap + H, W, D, 'face');
    var lidUp = P('lidUp', '盖围边', flap + H, flap, W, H, 'side', ['bottom']);
    var lidUpFlap = P('lidUpFlap', '折边', flap + H, 0, W, flap, 'flap', ['bottom']);
    var lidDown = P('lidDown', '盖围边', flap + H, flap + H + D, W, H, 'side', ['top']);
    var lidDownFlap = P('lidDownFlap', '折边', flap + H, flap + H + D + H, W, flap, 'flap', ['top']);
    var lidLeft = P('lidLeft', '盖围边', flap, flap + H, H, D, 'side', ['right']);
    var lidLeftFlap = P('lidLeftFlap', '折边', 0, flap + H, flap, D, 'flap', ['right']);
    var lidRight = P('lidRight', '盖围边', flap + H + W, flap + H, H, D, 'side', ['left']);
    var lidRightFlap = P('lidRightFlap', '折边', flap + H + W + H, flap + H, flap, D, 'flap', ['left']);

    // —— 底（下）——
    // baseY 需把 boxUp（高 H）也计入间距：boxUp 顶 = lidDownFlap 底 + gap，否则 boxUp 会与盖的下折边重叠
    var baseY = lidDownFlap.y + flap + gap + H;
    var boxBottom = P('boxBottom', '底面', flap + H, baseY, W, D, 'face');
    var boxUp = P('boxUp', '底围边', flap + H, baseY - H, W, H, 'side', ['bottom']);
    var boxUpFlap = P('boxUpFlap', '折边', flap + H, baseY - H - flap, W, flap, 'flap', ['bottom']);
    var boxDown = P('boxDown', '底围边', flap + H, baseY + D, W, H, 'side', ['top']);
    var boxDownFlap = P('boxDownFlap', '折边', flap + H, baseY + D + H, W, flap, 'flap', ['top']);
    var boxLeft = P('boxLeft', '底围边', flap, baseY, H, D, 'side', ['right']);
    var boxLeftFlap = P('boxLeftFlap', '折边', 0, baseY, flap, D, 'flap', ['right']);
    var boxRight = P('boxRight', '底围边', flap + H + W, baseY, H, D, 'side', ['left']);
    var boxRightFlap = P('boxRightFlap', '折边', flap + H + W + H, baseY, flap, D, 'flap', ['left']);

    return {
      width: flap * 2 + H * 2 + W,
      height: baseY + D + H + flap,
      panels: [lidTop, lidUp, lidUpFlap, lidDown, lidDownFlap, lidLeft, lidLeftFlap, lidRight, lidRightFlap,
               boxBottom, boxUp, boxUpFlap, boxDown, boxDownFlap, boxLeft, boxLeftFlap, boxRight, boxRightFlap],
      panel: 'lidTop',        // 主视觉面板
      barcodePanel: 'boxBottom',   // 条码放置面板
      compliancePanel: 'lidUp',    // 合规信息块放置面板（盖后围边）
      mockup3d: {
        dims: { x: W, y: H, z: D },
        faces: { top: 'lidTop', bottom: 'boxBottom', front: 'lidDown', back: 'lidUp', left: 'lidLeft', right: 'lidRight' },
      },
    };
  }

  function buildKaiChuangHe(s) {
    var W = s.w, D = s.d, H = s.h;
    var flap = 20;
    // 开窗：位于正面上部，下方留品牌文字区
    var win = { w: Math.round(W * 0.55), h: Math.round(D * 0.6), x: Math.round(W * 0.225), y: Math.round(D * 0.08) };
    function P(id, label, x, y, w, h, kind, foldEdges) {
      return { id: id, label: label, x: x, y: y, w: w, h: h, kind: kind, foldEdges: foldEdges === undefined ? [] : foldEdges };
    }

    var front = P('front', '正面（主视觉·开窗）', H + flap, H + flap, W, D, 'face', ['top', 'bottom', 'left', 'right']);
    var windowP = P('window', '透明窗口', H + flap + win.x, H + flap + win.y, win.w, win.h, 'window');
    var top = P('top', '顶面', H + flap, flap, W, H, 'side', ['bottom']);
    var topFlap = P('topFlap', '插舌', H + flap, 0, W, flap, 'flap', ['bottom']);
    var bottom = P('bottom', '底面', H + flap, flap + H + D, W, H, 'side', ['top']);
    var bottomFlap = P('bottomFlap', '插舌', H + flap, flap + H + D + H, W, flap, 'flap', ['top']);
    var left = P('left', '侧面', flap, H + flap, H, D, 'side', ['right']);
    var leftFlap = P('leftFlap', '插舌', 0, H + flap, flap, D, 'flap', ['right']);
    var right = P('right', '侧面', flap + H + W, H + flap, H, D, 'side', ['left']);
    var rightFlap = P('rightFlap', '插舌', flap + H + W + H, H + flap, flap, D, 'flap', ['left']);

    return {
      width: flap + H * 2 + W + flap,
      height: flap + H * 2 + D + flap,
      panels: [front, windowP, top, topFlap, bottom, bottomFlap, left, leftFlap, right, rightFlap],
      panel: 'front',
      barcodePanel: 'bottom',
      compliancePanel: 'bottom', // 与条码同面板，绘制时上下分区
      mockup3d: {
        dims: { x: W, y: D, z: H },
        faces: { top: 'top', bottom: 'bottom', front: 'front', back: null, left: 'left', right: 'right' },
      },
    };
  }

  function buildShuangChaHe(s) {
    var W = s.w, D = s.d, H = s.h;
    var flap = 20;
    var glue = 15;
    function P(id, label, x, y, w, h, kind, foldEdges) {
      return { id: id, label: label, x: x, y: y, w: w, h: h, kind: kind, foldEdges: foldEdges === undefined ? [] : foldEdges };
    }

    // 横向展开：胶边-左-背-右-正（主体 y 从 flap+H 起，与开窗盒一致，顶/底面紧贴主体不重叠）
    var x = 0;
    var bodyY = flap + H;
    var glueFlap = P('glue', '粘胶边', x, bodyY, glue, D, 'flap', ['right']); x += glue;
    var left = P('left', '左侧面', x, bodyY, H, D, 'side', ['right']); x += H;
    var back = P('back', '背面', x, bodyY, W, D, 'side', ['right']); x += W;
    var right = P('right', '右侧面', x, bodyY, H, D, 'side', ['right']); x += H;
    var front = P('front', '正面（主视觉）', x, bodyY, W, D, 'face'); x += W;
    var backX = glue + H;
    var top = P('top', '顶面', backX, flap, W, H, 'side', ['bottom']);
    var topFlap = P('topFlap', '插舌', backX, 0, W, flap, 'flap', ['bottom']);
    var bottom = P('bottom', '底面', backX, flap + H + D, W, H, 'side', ['top']);
    var bottomFlap = P('bottomFlap', '插舌', backX, flap + H + D + H, W, flap, 'flap', ['top']);

    return {
      width: x,
      height: flap + H * 2 + D + flap,
      panels: [glueFlap, left, back, right, front, top, topFlap, bottom, bottomFlap],
      panel: 'front',
      barcodePanel: 'back',
      compliancePanel: 'back', // 与条码同面板，绘制时上下分区
      mockup3d: {
        dims: { x: W, y: D, z: H },
        faces: { top: 'top', bottom: 'bottom', front: 'front', back: 'back', left: 'left', right: 'right' },
      },
    };
  }

  /**
   * 盒型注册表。新增盒型：写一个 build(size) 函数，然后在这里登记即可。
   * size = { w: 长mm, d: 宽mm, h: 高mm }
   */
  return {
    tianDiGai: {
      id: 'tianDiGai',
      name: '天地盖',
      desc: '盖身分离，高端玩具礼盒常用',
      defaultSize: { w: 200, h: 60, d: 130 },
      build: buildTianDiGai,
    },
    kaiChuangHe: {
      id: 'kaiChuangHe',
      name: '开窗盒（站立展示盒）',
      desc: '正面开窗，露出产品本体，超市货架展示款',
      defaultSize: { w: 200, h: 60, d: 130 },
      build: buildKaiChuangHe,
    },
    shuangChaHe: {
      id: 'shuangChaHe',
      name: '双插盒（药盒式）',
      desc: '左右插舌封口，小件玩具/盲盒常用',
      defaultSize: { w: 200, h: 60, d: 130 },
      build: buildShuangChaHe,
    },
  };
}); // UMD 工厂结束
