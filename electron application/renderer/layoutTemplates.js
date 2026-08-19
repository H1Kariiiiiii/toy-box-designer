'use strict';
/* layoutTemplates.js - 版面套版模板（中改：多区块版面"填内容即套版"）
 * 纯渲染逻辑：输入版面数据 + 面板（mm 坐标）→ 区块列表 → SVG parts。
 * 兼容：renderer 环境（ES2017），无外部依赖。
 * 区块类型：bar（品牌条）/ box（产品名/系列标签）/ sell（卖点区）/ grid（系列网格，可自动配图）/ strip（装饰条）
 * 模板布局参数：gridPos（网格位置 right|bottom）、gridCols（列数）、sellH（卖点区高度）、back（背板面板配置）*/

// 套版模板定义（配色 + 布局参数 + v0.7.0 装饰：bgGrad 正面渐变背景 / slant 斜切装饰带）
const LAYOUT_TEMPLATES = {
  farm: { // 农场经典（仿实物：黑底黄字品牌条 + 绿底卖点区 + 三色装饰条）
    label: '农场经典',
    brandBar: { bg: '#1c1c1c', text: '#ffd400', hMm: 13 },
    seriesTag: { bg: '#ffd400', text: '#1c1c1c' },
    sellBlock: { bg: '#2e7d32', title: '#ffd400', sub: '#ffffff' },
    productName: { bg: '#ffffff', text: '#1c1c1c' },
    decoStrip: ['#2e7d32', '#4a4a4a', '#111111'],
    bgGrad: { from: '#f3f7d8', to: '#dcec9a', angle: 160 }, // 浅绿渐变（v0.7.0）
    slant: ['#2e7d32', '#ffd400'], // 斜切装饰带颜色（顶部品牌条下沿，v0.7.0）
    gridPos: 'right', gridCols: 1, sellH: 20,
    back: { panel: 'back', brand: true, grid: true, deco: true },
  },
  clean: { // 简约白（黑底白字 + 灰阶装饰条，网格横排）
    label: '简约白',
    brandBar: { bg: '#1c1c1c', text: '#ffffff', hMm: 11 },
    seriesTag: { bg: '#1c1c1c', text: '#ffffff' },
    sellBlock: { bg: '#1c1c1c', title: '#ffffff', sub: '#cccccc' },
    productName: { bg: '#ffffff', text: '#1c1c1c' },
    decoStrip: ['#1c1c1c', '#888888', '#eeeeee'],
    bgGrad: { from: '#ffffff', to: '#eceff4', angle: 160 },
    slant: ['#1c1c1c'],
    gridPos: 'bottom', gridCols: 2, sellH: 18,
    back: null,
  },
  guochao: { // 国潮红金（喜庆中国风）
    label: '国潮红金',
    brandBar: { bg: '#b01f24', text: '#ffd700', hMm: 13 },
    seriesTag: { bg: '#ffd700', text: '#8c1418' },
    sellBlock: { bg: '#8c1418', title: '#ffd700', sub: '#ffe9c9' },
    productName: { bg: '#fff8ec', text: '#8c1418' },
    decoStrip: ['#b01f24', '#ffd700', '#5c0d10'],
    bgGrad: { from: '#fff3e2', to: '#f6d7a8', angle: 160 },
    slant: ['#b01f24', '#ffd700'],
    gridPos: 'right', gridCols: 1, sellH: 20,
    back: { panel: 'back', brand: true, grid: true, deco: true },
  },
  mecha: { // 机甲酷黑（炫酷科技风）
    label: '机甲酷黑',
    brandBar: { bg: '#12121c', text: '#00d4ff', hMm: 13 },
    seriesTag: { bg: '#00d4ff', text: '#12121c' },
    sellBlock: { bg: '#1a1a2e', title: '#00d4ff', sub: '#9fb4c8' },
    productName: { bg: '#ffffff', text: '#12121c' },
    decoStrip: ['#00d4ff', '#3a3a5c', '#12121c'],
    bgGrad: { from: '#1a1a2e', to: '#0d0d18', angle: 150 }, // 机甲黑蓝渐变（接近 MZCARS 黑红风格，可换红）
    slant: ['#00d4ff', '#3a3a5c'],
    gridPos: 'bottom', gridCols: 2, sellH: 18,
    back: null,
  },
  watercolor: { // 清新水彩（柔和马卡龙）
    label: '清新水彩',
    brandBar: { bg: '#ff8fab', text: '#ffffff', hMm: 11 },
    seriesTag: { bg: '#ff8fab', text: '#ffffff' },
    sellBlock: { bg: '#f4f9fb', title: '#2a6f97', sub: '#5c8a9e' },
    productName: { bg: '#ffffff', text: '#2a6f97' },
    decoStrip: ['#ff8fab', '#a8d8ea', '#2a6f97'],
    bgGrad: { from: '#fdf4f7', to: '#e6f4fa', angle: 150 },
    slant: ['#ff8fab', '#a8d8ea'],
    gridPos: 'bottom', gridCols: 2, sellH: 18,
    back: null,
  },
  forest: { // 森林自然（清新自然风）
    label: '森林自然',
    brandBar: { bg: '#2d5a27', text: '#e8f5e9', hMm: 12 },
    seriesTag: { bg: '#c8a27a', text: '#2d5a27' },
    sellBlock: { bg: '#3a6b35', title: '#ffd97a', sub: '#e8f5e9' },
    productName: { bg: '#fdfaf3', text: '#2d5a27' },
    decoStrip: ['#2d5a27', '#c8a27a', '#1c3a18'],
    bgGrad: { from: '#eef7ec', to: '#cde4c6', angle: 160 },
    slant: ['#2d5a27', '#c8a27a'],
    gridPos: 'right', gridCols: 1, sellH: 20,
    back: { panel: 'back', brand: true, grid: true, deco: true },
  },
  candy: { // 甜心粉彩（糖果少女风）
    label: '甜心粉彩',
    brandBar: { bg: '#f472b6', text: '#ffffff', hMm: 12 },
    seriesTag: { bg: '#f9a8d4', text: '#7c2d5a' },
    sellBlock: { bg: '#fdf2f8', title: '#db2777', sub: '#9d5c7a' },
    productName: { bg: '#ffffff', text: '#db2777' },
    decoStrip: ['#f472b6', '#fbcfe8', '#db2777'],
    bgGrad: { from: '#fdf2f8', to: '#fbd7e8', angle: 150 },
    slant: ['#f472b6', '#db2777'],
    gridPos: 'bottom', gridCols: 2, sellH: 18,
    back: { panel: 'back', brand: true, grid: true, deco: true },
  },
  galaxy: { // 星空紫（神秘宇宙风）
    label: '星空紫',
    brandBar: { bg: '#1e1b4b', text: '#c4b5fd', hMm: 12 },
    seriesTag: { bg: '#7c3aed', text: '#ffffff' },
    sellBlock: { bg: '#2e1065', title: '#c4b5fd', sub: '#a5b4fc' },
    productName: { bg: '#ffffff', text: '#312e81' },
    decoStrip: ['#7c3aed', '#1e1b4b', '#312e81'],
    bgGrad: { from: '#2e1065', to: '#1e1b4b', angle: 150 },
    slant: ['#7c3aed', '#c4b5fd'],
    gridPos: 'bottom', gridCols: 3, sellH: 18,
    back: { panel: 'back', brand: true, grid: true, deco: true },
  },
  retro: { // 复古红蓝（经典撞色）
    label: '复古红蓝',
    brandBar: { bg: '#1d4ed8', text: '#ffffff', hMm: 12 },
    seriesTag: { bg: '#dc2626', text: '#ffffff' },
    sellBlock: { bg: '#b91c1c', title: '#ffffff', sub: '#fecaca' },
    productName: { bg: '#ffffff', text: '#1e40af' },
    decoStrip: ['#dc2626', '#1d4ed8', '#f59e0b'],
    bgGrad: { from: '#f4f6ff', to: '#dbe3ff', angle: 160 },
    slant: ['#dc2626', '#1d4ed8'],
    gridPos: 'right', gridCols: 1, sellH: 20,
    back: { panel: 'back', brand: true, grid: true, deco: true },
  },
};

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 区块布局计算：相对面板（mm 坐标，原点=面板左上角）
 * @param {object} layout { template, brand, product, series, sellTitle, sellSub, gridItems:[{no,name}], decoOn }
 * @param {object} front  { x, y, w, h } 面板（mm）
 * @param {Array}  images 自动配图 dataURL 数组（gridItems[i].image 优先，否则 images[i]）
 * @param {string} mode   'front'（默认全区块）| 'back'（背板：品牌条+网格+装饰条，无产品名/系列/卖点）
 * @returns {Array} 区块列表
 */
