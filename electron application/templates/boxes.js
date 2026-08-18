/**
 * 盒型模板库：参数化刀模展开图（UMD，主进程与渲染进程共用）
 * 核心思路：盒型结构 = 纯数学（长/宽/高 → 展开图坐标），AI 只负责往"主视觉面板"填图，
 * 从而保证刀模结构永远正确。新增盒型只需在注册表里加一个 build(size) 函数。
 *
 * 面板字段：
 *   id        唯一标识
 *   label     中文名（SVG 标注用）
 *   x,y,w,h   相对展开图左上角的坐标（单位 mm）
 *   kind      face=主视觉面板（AI 图贴这里）| side=围边 | flap=折边/插舌 | window=开窗区域
 *   foldEdges 该面板哪些边是折叠线（'top'|'bottom'|'left'|'right'），渲染为虚线
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoxTemplates = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const mm = (n) => n; // 单位即 mm，保留此函数便于日后切换像素密度

function buildTianDiGai(s) {
  const W = s.w, D = s.d, H = s.h; // 宽、深、高（底净尺寸）
  const flap = 15;                 // 折边宽
  const gap = 40;                  // 盖与底之间的间距
  // P0-3（v0.6.2）：盖公差（每边 mm）= 纸厚 + 装配间隙。天地盖工艺铁律：
  // 盖内径必须大于底外径（+2×公差），否则盖子插不进去。默认 1.5mm/边（≈1mm 纸板 + 0.5mm 间隙）。
  const tol = (Number.isFinite(Number(s.tol)) && s.tol >= 0 && s.tol <= 10) ? Number(s.tol) : 1.5;
  const Wl = W + 2 * tol;          // 盖长
  const Dl = D + 2 * tol;          // 盖宽
  const P = (id, label, x, y, w, h, kind, foldEdges = []) => ({ id, label, x, y, w, h, kind, foldEdges });

  // —— 盖（上，按盖净尺寸 Wl×Dl）——
  const lidTop = P('lidTop', '盖面（主视觉）', flap + H, flap + H, Wl, Dl, 'face');
  const lidUp = P('lidUp', '盖围边', flap + H, flap, Wl, H, 'side', ['bottom']);
  const lidUpFlap = P('lidUpFlap', '折边', flap + H, 0, Wl, flap, 'flap', ['bottom']);
  const lidDown = P('lidDown', '盖围边', flap + H, flap + H + Dl, Wl, H, 'side', ['top']);
  const lidDownFlap = P('lidDownFlap', '折边', flap + H, flap + H + Dl + H, Wl, flap, 'flap', ['top']);
  const lidLeft = P('lidLeft', '盖围边', flap, flap + H, H, Dl, 'side', ['right']);
  const lidLeftFlap = P('lidLeftFlap', '折边', 0, flap + H, flap, Dl, 'flap', ['right']);
  const lidRight = P('lidRight', '盖围边', flap + H + Wl, flap + H, H, Dl, 'side', ['left']);
  const lidRightFlap = P('lidRightFlap', '折边', flap + H + Wl + H, flap + H, flap, Dl, 'flap', ['left']);

  // —— 底（下，按底净尺寸 W×D）——
  // baseY 需把 boxUp（高 H）也计入间距：boxUp 顶 = lidDownFlap 底 + gap，否则 boxUp 会与盖的下折边重叠
  const baseY = lidDownFlap.y + flap + gap + H;
  const boxBottom = P('boxBottom', '底面', flap + H, baseY, W, D, 'face');
  const boxUp = P('boxUp', '底围边', flap + H, baseY - H, W, H, 'side', ['bottom']);
  const boxUpFlap = P('boxUpFlap', '折边', flap + H, baseY - H - flap, W, flap, 'flap', ['bottom']);
  const boxDown = P('boxDown', '底围边', flap + H, baseY + D, W, H, 'side', ['top']);
  const boxDownFlap = P('boxDownFlap', '折边', flap + H, baseY + D + H, W, flap, 'flap', ['top']);
  const boxLeft = P('boxLeft', '底围边', flap, baseY, H, D, 'side', ['right']);
  const boxLeftFlap = P('boxLeftFlap', '折边', 0, baseY, flap, D, 'flap', ['right']);
  const boxRight = P('boxRight', '底围边', flap + H + W, baseY, H, D, 'side', ['left']);
  const boxRightFlap = P('boxRightFlap', '折边', flap + H + W + H, baseY, flap, D, 'flap', ['left']);

  return {
    width: flap * 2 + H * 2 + Wl,
    height: baseY + D + H + flap,
    panels: [lidTop, lidUp, lidUpFlap, lidDown, lidDownFlap, lidLeft, lidLeftFlap, lidRight, lidRightFlap,
             boxBottom, boxUp, boxUpFlap, boxDown, boxDownFlap, boxLeft, boxLeftFlap, boxRight, boxRightFlap],
    panel: 'lidTop', // 主视觉面板
    barcodePanel: 'boxBottom', // 条码放置面板
    compliancePanel: 'lidUp', // 合规信息块放置面板（盖后围边）
    toleranceMm: tol, // 盖公差（每边 mm，v0.6.2）
    // 3D mockup：盒子按底净尺寸展示（盖比底大是装配关系，3D 展示底外廓即可）
    mockup3d: {
      dims: { x: W, y: H, z: D },
      faces: { top: 'lidTop', bottom: 'boxBottom', front: 'lidDown', back: 'lidUp', left: 'lidLeft', right: 'lidRight' },
    },
  };
}

function buildKaiChuangHe(s) {
  const W = s.w, D = s.d, H = s.h;
  const flap = 20;
  // 开窗：位于正面上部，下方留品牌文字区；支持 s.win 百分比自定义（小改：窗口可调）
  const wcfg = s.win || {};
  const pct = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(95, Math.max(5, n)) : d; };
  let winW = Math.round(W * pct(wcfg.wPct, 55) / 100);
  let winH = Math.round(D * pct(wcfg.hPct, 60) / 100);
  winW = Math.min(winW, W - 6);
  winH = Math.min(winH, D - 6);
  const win = {
    w: winW, h: winH,
    x: Math.min(Math.max(0, Math.round(W * pct(wcfg.xPct, 22.5) / 100)), W - winW),
    y: Math.min(Math.max(0, Math.round(D * pct(wcfg.yPct, 8) / 100)), D - winH),
    shape: ['rect', 'round', 'ellipse', 'circle', 'custom'].includes(wcfg.shape) ? wcfg.shape : 'rect',
  };
  const P = (id, label, x, y, w, h, kind, foldEdges = []) => ({ id, label, x, y, w, h, kind, foldEdges });

  const front = P('front', '正面（主视觉·开窗）', H + flap, H + flap, W, D, 'face', ['top', 'bottom', 'left', 'right']);
  const windowP = P('window', '透明窗口', H + flap + win.x, H + flap + win.y, win.w, win.h, 'window');
  windowP.shape = win.shape || 'rect'; // 窗口形状：rect|round|ellipse|circle（自由定制）
  const top = P('top', '顶面', H + flap, flap, W, H, 'side', ['bottom']);
  const topFlap = P('topFlap', '插舌', H + flap, 0, W, flap, 'flap', ['bottom']);
  const bottom = P('bottom', '底面', H + flap, flap + H + D, W, H, 'side', ['top']);
  const bottomFlap = P('bottomFlap', '插舌', H + flap, flap + H + D + H, W, flap, 'flap', ['top']);
  const left = P('left', '侧面', flap, H + flap, H, D, 'side', ['right']);
  const leftFlap = P('leftFlap', '插舌', 0, H + flap, flap, D, 'flap', ['right']);
  const right = P('right', '侧面', flap + H + W, H + flap, H, D, 'side', ['left']);
  const rightFlap = P('rightFlap', '插舌', flap + H + W + H, H + flap, flap, D, 'flap', ['left']);

  return {
    width: flap + H * 2 + W + flap,
    height: flap + H * 2 + D + flap,
    panels: [front, windowP, top, topFlap, bottom, bottomFlap, left, leftFlap, right, rightFlap],
    panel: 'front',
    barcodePanel: 'bottom',
    compliancePanel: 'bottom', // 与条码同面板，绘制时上下分区
    // 开窗盒为站立展示盒：长(W)×高(D)×深(H)；背面无设计，留空
    mockup3d: {
      dims: { x: W, y: D, z: H },
      faces: { top: 'top', bottom: 'bottom', front: 'front', back: null, left: 'left', right: 'right' },
    },
  };
}

function buildShuangChaHe(s) {
  const W = s.w, D = s.d, H = s.h;
  const flap = 20;
  const glue = 15;
  const P = (id, label, x, y, w, h, kind, foldEdges = []) => ({ id, label, x, y, w, h, kind, foldEdges });

  // 横向展开：胶边-左-背-右-正（主体 y 从 flap+H 起，与开窗盒一致，顶/底面紧贴主体不重叠）
  let x = 0;
  const bodyY = flap + H;
  const glueFlap = P('glue', '粘胶边', x, bodyY, glue, D, 'flap', ['right']); x += glue;
  const left = P('left', '左侧面', x, bodyY, H, D, 'side', ['right']); x += H;
  const back = P('back', '背面', x, bodyY, W, D, 'side', ['right']); x += W;
  const right = P('right', '右侧面', x, bodyY, H, D, 'side', ['right']); x += H;
  const front = P('front', '正面（主视觉）', x, bodyY, W, D, 'face'); x += W;
  const backX = glue + H;
  const top = P('top', '顶面', backX, flap, W, H, 'side', ['bottom']);
  const topFlap = P('topFlap', '插舌', backX, 0, W, flap, 'flap', ['bottom']);
  const bottom = P('bottom', '底面', backX, flap + H + D, W, H, 'side', ['top']);
  const bottomFlap = P('bottomFlap', '插舌', backX, flap + H + D + H, W, flap, 'flap', ['top']);

  return {
    width: x,
    height: flap + H * 2 + D + flap,
    panels: [glueFlap, left, back, right, front, top, topFlap, bottom, bottomFlap],
    panel: 'front',
    barcodePanel: 'back',
    compliancePanel: 'back', // 与条码同面板，绘制时上下分区
    // 双插盒：长(W)×高(D)×深(H)
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
