/* psbridge.js - CEP 面板 → ExtendScript 桥（M1）
 * 说明：所有对 Photoshop 的操作统一走 evalScript 调用 host.jsx 里的 hostHandleCommand，
 * 参数/结果均为 JSON 字符串；错误统一包装为 { ok:false, error }。
 * 兼容：CEP 8/9（Chromium 57/61），ES5 语法，不用可选链/箭头函数外的现代特性。 */
(function () {
  'use strict';

  function call(name, args) {
    return new Promise(function (resolve, reject) {
      var cs = window.CSInterface;
      if (!cs) { reject(new Error('CEP 环境不可用（CSInterface 未加载）')); return; }
      var payload = JSON.stringify({ name: name, args: args || {} });
      var script = 'hostHandleCommand(' + JSON.stringify(payload) + ')';
      cs.evalScript(script, function (res) {
        if (typeof res !== 'string' || res === '') {
          reject(new Error('PS 无响应（请确认 Photoshop 已打开）'));
          return;
        }
        var parsed;
        try { parsed = JSON.parse(res); } catch (e) {
          reject(new Error('PS 返回解析失败'));
          return;
        }
        if (parsed && parsed.ok) resolve(parsed.result);
        else reject(new Error((parsed && parsed.error) || '未知错误'));
      });
    });
  }

  window.psbridge = {
    ping: function () { return call('ping'); },
    createDoc: function (args) { return call('createDoc', args); },
    createLayerGroup: function (args) { return call('createLayerGroup', args); },
    placeImage: function (args) { return call('placeImage', args); },
    drawDieLine: function (args) { return call('drawDieLine', args); },
    placeText: function (args) { return call('placeText', args); },
  };
})();
