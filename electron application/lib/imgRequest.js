'use strict';
// 统一构建 OpenAI 兼容文生图请求（火山方舟 / 硅基流动 / 智谱 / OpenAI / 通义 等）
// 规则：
//  - 文生图一律 POST {base}/images/generations（JSON），size 透传（像素或平台档位）
//  - 火山方舟特判：加 watermark:false、JSON 内联图生图（image 字段）
//  - 其他平台带参考图时：走 /images/edits（multipart/form-data，OpenAI 系标准）
//  - seed 透传（OpenAI / 智谱 / 通义 / 硅基流动等普遍支持）

const VOLCES_RE = /volces\.com|volcengine/i;

function isVolces(baseUrl) {
  return VOLCES_RE.test(String(baseUrl || ''));
}

/** 把 dataURL 拆成 { mime, buffer } */
function parseDataUrl(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;,]+);base64,(.+)$/s);
  if (!m) throw new Error('参考图格式无效（需 base64 dataURL）');
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl      接口地址（默认火山方舟）
 * @param {string} opts.model        模型 ID
 * @param {string} opts.prompt       提示词
 * @param {string} opts.size         尺寸（1024x1024 / 2048x2048 / 2K / 4K …透传）
 * @param {number|string} [opts.seed]  复现种子（透传）
 * @param {string} [opts.image]      参考图 dataURL（图生图）
 * @param {string} [opts.watermark]  水印三态：'off'（关闭无可见水印，默认）/ 'default'（跟随服务商，不传参）/ 'on'（开启可见 AI 标识）
 * @returns {{url:string, kind:'json'|'multipart', body:object|FormData, volces:boolean}}
 */
function buildImageRequest({ baseUrl, model, prompt, size, seed, image, watermark = 'off' }) {
  const base = String(baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const volces = isVolces(base);

  // 水印参数：非 'default' 才显式传参（不同平台参数名不同：火山/硅基用 watermark，OpenAI 用 add_watermark）
  function watermarkParam() {
    if (watermark === 'default') return null;
    const v = watermark === 'on'; // off → false（关闭）；on → true（可见标识）
    if (/openai\.com/i.test(base)) return { add_watermark: v };
    return { watermark: v };
  }

  if (image) {
    const { mime, buffer } = parseDataUrl(image);
    if (volces) {
      // 火山方舟：JSON 内联 base64
      return {
        url: `${base}/images/generations`,
        kind: 'json',
        volces,
        body: {
          model,
          prompt,
          size,
          response_format: 'b64_json',
          ...watermarkParam(),
          // 方舟 image 字段要求完整 data URL（裸 base64 报 "invalid url specified"）
          image: `data:${mime};base64,${buffer.toString('base64')}`,
          ...(seed !== undefined && seed !== '' ? { seed: Number(seed) } : {}), // 火山方舟要求整数 seed，字符串会被 400 拒绝
        },
      };
    }
    // 其他平台：/images/edits multipart（OpenAI 系标准）
    const fd = new FormData();
    fd.append('model', model);
    fd.append('prompt', prompt);
    fd.append('size', size);
    fd.append('response_format', 'b64_json');
    const wp = watermarkParam();
    if (wp) for (const [k, v] of Object.entries(wp)) fd.append(k, String(v));
    fd.append('image', new Blob([buffer], { type: mime }), 'reference.png');
    if (seed !== undefined && seed !== '') fd.append('seed', String(seed));
    return { url: `${base}/images/edits`, kind: 'multipart', volces, body: fd };
  }

  const body = {
    model,
    prompt,
    size,
    n: 1,
    response_format: 'b64_json',
    ...watermarkParam(),
    ...(seed !== undefined && seed !== '' ? { seed: Number(seed) } : {}), // seed 必须为整数（OpenAI 兼容 schema 拒绝字符串）
  };
  return { url: `${base}/images/generations`, kind: 'json', volces, body };
}

module.exports = { buildImageRequest, isVolces, parseDataUrl };