function layoutSections(layout, front, images, mode) {
  const tpl = LAYOUT_TEMPLATES[layout && layout.template] || LAYOUT_TEMPLATES.farm;
  const isBack = mode === 'back';
  if (!front || !(front.w > 0) || !(front.h > 0)) return [];
  const W = front.w, D = front.h;
  const margin = 4;
  const s = [];
  const sellH = tpl.sellH || 20;
  const decoH = layout.decoOn && tpl.decoStrip && tpl.decoStrip.length ? 3.5 : 0;
  const imgs = Array.isArray(images) ? images : [];

  // 顶部品牌条（v0.7.0：支持 logo 图片，有图优先于文字）
  if (layout.brand || layout.logo) {
    s.push({
      type: 'bar', id: 'bar', draggable: !isBack, x: 0, y: 0, w: W, h: isBack ? Math.min(9, tpl.brandBar.hMm) : tpl.brandBar.hMm,
      bg: tpl.brandBar.bg, text: layout.logo ? '' : (layout.brand || ''), color: tpl.brandBar.text,
      image: layout.logo || null, // v0.7.0：品牌 logo 图片（dataURL）
      fontSize: Math.min(9, (isBack ? 9 : tpl.brandBar.hMm) * 0.55), bold: true,
    });
  }

  if (!isBack) {
    // 产品名（品牌条下方）
    let y = (layout.brand ? tpl.brandBar.hMm : 0) + 2;
    if (layout.product) {
      s.push({
        type: 'box', id: 'product', draggable: true, x: margin, y: y, w: Math.min(W * 0.62, 96), h: 9,
        bg: tpl.productName.bg, text: layout.product, color: tpl.productName.text,
        fontSize: 6.5, bold: true, stroke: '#d0d0d0',
      });
      y += 11;
    }
    // 系列标签（右上角）
    if (layout.series) {
      const tw = Math.min(W * 0.34, 48);
      s.push({
        type: 'box', id: 'series', draggable: true, x: W - margin - tw, y: (layout.brand ? tpl.brandBar.hMm : 0) + 2, w: tw, h: 7,
        bg: tpl.seriesTag.bg, text: layout.series, color: tpl.seriesTag.text,
        fontSize: 5, bold: true,
      });
    }
    // 卖点区（底部，网格下方留白）
    if (layout.sellTitle) {
      s.push({
        type: 'sell', id: 'sell', draggable: !isBack, x: 0, y: D - sellH - decoH, w: W, h: sellH,
        bg: tpl.sellBlock.bg, title: layout.sellTitle, sub: layout.sellSub || '',
        titleColor: tpl.sellBlock.title, subColor: tpl.sellBlock.sub,
        titleSize: 8, subSize: 4.5,
      });
    }
  }

  // 功能徽章（v0.7.0）：layout.badges = [{ text, icon, bg }]，排在品牌条下方一行
  if (!isBack && Array.isArray(layout.badges) && layout.badges.length) {
    const bw = 34; // 单个徽章宽（mm）
    const bh = 9;
    const by = (layout.brand || layout.logo ? tpl.brandBar.hMm : 0) + 2;
    layout.badges.forEach((bd, i) => {
      const bx = margin + i * (bw + 2.5);
      s.push({
        type: 'badge', id: 'badge' + i, draggable: true, x: bx, y: by, w: bw, h: bh,
        bg: bd.bg || tpl.seriesTag.bg, text: bd.text || '', icon: bd.icon || null,
        color: tpl.seriesTag.text,
      });
    });
  }

  // 系列网格（位置：right 右侧竖排 / bottom 卖点区上方横排；背板=主区块）
  if (layout.gridItems && layout.gridItems.length) {
    const cols = Math.max(1, Math.min(3, tpl.gridCols || 1));
    const rows = Math.ceil(layout.gridItems.length / cols);
    const items = layout.gridItems.map((it, i) => ({
      no: it.no, name: it.name,
      image: it.image || imgs[i] || null,
    }));
    if (tpl.gridPos === 'bottom' || isBack) {
      // 横排：正面时在卖点区上方；背板时铺满中部
      const topBand = isBack ? (layout.brand ? 11 : 0) : (layout.sellTitle ? sellH + decoH + 2 : decoH + 2);
      const gh = Math.min(rows * 16 + 4, isBack ? D - topBand - decoH - 8 : 44);
      const gy = isBack ? topBand : D - topBand - gh;
      s.push({
        type: 'grid', id: 'grid', draggable: !isBack, x: margin, y: gy, w: W - margin * 2, h: gh,
        items: items, cols: cols,
        cellBg: 'rgba(255,255,255,0.94)', border: '#1c1c1c', textColor: '#1c1c1c',
      });
    } else { // right：右侧竖排
      const gridW = Math.min(W * 0.32, 58);
      const gx = W - margin - gridW;
      const gy = Math.max((layout.brand ? tpl.brandBar.hMm : 0) + 11, 0) + 2;
      const gh = Math.max(20, D - gy - sellH - decoH - 8);
      s.push({
        type: 'grid', id: 'grid', draggable: true, x: gx, y: gy, w: gridW, h: gh,
        items: items, cols: 1,
        cellBg: 'rgba(255,255,255,0.94)', border: '#1c1c1c', textColor: '#1c1c1c',
      });
    }
  }

  // 底部装饰条纹
  if (layout.decoOn && tpl.decoStrip && tpl.decoStrip.length) {
    const n = tpl.decoStrip.length, hh = 3.5;
    tpl.decoStrip.forEach((c, i) => {
      s.push({ type: 'strip', x: (W / n) * i, y: D - hh, w: W / n + 0.5, h: hh, bg: c });
    });
  }

  return s;
}

