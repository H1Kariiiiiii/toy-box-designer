'use strict';
/* layoutTemplates.js - 版面套版模板（中改：多区块版面"填内容即套版"）
 * 纯渲染逻辑：输入版面数据 + front 面板（mm 坐标）→ 区块列表 → SVG parts。
 * 兼容：renderer 环境（ES2017），无外部依赖。
 * 区块类型：bar（品牌条）/ box（产品名/系列标签）/ sell（卖点区）/ grid（系列网格）/ strip（装饰条） */

// 套版模板定义（配色 + 区块参数）
const LAYOUT_TEMPLATES = {
  farm: { // 农场经典（仿实物：黑底黄字品牌条 + 绿底卖点区 + 三色装饰条）
    label: '农场经典',
    brandBar: { bg: '#1c1c1c', text: '#ffd400', hMm: 13 },
    seriesTag: { bg: '#ffd400', text: '#1c1c1c' },
    sellBlock: { bg: '#2e7d32', title: '#ffd400', sub: '#ffffff' },
    productName: { bg: '#ffffff', text: '#1c1c1c' },
    decoStrip: ['#2e7d32', '#4a4a4a', '#111111'],
  },
  clean: { // 简约白（黑底白字 + 灰阶装饰条）
    label: '简约白',
    brandBar: { bg: '#1c1c1c', text: '#ffffff', hMm: 11 },
    seriesTag: { bg: '#1c1c1c', text: '#ffffff' },
    sellBlock: { bg: '#1c1c1c', title: '#ffffff', sub: '#cccccc' },
    productName: { bg: '#ffffff', text: '#1c1c1c' },
    decoStrip: ['#1c1c1c', '#888888', '#eeeeee'],
  },
};

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 区块布局计算：相对 front 面板（mm 坐标，原点=front 左上角）
 * @param {object} layout { template, brand, product, series, sellTitle, sellSub, gridItems:[{no,name}], decoOn }
 * @param {object} front  { x, y, w, h } 主视觉面板（mm）
 * @returns {Array} 区块列表（各 type 的绘制参数）
 */
function layoutSections(layout, front) {
  const tpl = LAYOUT_TEMPLATES[layout && layout.template] || LAYOUT_TEMPLATES.farm;
  if (!front || !(front.w > 0) || !(front.h > 0)) return [];
  const W = front.w, D = front.h;
  const margin = 4; // 内边距 mm
  const s = [];

  // 顶部品牌条
  if (layout.brand) {
    s.push({
      type: 'bar', x: 0, y: 0, w: W, h: tpl.brandBar.hMm,
      bg: tpl.brandBar.bg, text: layout.brand, color: tpl.brandBar.text,
      fontSize: Math.min(9, tpl.brandBar.hMm * 0.55), bold: true,
    });
  }

  // 产品名（品牌条下方）
  let y = (layout.brand ? tpl.brandBar.hMm : 0) + 2;
  if (layout.product) {
    s.push({
      type: 'box', x: margin, y: y, w: Math.min(W * 0.62, 96), h: 9,
      bg: tpl.productName.bg, text: layout.product, color: tpl.productName.text,
      fontSize: 6.5, bold: true, stroke: '#d0d0d0',
    });
    y += 11;
  }

  // 系列标签（右上角）
  if (layout.series) {
    const tw = Math.min(W * 0.34, 48);
    s.push({
      type: 'box', x: W - margin - tw, y: (layout.brand ? tpl.brandBar.hMm : 0) + 2, w: tw, h: 7,
      bg: tpl.seriesTag.bg, text: layout.series, color: tpl.seriesTag.text,
      fontSize: 5, bold: true,
    });
  }

  // 系列网格（右侧竖排，若有；避开顶部品牌/产品名区）
  if (layout.gridItems && layout.gridItems.length) {
    const gridW = Math.min(W * 0.32, 58);
    const gx = W - margin - gridW;
    const gy = Math.max(y + 2, (layout.brand ? tpl.brandBar.hMm : 0) + 11);
    const gh = Math.max(20, D - gy - (layout.sellTitle ? 24 : 8) - (layout.decoOn ? 6 : 0));
    s.push({
      type: 'grid', x: gx, y: gy, w: gridW, h: gh,
      items: layout.gridItems, cols: 1,
      cellBg: 'rgba(255,255,255,0.94)', border: '#1c1c1c', textColor: '#1c1c1c',
    });
  }

  // 底部卖点区
  if (layout.sellTitle) {
    s.push({
      type: 'sell', x: 0, y: D - 20, w: W, h: 18,
      bg: tpl.sellBlock.bg, title: layout.sellTitle, sub: layout.sellSub || '',
      titleColor: tpl.sellBlock.title, subColor: tpl.sellBlock.sub,
      titleSize: 8, subSize: 4.5,
    });
  }

  // 底部装饰条纹
  if (layout.decoOn && tpl.decoStrip.length) {
    const n = tpl.decoStrip.length, hh = 3.5;
    tpl.decoStrip.forEach((c, i) => {
      s.push({ type: 'strip', x: (W / n) * i, y: D - hh, w: W / n + 0.5, h: hh, bg: c });
    });
  }

  return s;
}

