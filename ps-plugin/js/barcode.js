/* barcode.js - 条码逻辑（M3，F4）
 * 兼容：CEP 8/9（Chromium 57/61，ES5）。依赖 js/vendor/JsBarcode.all.min.js（window.JsBarcode）。
 * 流程：校验 → JsBarcode 生成 SVG → canvas 转 PNG dataURL → 复用 placeImage 通道入文档。
 * 校验规则与独立版 renderer/app.js 一致（EAN-13 13 位 / UPC-A 12 位 + 校验位验证）。 */
(function () {
  'use strict';

  /** EAN-13 校验位验证（权重 1,3 交替） */
  function checkEan13(v) {
    var d = String(v).split('');
    if (d.length !== 13) return false;
    var sum = 0;
    for (var i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10 === Number(d[12]);
  }

  /** UPC-A 校验位验证（12 位：11 位数据 + 1 位校验，权重 3,1 交替且首位乘 3） */
  function checkUpcA(v) {
    var d = String(v).split('');
    if (d.length !== 12) return false;
    var sum = 0;
    for (var i = 0; i < 11; i++) sum += Number(d[i]) * (i % 2 === 0 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === Number(d[11]);
  }

  /** 校验条码，返回 { ok, msg } */
  function validate(format, value) {
    var v = String(value || '').trim();
    if (!v) return { ok: false, msg: '请输入条码内容' };
    if (format === 'EAN13') {
      if (!/^\d{13}$/.test(v)) return { ok: false, msg: 'EAN-13 需要 13 位数字（当前 ' + v.length + ' 位）' };
      if (!checkEan13(v)) return { ok: false, msg: 'EAN-13 校验位不正确' };
    } else if (format === 'UPC') {
      if (!/^\d{12}$/.test(v)) return { ok: false, msg: 'UPC-A 需要 12 位数字（当前 ' + v.length + ' 位）' };
      if (!checkUpcA(v)) return { ok: false, msg: 'UPC-A 校验位不正确' };
    } else if (format === 'CODE128') {
      if (!v) return { ok: false, msg: 'Code128 内容不能为空' };
    }
    return { ok: true, msg: '' };
  }

  /**
   * 生成条码 PNG dataURL（白底，含下方数字）。返回 { dataUrl, w, h }（w/h 为 canvas 像素尺寸）；
   * 失败返回 null。
   * 实现：JsBarcode 直接渲染到 <canvas>（同步，无需 SVG→Image 异步加载），再 toDataURL。
   */
  function makeBarcodePng(format, value) {
    if (typeof JsBarcode === 'undefined') return null;
    var v = String(value || '').trim();
    var canvas;
    try {
      canvas = document.createElement('canvas');
      JsBarcode(canvas, v, {
        format: format, displayValue: true, width: 2, height: 60,
        margin: 4, fontSize: 16, flat: true, background: '#ffffff',
      });
    } catch (e) {
      return null;
    }
    var w = canvas.width;
    var h = canvas.height;
    if (!(w > 0) || !(h > 0)) return null;
    try {
      return { dataUrl: canvas.toDataURL('image/png'), w: w, h: h };
    } catch (e) {
      return null;
    }
  }

  window.toyboxBarcode = {
    checkEan13: checkEan13,
    checkUpcA: checkUpcA,
    validate: validate,
    makeBarcodePng: makeBarcodePng,
  };
})();