/** 绘制区块 → SVG parts（px 坐标；off 为出血/边距偏移，px 为 mm→px 换算函数）
 * proc: 'none'|'gold'|'silver' — 烫金/烫银时品牌条/产品名/系列标签/卖点标题文字改用金属渐变（url(#procMetal)，由 buildSvg 注入 defs） */
function drawLayoutSections(parts, sections, px, off, proc) {
  const metal = proc === 'gold' || proc === 'silver';
  const textFill = (secColor) => (metal && secColor ? 'url(#procMetal)' : secColor);
  if (!parts || !sections || !sections.length) return;
  for (const sec of sections) {
    const x = px(sec.x) + off, y = px(sec.y) + off, w = px(sec.w), h = px(sec.h);
    if (sec.type === 'bar') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sec.bg}"/>`);
      if (sec.image) {
        // v0.7.0：品牌 logo 图片（contain 居中，左右各留 2mm；高度约占条高 80%）
        const iw = Math.min(w - 4, (h * 0.8) * 3); // 上限宽高比 3:1，防超宽图压扁
        const ih = h * 0.8;
        parts.push(`<image x="${x + (w - iw) / 2}" y="${y + (h - ih) / 2}" width="${iw}" height="${ih}" preserveAspectRatio="xMidYMid meet" href="${sec.image}"/>`);
      } else if (sec.text) {
        parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + px(sec.fontSize) * 0.36}" text-anchor="middle" font-size="${px(sec.fontSize)}" font-weight="${sec.bold ? 'bold' : 'normal'}" fill="${textFill(sec.color)}">${escXml(sec.text)}</text>`);
      }
    } else if (sec.type === 'box') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="${sec.bg}" stroke="${sec.stroke || 'none'}" stroke-width="0.6"/>`);
      parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + px(sec.fontSize) * 0.36}" text-anchor="middle" font-size="${px(sec.fontSize)}" font-weight="${sec.bold ? 'bold' : 'normal'}" fill="${textFill(sec.color)}">${escXml(sec.text)}</text>`);
    } else if (sec.type === 'sell') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sec.bg}"/>`);
      parts.push(`<text x="${x + w / 2}" y="${y + px(sec.titleSize) + 1}" text-anchor="middle" font-size="${px(sec.titleSize)}" font-weight="bold" fill="${textFill(sec.titleColor)}">${escXml(sec.title)}</text>`);
      if (sec.sub) {
        parts.push(`<text x="${x + w / 2}" y="${y + px(sec.titleSize) + px(sec.subSize) + 5}" text-anchor="middle" font-size="${px(sec.subSize)}" fill="${sec.subColor}">${escXml(sec.sub)}</text>`);
      }
    } else if (sec.type === 'grid') {
      const n = sec.items.length;
      const cols = sec.cols || 1;
      const rows = Math.ceil(n / cols);
      const cellW = w / cols;
      const cellH = Math.min(h / rows, 22);
      sec.items.forEach((it, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        const cx = x + c * cellW, cy = y + r * cellH;
        if (it.image) {
          // 自动配图格：图片铺满 + 编号角标
          parts.push(`<image x="${cx + 1.5}" y="${cy + 1.5}" width="${cellW - 3}" height="${cellH - 3}" preserveAspectRatio="xMidYMid slice" href="${it.image}"/>`);
          parts.push(`<rect x="${cx + 1}" y="${cy + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="2" fill="none" stroke="${sec.border}" stroke-width="0.8"/>`);
          const no = String(it.no || (i + 1));
          parts.push(`<text x="${cx + 5}" y="${cy + 11}" font-size="${px(3.4)}" font-weight="bold" fill="#ffffff" stroke="#1c1c1c" stroke-width="0.6">${escXml(no)}</text>`);
        } else {
          parts.push(`<rect x="${cx + 1}" y="${cy + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="2" fill="${sec.cellBg}" stroke="${sec.border}" stroke-width="0.8"/>`);
          const no = String(it.no || (i + 1));
          parts.push(`<text x="${cx + 5}" y="${cy + cellH * 0.42}" font-size="${px(3.6)}" font-weight="bold" fill="${sec.textColor}">${escXml(no)}</text>`);
          parts.push(`<text x="${cx + cellW - 4}" y="${cy + cellH * 0.42}" text-anchor="end" font-size="${px(3.6)}" fill="${sec.textColor}">${escXml(it.name || '')}</text>`);
        }
      });
    } else if (sec.type === 'strip') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sec.bg}"/>`);
    } else if (sec.type === 'badge') {
      // v0.7.0 功能徽章：圆角矩形 + 可选图标（小圆点/星形等预设）+ 文字
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h * 0.45}" fill="${sec.bg}" stroke="#ffffff" stroke-width="0.5"/>`);
      let tx = x + w / 2;
      if (sec.icon) {
        const cr = h * 0.26;
        const cx0 = x + h * 0.62;
        const cy0 = y + h / 2;
        if (sec.icon === 'star') {
          parts.push(`<path d="M ${cx0} ${cy0 - cr} L ${cx0 + cr * 0.4} ${cy0 - cr * 0.3} L ${cx0 + cr} ${cy0 - cr * 0.3} L ${cx0 + cr * 0.5} ${cy0 + cr * 0.1} L ${cx0 + cr * 0.65} ${cy0 + cr * 0.75} L ${cx0} ${cy0 + cr * 0.4} L ${cx0 - cr * 0.65} ${cy0 + cr * 0.75} L ${cx0 - cr * 0.5} ${cy0 + cr * 0.1} L ${cx0 - cr} ${cy0 - cr * 0.3} L ${cx0 - cr * 0.4} ${cy0 - cr * 0.3} Z" fill="#ffffff"/>`);
        } else if (sec.icon === 'bolt') {
          parts.push(`<path d="M ${cx0 - cr * 0.5} ${cy0 - cr * 1.1} L ${cx0 + cr * 0.55} ${cy0 - cr * 1.1} L ${cx0 + cr * 0.15} ${cy0 - cr * 0.15} L ${cx0 + cr * 0.7} ${cy0 - cr * 0.15} L ${cx0 - cr * 0.5} ${cy0 + cr * 1.1} L ${cx0 - cr * 0.12} ${cy0 + cr * 0.05} L ${cx0 - cr * 0.65} ${cy0 + cr * 0.05} Z" fill="#ffffff"/>`);
        } else if (sec.icon === 'sound') {
          parts.push(`<path d="M ${cx0 - cr * 0.9} ${cy0 - cr * 0.5} L ${cx0 - cr * 0.4} ${cy0 - cr * 0.5} L ${cx0 + cr * 0.35} ${cy0 - cr} L ${cx0 + cr * 0.35} ${cy0 + cr} L ${cx0 - cr * 0.4} ${cy0 + cr * 0.5} L ${cx0 - cr * 0.9} ${cy0 + cr * 0.5} Z" fill="#ffffff"/>`);
        } else if (sec.icon === 'wheel') {
          parts.push(`<circle cx="${cx0}" cy="${cy0}" r="${cr * 0.85}" fill="none" stroke="#ffffff" stroke-width="${h * 0.12}"/>`);
          parts.push(`<circle cx="${cx0}" cy="${cy0}" r="${cr * 0.28}" fill="#ffffff"/>`);
        } else if (sec.icon === 'car') {
          parts.push(`<path d="M ${cx0 - cr} ${cy0 + cr * 0.3} L ${cx0 - cr * 0.7} ${cy0 - cr * 0.2} L ${cx0 + cr * 0.2} ${cy0 - cr * 0.2} L ${cx0 + cr * 0.7} ${cy0 + cr * 0.1} L ${cx0 + cr * 0.9} ${cy0 + cr * 0.3} L ${cx0 - cr} ${cy0 + cr * 0.3} Z" fill="#ffffff"/>`);
          parts.push(`<circle cx="${cx0 - cr * 0.55}" cy="${cy0 + cr * 0.38}" r="${cr * 0.22}" fill="#ffffff"/>`);
          parts.push(`<circle cx="${cx0 + cr * 0.55}" cy="${cy0 + cr * 0.38}" r="${cr * 0.22}" fill="#ffffff"/>`);
        } else {
          parts.push(`<circle cx="${cx0}" cy="${cy0}" r="${cr * 0.6}" fill="#ffffff"/>`);
        }
        tx = x + h * 1.35 + (w - h * 1.35) / 2;
      }
      if (sec.text) {
        parts.push(`<text x="${tx}" y="${y + h / 2 + px(sec.fontSize || 4.5) * 0.36}" text-anchor="middle" font-size="${px(sec.fontSize || 4.5)}" font-weight="bold" fill="${sec.color}">${escXml(sec.text)}</text>`);
      }
    }
  }
}