/** 绘制区块 → SVG parts（px 坐标；off 为出血/边距偏移，px 为 mm→px 换算函数） */
function drawLayoutSections(parts, sections, px, off) {
  if (!parts || !sections || !sections.length) return;
  for (const sec of sections) {
    const x = px(sec.x) + off, y = px(sec.y) + off, w = px(sec.w), h = px(sec.h);
    if (sec.type === 'bar') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sec.bg}"/>`);
      parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + px(sec.fontSize) * 0.36}" text-anchor="middle" font-size="${px(sec.fontSize)}" font-weight="${sec.bold ? 'bold' : 'normal'}" fill="${sec.color}">${escXml(sec.text)}</text>`);
    } else if (sec.type === 'box') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="${sec.bg}" stroke="${sec.stroke || 'none'}" stroke-width="0.6"/>`);
      parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + px(sec.fontSize) * 0.36}" text-anchor="middle" font-size="${px(sec.fontSize)}" font-weight="${sec.bold ? 'bold' : 'normal'}" fill="${sec.color}">${escXml(sec.text)}</text>`);
    } else if (sec.type === 'sell') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sec.bg}"/>`);
      parts.push(`<text x="${x + w / 2}" y="${y + px(sec.titleSize) + 1}" text-anchor="middle" font-size="${px(sec.titleSize)}" font-weight="bold" fill="${sec.titleColor}">${escXml(sec.title)}</text>`);
      if (sec.sub) {
        parts.push(`<text x="${x + w / 2}" y="${y + px(sec.titleSize) + px(sec.subSize) + 5}" text-anchor="middle" font-size="${px(sec.subSize)}" fill="${sec.subColor}">${escXml(sec.sub)}</text>`);
      }
    } else if (sec.type === 'grid') {
      const n = sec.items.length;
      const cellH = Math.min(h / n, 22);
      sec.items.forEach((it, i) => {
        const cy = y + i * cellH;
        parts.push(`<rect x="${x}" y="${cy}" width="${w}" height="${cellH - 2}" rx="2" fill="${sec.cellBg}" stroke="${sec.border}" stroke-width="0.8"/>`);
        const no = String(it.no || (i + 1));
        parts.push(`<text x="${x + 6}" y="${cy + cellH * 0.42}" font-size="${px(3.6)}" font-weight="bold" fill="${sec.textColor}">${escXml(no)}</text>`);
        parts.push(`<text x="${x + w - 4}" y="${cy + cellH * 0.42}" text-anchor="end" font-size="${px(3.6)}" fill="${sec.textColor}">${escXml(it.name || '')}</text>`);
      });
    } else if (sec.type === 'strip') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sec.bg}"/>`);
    }
  }
}

// 双兼容导出：浏览器 script（挂 window 全局）与 CommonJS（测试/Node 环境）
if (typeof window !== 'undefined') {
  window.LAYOUT_TEMPLATES = LAYOUT_TEMPLATES;
  window.layoutSections = layoutSections;
  window.drawLayoutSections = drawLayoutSections;
  window.escXml = escXml;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LAYOUT_TEMPLATES, layoutSections, drawLayoutSections, escXml };
}