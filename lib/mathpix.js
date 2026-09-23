export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// v3/text permits a 5 MB multipart body. Leave room for options and MIME boundaries.
export const MAX_IMAGE_UPLOAD_BYTES = 4_900_000;
function sizeError(path) {
  return new ApiError(path === '/v3/text'
    ? '图片超过 Mathpix 的单次请求限制。请在“原图”中点击“裁剪为新截图”，只保留题目区域，或分成几张图片识别。'
    : path === '/v3/converter'
      ? 'Word 转换内容超过 Mathpix 的请求限制，请将正文分段后导出。'
      : '文件超过 Mathpix 的请求大小限制，请拆分文件后重试。', 413);
}
const tooLarge = data => data?.error_info?.id === 'sys_request_too_large' ||
  /(?:request|payload|entity)\s+too\s+large/i.test(String(data?.error_info?.message || data?.error || ''));

export class MathpixClient {
  constructor({ credentials, fetchImpl = fetch, base = 'https://api.mathpix.com' }) {
    this.credentials = credentials; this.fetch = fetchImpl; this.base = base;
  }
  async request(path, { method = 'GET', json, form, format = 'json', signal } = {}) {
    const { appId, appKey } = this.credentials();
    const filesApi = path.startsWith('/files/');
    if (!appKey || (!filesApi && !appId)) throw new ApiError('请先在 API 设置中填写 App ID 和 App Key。官方识别和 Word 转换需要 API 凭据。', 428);
    let res;
    try {
      res = await this.fetch(this.base + path, {
        method, headers: { ...(!filesApi ? { app_id:appId } : {}), app_key: appKey, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        redirect: 'error',
      });
    } catch (e) {
      const error = new ApiError(e.name === 'TimeoutError'
        ? 'Mathpix 请求超时。提交结果可能已在云端创建，请先检查控制台，避免重复付费。'
        : '无法连接 Mathpix。请检查网络。若是提交请求，请先检查控制台再重试，以免重复计费。', 502);
      error.transient = method === 'GET'; error.uncertain = method === 'POST'; throw error;
    }
    if (res.status === 202 && format !== 'json') { const error = new ApiError('输出格式仍在生成，请稍候。', 409); error.pending = true; throw error; }
    if (!res.ok) {
      if (res.status === 413) throw sizeError(path);
      const msg = { 401: 'App ID 或 App Key 无效，请检查 API 设置。', 403: 'API 没有权限，请检查密钥及账单是否已启用。', 429: 'API 额度或请求频率已达限制，请在 Mathpix 控制台检查。', 413: '文件超出 Mathpix 大小限制。' };
      let detail = '';
      let data;
      try { data = await res.json(); detail = data.error_info?.message || data.error || ''; } catch {}
      if (method === 'GET' && res.status === 404 && (data?.error === 'format_not_ready' || data?.error_info?.id === 'format_not_ready' || ['processing','loaded','received','split','pending'].includes(data?.status))) {
        const error = new ApiError('输出格式仍在生成，请稍候。', 409); error.pending = true; throw error;
      }
      if (tooLarge(data)) throw sizeError(path);
      const error = new ApiError(msg[res.status] || ('Mathpix 返回错误 ' + res.status + (detail ? '：' + String(detail).slice(0, 350) : '')), 502);
      error.transient = method === 'GET' && (res.status >= 500 || res.status === 429); error.uncertain = method === 'POST' && res.status >= 500; throw error;
    }
    if (format === 'buffer') return Buffer.from(await res.arrayBuffer());
    if (format === 'text') return res.text();
    const data = await res.json();
    if (tooLarge(data)) throw sizeError(path);
    if (data.error || data.error_info) throw new ApiError('Mathpix：' + (data.error_info?.message || data.error || '识别失败'), 422);
    return data;
  }
  async image(src,{documentLayout=true,autoRotate=true}={}) {
    const match = typeof src === 'string' && /^data:(image\/(png|jpeg|webp|bmp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(src);
    if (!match) throw new ApiError('图片数据无效，请重新导入 PNG、JPG、WEBP 或 BMP 图片。');
    const bytes = Buffer.from(match[3], 'base64');
    if (bytes.length > MAX_IMAGE_UPLOAD_BYTES) throw new ApiError(
      '原图为 ' + (bytes.length / 1_000_000).toFixed(2) + ' MB，超过图片直传的 4.90 MB 安全上限。请在“原图”中裁剪题目区域或分成几张图片后再识别；本次尚未上传。', 413);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: match[1] }), 'screenshot.' + (match[2] === 'jpeg' ? 'jpg' : match[2]));
    form.append('options_json', JSON.stringify({
      formats: ['text', 'data', 'latex_styled'], data_options: { include_latex: true, include_mathml: true },
      include_line_data: true, math_inline_delimiters: ['$', '$'], math_display_delimiters: ['$$', '$$'],
      enable_document_layout: documentLayout, auto_rotate_confidence_threshold:autoRotate?0.99:1, disable_itemize: true, disable_lstlisting: true,
      metadata: { improve_mathpix: false },
    }));
    return this.request('/v3/text', { method: 'POST', form });
  }
  pdf(buffer, filename, pages = '') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
    form.append('options_json', JSON.stringify({
      math_inline_delimiters: ['$', '$'], math_display_delimiters: ['$$', '$$'],
      include_page_breaks: true, disable_itemize: true, disable_lstlisting: true, conversion_formats: { docx: true },
      metadata: { improve_mathpix: false }, ...(pages ? { page_ranges: pages } : {}),
    }));
    return this.request('/v3/pdf', { method: 'POST', form });
  }
  strokes(coordinates) {
    const json={strokes:{strokes:coordinates},formats:['text','latex_styled'],math_inline_delimiters:['$','$'],math_display_delimiters:['$$','$$'],idiomatic_eqn_arrays:true,metadata:{improve_mathpix:false}};
    if(Buffer.byteLength(JSON.stringify(json))>500000) throw new ApiError('笔迹数据超过限制，请分成几个公式识别。',413);
    return this.request('/v3/strokes',{method:'POST',json});
  }
  usage(range) { return this.request('/v3/ocr-usage?'+new URLSearchParams({...range,group_by:'usage_type',timespan:'day'})); }
  pdfStatus(id) { return this.request('/v3/pdf/' + encodeURIComponent(id)); }
  pdfText(id) { return this.request('/v3/pdf/' + encodeURIComponent(id) + '.mmd', { format: 'text' }); }
  pdfDocx(id) { return this.request('/v3/pdf/' + encodeURIComponent(id) + '.docx', { format: 'buffer' }); }
  document(buffer, filename, pages, mode, signal) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type:'application/pdf' }), filename);
    form.append('options_json', JSON.stringify({
      math_inline_delimiters:['$', '$'], math_display_delimiters:['$$', '$$'],
      include_page_breaks:true, disable_itemize:true, disable_lstlisting:true,
      conversion_formats:{ docx:true, md:true, 'md.zip':true }, metadata:{ improve_mathpix:false },
      ...(pages ? { page_ranges:pages } : {}),
    }));
    return this.request(mode === 'files' ? '/files/v1' : '/v3/pdf', { method:'POST', form, signal });
  }
  documentStatus(id, mode, signal) { return this.request((mode === 'files' ? '/files/v1/' : '/v3/pdf/') + encodeURIComponent(id), { signal }); }
  documentFormats(id, signal) { return this.request('/v3/converter/' + encodeURIComponent(id), { signal }); }
  documentOutput(id, mode, ext, signal) {
    if (!['docx','mmd','md.zip'].includes(ext)) throw new ApiError('不支持的文档输出格式。');
    return this.request((mode === 'files' ? '/files/v1/' : '/v3/pdf/') + encodeURIComponent(id) + '.' + ext, { format:'buffer', signal });
  }
  convert(mmd) {
    return this.request('/v3/converter', { method: 'POST', json: { mmd, formats: { docx: true }, metadata: { improve_mathpix: false } } });
  }
  convertStatus(id) { return this.request('/v3/converter/' + encodeURIComponent(id)); }
  docx(id) { return this.request('/v3/converter/' + encodeURIComponent(id) + '.docx', { format: 'buffer' }); }
}

export function conversionState(data) {
  const docx = data.conversion_status?.docx;
  if (data.status === 'error' || docx?.status === 'error') return 'error';
  return docx?.status === 'completed' ? 'completed' : 'processing';
}