/** 折线 → 平滑曲线 path（二次贝塞尔中点平滑；自由绘画/自定义窗口渲染用） */
function smoothPath(pts) {
  if (!pts || pts.length < 2) return '';
  let d = 'M ' + pts[0].x + ' ' + pts[0].y;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += ' Q ' + pts[i].x + ' ' + pts[i].y + ' ' + mx + ' ' + my;
  }
  const last = pts[pts.length - 1];
  d += ' L ' + last.x + ' ' + last.y;
  return d;
}

/** SVG path 数据 → 点序列（支持 M/L/H/V/Q/T/C/S/Z，大小写绝对/相对；贝塞尔按段采样） */
function parseSvgPath(d) {
  const tokens = String(d || '').match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const pts = [];
  let i = 0, x = 0, y = 0, sx = 0, sy = 0, cmd = 'M', lc = null;
  const num = () => { const v = parseFloat(tokens[i]); i++; return v; };
  const cur = (rel) => (rel ? x : 0);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) { cmd = t; i++; if (cmd === 'z' || cmd === 'Z') { x = sx; y = sy; lc = null; continue; } }
    const up = cmd.toUpperCase(), rel = cmd === cmd.toLowerCase() && up !== 'Z';
    if (up === 'M') {
      const nx = num() + cur(rel), ny = num() + cur(rel);
      x = nx; y = ny; sx = x; sy = y; pts.push({ x, y }); cmd = rel ? 'l' : 'L';
    } else if (up === 'L') {
      const nx = num() + cur(rel), ny = num() + cur(rel);
      x = nx; y = ny; pts.push({ x, y }); lc = null;
    } else if (up === 'H') {
      x = num() + cur(rel); pts.push({ x, y }); lc = null;
    } else if (up === 'V') {
      y = num() + cur(rel); pts.push({ x, y }); lc = null;
    } else if (up === 'Q') {
      const cx = num() + cur(rel), cy = num() + cur(rel), nx = num() + cur(rel), ny = num() + cur(rel);
      for (let s = 1; s <= 10; s++) {
        const t2 = s / 10, t1 = 1 - t2;
        pts.push({ x: t1 * t1 * x + 2 * t1 * t2 * cx + t2 * t2 * nx, y: t1 * t1 * y + 2 * t1 * t2 * cy + t2 * t2 * ny });
      }
      x = nx; y = ny; lc = { x: cx, y: cy };
    } else if (up === 'T') {
      const cx = lc ? 2 * x - lc.x : x, cy = lc ? 2 * y - lc.y : y;
      const nx = num() + cur(rel), ny = num() + cur(rel);
      for (let s = 1; s <= 10; s++) {
        const t2 = s / 10, t1 = 1 - t2;
        pts.push({ x: t1 * t1 * x + 2 * t1 * t2 * cx + t2 * t2 * nx, y: t1 * t1 * y + 2 * t1 * t2 * cy + t2 * t2 * ny });
      }
      x = nx; y = ny; lc = { x: cx, y: cy };
    } else if (up === 'C') {
      const c1x = num() + cur(rel), c1y = num() + cur(rel), c2x = num() + cur(rel), c2y = num() + cur(rel), nx = num() + cur(rel), ny = num() + cur(rel);
      for (let s = 1; s <= 15; s++) {
        const t2 = s / 15, t1 = 1 - t2;
        pts.push({
          x: t1 * t1 * t1 * x + 3 * t1 * t1 * t2 * c1x + 3 * t1 * t2 * t2 * c2x + t2 * t2 * t2 * nx,
          y: t1 * t1 * t1 * y + 3 * t1 * t1 * t2 * c1y + 3 * t1 * t2 * t2 * c2y + t2 * t2 * t2 * ny,
        });
      }
      x = nx; y = ny; lc = { x: c2x, y: c2y };
    } else if (up === 'S') {
      const c1x = lc ? 2 * x - lc.x : x, c1y = lc ? 2 * y - lc.y : y;
      const c2x = num() + cur(rel), c2y = num() + cur(rel), nx = num() + cur(rel), ny = num() + cur(rel);
      for (let s = 1; s <= 15; s++) {
        const t2 = s / 15, t1 = 1 - t2;
        pts.push({
          x: t1 * t1 * t1 * x + 3 * t1 * t1 * t2 * c1x + 3 * t1 * t2 * t2 * c2x + t2 * t2 * t2 * nx,
          y: t1 * t1 * t1 * y + 3 * t1 * t1 * t2 * c1y + 3 * t1 * t2 * t2 * c2y + t2 * t2 * t2 * ny,
        });
      }
      x = nx; y = ny; lc = { x: c2x, y: c2y };
    } else { i++; }
  }
  return pts;
}

/** 应用 用户拖拽的位置覆盖：blocks[id] = { x, y, w, h }（mm，相对面板左上角）；缺省区块保持自动布局 */
function applyBlockOverrides(sections, blocks) {
  if (!blocks) return sections;
  return sections.map((sec) => {
    const o = blocks[sec.id];
    if (!o || !sec.draggable) return sec;
    return Object.assign({}, sec, { x: o.x, y: o.y, w: o.w, h: o.h });
  });
}

/** 拖拽交互层（仅预览 interactive 模式）：命中区 + 8 向缩放手柄（data-lay=data-dir） */
function drawLayoutHandles(parts, sections, px, off) {
  if (!parts || !sections) return;
  for (const sec of sections) {
    if (!sec.draggable) continue;
    const x = px(sec.x) + off, y = px(sec.y) + off, w = px(sec.w), h = px(sec.h);
    if (w < 8 || h < 8) continue;
    parts.push(`<rect class="lay-body" data-lay="${sec.id}" x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent" style="cursor:move"/>`);
    const hs = 6;
    const dirs = [
      ['nw', x, y, 'nwse-resize'], ['ne', x + w, y, 'nesw-resize'],
      ['se', x + w, y + h, 'nwse-resize'], ['sw', x, y + h, 'nesw-resize'],
      ['n', x + w / 2, y, 'ns-resize'], ['e', x + w, y + h / 2, 'ew-resize'],
      ['s', x + w / 2, y + h, 'ns-resize'], ['w', x, y + h / 2, 'ew-resize'],
    ];
    for (const d of dirs) {
      parts.push(`<rect class="lay-handle" data-lay="${sec.id}" data-dir="${d[0]}" x="${d[1] - hs}" y="${d[2] - hs}" width="${hs * 2}" height="${hs * 2}" rx="1.5" fill="#ffffff" stroke="#2b5797" stroke-width="1" style="cursor:${d[3]}"/>`);
    }
  }
}

// 双兼容导出：浏览器 script（挂 window 全局）与 CommonJS（测试/Node 环境）
if (typeof window !== 'undefined') {
  window.LAYOUT_TEMPLATES = LAYOUT_TEMPLATES;
  window.layoutSections = layoutSections;
  window.drawLayoutSections = drawLayoutSections;
  window.applyBlockOverrides = applyBlockOverrides;
  window.drawLayoutHandles = drawLayoutHandles;
  window.smoothPath = smoothPath;
  window.parseSvgPath = parseSvgPath;
  window.escXml = escXml;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LAYOUT_TEMPLATES, layoutSections, drawLayoutSections, applyBlockOverrides, drawLayoutHandles, smoothPath, parseSvgPath, escXml };
}