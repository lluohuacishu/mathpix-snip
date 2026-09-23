import DOMPurify from 'dompurify';
import { createIcons, icons } from 'lucide';
import { selectedPages } from '../lib/pdf-options.js';
import { initInk, paintStrokes } from './ink.js';
import { initUsage } from './usage.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { token: '', settings: {}, items: [], current: null, formulas: [], dirty: false, tab: 'preview', busy: false, showFormulas: true };
let desktopState = null, desktopQueue = Promise.resolve();
let pdfMode = 'files', pdfRates = {files:0.0015,fast:0.005}, pdfDialogId, outputDirectory = '', originalSeq = 0;
const pdfActive = item => !!item?.pdfTask && ['submitting','processing','saving'].includes(item.pdfTask.status);
let toastTimer, saveTimer, renderTimer, pollTimer, wordTimer, renderSeq = 0, savePromise = Promise.resolve(), sourceUrl;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const icon = name => '<i data-lucide="' + name + '"></i>';
const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
const on = (selector, event, fn) => $(selector).addEventListener(event, e => Promise.resolve(fn(e)).catch(showError));

function toast(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 3500);
}
function showError(e) { toast(e?.message || String(e), true); }
async function api(url, { method = 'GET', body, binary = false } = {}) {
  let response;
  try {
    response = await fetch('/api' + url, { method, headers: { 'x-snip-token': state.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('本地服务连接中断，请重新双击启动工具。'); }
  if (!response.ok) { let message; try { message = (await response.json()).error; } catch {} throw new Error(message || '操作失败（' + response.status + '）'); }
  return binary ? response : response.json();
}
function modal(selector) { $(selector).showModal(); }
function updateSettings() {
  $('#mode').innerHTML = '<span class="dot"></span>' + (state.settings.configured ? 'API 已配置' : '尚未配置 API');
  $('#mode').classList.toggle('connected', state.settings.configured);
}
function openSettings() {
  $('#app-id').value = state.settings.appId || ''; $('#app-key').value = '';
  $('#app-key').placeholder = state.settings.configured ? state.settings.keyHint + ' · 留空保留现有密钥' : '输入你的 API 密钥';
  $('#remember').checked = !!state.settings.remember; $('#settings-error').hidden = true; modal('#settings-dialog');
}
function notice(message, error = false) {
  $('#notice > span').textContent = message; $('#notice').classList.toggle('error', error);
  $('#notice-action').hidden = !!state.settings.configured;
}
function updateNotice() {
  const i = state.current;
  if (!i) return notice('导入图片或 PDF，识别时默认准备官方 Word；未配置密钥也可以体验演示、编辑和复制公式。');
  if (i.pdfTask) {
    const task = i.pdfTask;
    if (task.error) return notice(task.error + ' 已成功生成的文件会保留。',true);
    if (task.status === 'completed') return notice('PDF 三份文件已保存：DOCX、普通 Markdown、原始 MMD。' + (task.openError || ''),!!task.openError);
    return notice('PDF 正在后台处理，关闭窗口后仍会继续。完成后自动保存三份文件并打开 Word。');
  }
  if (i.error) return notice(i.error, true);
  if (i.demo) return notice('演示示例 · 内容为预置文本，未调用 OCR。可体验编辑和复制公式；导出 Word 需要连接官方 API。');
  if (i.status === 'processing') return notice(i.pdfId ? 'PDF 正在云端识别，进度 ' + (i.progress || 0) + '%。离开后可返回此记录继续查询，不会重复提交。' : '图片正在识别，请稍候。');
  if (i.status === 'ready') return notice(state.settings.configured ? '文件已保存在本机。点击“开始识别”后上传到 Mathpix，默认同时准备官方 Word；OCR 按官方规则计费。' : '文件已导入。配置 API 后即可识别并生成官方 Word，当前不会上传文件。');
  if (i.kind === 'text') return notice('公式笔记 · 输入文字与 LaTeX 即可实时预览，导出 Word 使用 Mathpix 官方转换。');
  notice('识别已完成 · 点击预览中的公式复制 LaTeX。可对照原图校对，或在下方编辑后导出 Word。');
}
async function refreshHistory() { state.items = await api('/items'); drawHistory(); }
function drawHistory() {
  const q = $('#search').value.trim().toLowerCase();
  const items = state.items.filter(i => (i.title + i.excerpt).toLowerCase().includes(q));
  $('#history-count').textContent = state.items.length;
  $('#history').innerHTML = items.length ? items.map(i => '<button class="history-item ' + (i.id === state.current?.id ? 'active' : '') + '" data-id="' + i.id + '">' + icon(i.kind === 'pdf' ? 'files' : i.kind === 'text' ? 'file-pen-line' : 'scan-text') + '<span><strong>' + escape(i.title) + '</strong><small>' + (i.demo ? '演示示例' : new Date(i.createdAt).toLocaleDateString('zh-CN', { month:'short', day:'numeric' })) + ' · ' + ({ ready:'待识别', processing:'处理中', completed:'已保存', error:'需处理' }[i.status] || '已保存') + '</small></span></button>').join('') : '<p class="micro" style="padding:12px">暂无' + (q ? '匹配的' : '') + '记录</p>';
  $$('#history button').forEach(b => b.addEventListener('click', () => selectItem(b.dataset.id).catch(showError)));
  refreshIcons();
}
async function selectItem(id) {
  await saveCurrent(); const i = await api('/items/' + id); await showItem(i);
}
async function showItem(item) {
  clearTimeout(pollTimer); clearTimeout(renderTimer); clearTimeout(wordTimer); ++renderSeq;
  state.current = item; state.dirty = false; state.formulas = [];
  $('#title').value = item.title; $('#editor').value = item.mmd || ''; $('#editor').disabled = false;
  $('#demo-tag').hidden = !item.demo; $('#saved').textContent = '已保存到本机';
  $('#raw').textContent = JSON.stringify(item.raw || { mode: item.demo ? 'demo' : 'local', note: item.demo ? '预置示例，不含真实 API 响应或置信度。' : '尚无 API 返回数据。' }, null, 2);
  $('#char-count').textContent = (item.mmd || '').length.toLocaleString() + ' 字符';
  $('#confidence').innerHTML = '<span class="dot"></span>' + (item.demo ? '演示内容 · 无真实置信度' : item.editedAt ? '已人工编辑 · OCR 置信度仅适用于原始结果' : typeof item.confidence === 'number' ? '识别置信度 ' + (item.confidence * 100).toFixed(1) + '%' : item.status === 'completed' ? '已保存' : '等待识别');
  $('#recognize').disabled = state.busy || pdfActive(item) || item.demo || item.kind === 'text' || item.status === 'completed';
  $('#recognize').innerHTML = icon(item.pdfId ? 'refresh-cw' : 'scan-text') + (item.pdfId ? '继续查询' : '开始识别');
  $('#delete').disabled = state.busy; $('#crop').hidden = item.kind !== 'image' || item.demo;
  updateNotice(); drawOriginal(item).catch(showError); setTab(item.mmd ? 'preview' : 'original'); drawHistory();
  await renderPreview();
  if (pdfActive(item) || (item.pdfId && item.status === 'processing')) schedulePoll(item.id);
  $('#word-status').textContent = item.status === 'ready' ? '已选：识别时生成官方 Word' : item.word?.status === 'completed' ? '官方 Word 已准备好' : 'Word 使用官方转换';
  if (!item.pdfTask && (item.word || (item.wordRequested && item.status === 'completed'))) watchWord(item.id).catch(showError);
  updatePdfPanel();
  updateDesktopControls();
}
function updateDesktopControls() {
  const active = pdfActive(state.current) || (desktopState?.busy && desktopState.itemId === state.current?.id);
  $('#capture').disabled = !!desktopState?.busy;
  $('#recognize').disabled = state.busy || desktopState?.busy || active || !state.current || state.current.demo || state.current.kind === 'text' || state.current.status === 'completed';
  $('#delete').disabled = state.busy || active;
  $('#crop').disabled = active;
  $('#editor').disabled = !state.current || active;
  $('#title').disabled = active;
  if (active && !state.current?.pdfTask) notice('截图正在自动识别，请稍候…');
}
function updatePdfPanel() {
  const item = state.current, task = item?.pdfTask;
  $('#pdf-result').hidden = !task;
  if (!task) return;
  const stages = {submitting:'正在上传',processing:task.phase === 'queued' ? '排队中' : task.phase === 'converting' ? '正在生成文件' : '正在识别',saving:'正在保存',completed:'三份文件已保存',partial:'部分文件生成失败',error:'任务需处理',uncertain:'提交结果待核实'};
  $('#pdf-result-title').textContent = (task.mode === 'files' ? '经济模式 · Files API' : '快速模式 · v3/pdf') + ' · ' + stages[task.status];
  $('#pdf-result-detail').textContent = task.folder || ('处理 ' + (task.selectedPages || task.cloudPages || item.numPages || '未知') + ' 页，OCR 进度 ' + Math.round(item.progress || 0) + '%');
  $('#pdf-result-files').textContent = ['docx','md','mmd'].map(key => key.toUpperCase()+': '+({completed:'已保存',error:'失败',pending:'等待中'}[task.artifacts[key]?.status] || '等待中')).join('　');
  $('#pdf-open-folder').hidden = !task.folder;
  $('#pdf-open-word').hidden = task.artifacts.docx?.status !== 'completed';
  $('#pdf-resume').hidden = !task.remoteId || !['partial','error'].includes(task.status);
  $('#word-status').textContent = stages[task.status];
}
function openPdfOptions() {
  const item = state.current;
  if (!item || item.kind !== 'pdf') return;
  if (item.pdfTask) { updatePdfPanel(); return; }
  pdfDialogId = item.id; $('#pdf-name').textContent = item.title + ' · ' + (item.numPages ? item.numPages+' 页' : '页数未知');
  $('#pdf-pages').value = ''; $('#pdf-mode').value = pdfMode;
  $('#pdf-save-location').textContent = outputDirectory; updatePdfEstimate(); modal('#pdf-dialog');
}
async function openPdfOutput(kind) {
  const button = $(kind === 'folder' ? '#pdf-open-folder' : '#pdf-open-word');
  button.disabled = true;
  try {
    await api('/pdf/'+state.current.id+'/open',{method:'POST',body:{kind}});
    toast(kind === 'folder' ? '已请求资源管理器打开文件夹。' : '已请求打开 Word。');
  } finally { button.disabled = false; }
}
function updatePdfEstimate() {
  try {
    const selected = selectedPages($('#pdf-pages').value,state.current?.numPages);
    const mode = $('#pdf-mode').value, cost = selected.count == null ? null : selected.count*pdfRates[mode];
    $('#pdf-estimate').textContent = cost == null ? '按实际处理页数计费，页数暂无法预估。' : '预计 '+selected.count+' 页 · 约 $'+cost.toFixed(4)+' 美元（按起始单价估算，以官方账单为准）';
    $('#pdf-start').disabled = false;
  } catch (error) { $('#pdf-estimate').textContent = error.message; $('#pdf-start').disabled = true; }
}
async function startPdf() {
  if (!state.settings.configured) { $('#pdf-dialog').close(); openSettings(); return; }
  const id = pdfDialogId, mode = $('#pdf-mode').value, pages = $('#pdf-pages').value;
  $('#pdf-start').disabled = true;
  try {
    await saveCurrent();
    const request = api('/pdf/'+id+'/start',{method:'POST',body:{mode,pages}});
    $('#pdf-dialog').close(); state.busy = true; updateDesktopControls(); notice('正在上传 PDF 并创建云端任务…');
    const item = await request; pdfMode = mode;
    await refreshHistory(); if (state.current?.id === id) await showItem(item);
  } catch (error) { if (state.current?.id === id) await selectItem(id); throw error; }
  finally { state.busy = false; $('#pdf-start').disabled = false; updateDesktopControls(); }
}
function desktopChanged(next) {
  desktopQueue = desktopQueue.catch(showError).then(async () => {
    if (desktopState && next.revision <= desktopState.revision) return;
    desktopState = next;
    const note = $('#desktop-note'); note.hidden = false;
    note.textContent = next.detail || (next.registered ? 'Alt + Shift + Q：框选后可调整，Enter 确认识别 · 关闭窗口后仍在托盘运行 · Esc 取消截图' : '快捷键被占用，关闭冲突程序后会自动恢复。');
    note.classList.toggle('error', next.phase === 'error' || !next.registered);
    updateDesktopControls();
    if (next.itemId) {
      // Persist any previous edits before bringing the captured record forward.
      await saveCurrent(); await refreshHistory(); await selectItem(next.itemId);
      if (next.phase === 'error') showError(new Error(next.detail));
    }
    updateDesktopControls();
  });
  return desktopQueue;
}
async function watchWord(id, n = 0) {
  const mmd = state.current?.mmd;
  const result = await api('/export/cloud/' + id + '/status');
  if (state.current?.id !== id || state.dirty || state.current.mmd !== mmd) return;
  $('#word-status').textContent = result.status === 'completed' ? '官方 Word 已准备好' : result.status === 'error' ? 'Word 准备失败 · 点击导出查看' : '正在准备官方 Word…';
  $('#word-status').title = result.error || '';
  if (!['completed','error'].includes(result.status) && n < 180) wordTimer = setTimeout(() => watchWord(id, n + 1).catch(showError), 2000);
}
async function drawOriginal(i) {
  const seq = ++originalSeq;
  if (sourceUrl) { URL.revokeObjectURL(sourceUrl); sourceUrl = null; }
  $('#original').replaceChildren();
  if (i.strokes) {
    const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=450;canvas.style.maxWidth='100%';canvas.style.background='white';canvas.setAttribute('aria-label','保存的手写笔迹');
    paintStrokes(canvas,i.strokes.x.map((row,n)=>row.map((x,p)=>[x,i.strokes.y[n][p]])),i.inkTexts||[]);$('#original').append(canvas);return;
  }
  if (!i.source && !i.sourceFile) { $('#original').innerHTML = '<div class="empty-state">' + icon('file-pen-line') + '<p>这是手动创建的公式笔记，没有原始图片。</p></div>'; return; }
  if (i.kind === 'pdf') {
    let blob;
    if (i.sourceFile) blob = await (await api('/items/'+i.id+'/source',{binary:true})).blob();
    else { const data = atob(i.source.split(',')[1]); blob = new Blob([Uint8Array.from(data,c => c.charCodeAt(0))],{type:'application/pdf'}); }
    if (seq !== originalSeq) return;
    sourceUrl = URL.createObjectURL(blob);
    const frame = document.createElement('iframe'); frame.title = '原始 PDF'; frame.src = sourceUrl; $('#original').append(frame);
  } else { const img = new Image(); img.src = i.source; img.alt = i.demo ? '两圆公共弦的演示示意图，公式为预置内容，未调用 OCR。' : i.title; $('#original').append(img); }
}
function setTab(tab) {
  state.tab = tab;
  $$('[data-tab]').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
  ['preview','original','data'].forEach(t => $('#' + t + '-view').hidden = t !== tab);
  $('#equation-panel').hidden = tab !== 'preview' || !state.showFormulas;
}
async function renderPreview() {
  const seq = ++renderSeq, item = state.current, mmd = $('#editor').value;
  $('#char-count').textContent = mmd.length.toLocaleString() + ' 字符';
  if (!mmd.trim()) {
    $('#preview').innerHTML = '<div class="empty-state">' + icon('scan-text') + '<h2>' + (item?.kind === 'text' ? '写下第一个公式' : '等待识别结果') + '</h2><p>' + (item?.kind === 'text' ? '在下方输入 $x^2+y^2=r^2$ 试试' : '点击“开始识别”，或先配置你的 API 密钥') + '</p></div>'; state.formulas = []; drawFormulas(); refreshIcons(); return;
  }
  try {
    const { html } = await api('/render', { method:'POST', body:{ mmd } });
    if (seq !== renderSeq || item?.id !== state.current?.id) return;
    $('#preview').innerHTML = DOMPurify.sanitize(html, { ADD_TAGS:['mjx-container','mjx-assistive-mml','latex','mathml'], ADD_ATTR:['jax','overflow','focusable','xmlns:xlink'], FORBID_TAGS:['style','iframe','object','embed','script'] });
    state.formulas = $$('#preview latex').map(n => n.textContent.trim()).filter(Boolean);
    $$('#preview .math-inline, #preview .math-block').forEach(el => {
      const latex = el.querySelector('latex')?.textContent; if (!latex) return;
      el.title = '点击复制 LaTeX'; el.setAttribute('tabindex','0'); el.setAttribute('role','button'); el.setAttribute('aria-label','复制公式 ' + latex);
      el.addEventListener('click', () => copy(formatted(latex)).catch(showError));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(formatted(latex)).catch(showError); } });
    });
    drawFormulas();
  } catch (e) { if (seq === renderSeq) { $('#preview').textContent = e.message; state.formulas = []; drawFormulas(); } }
}
function formatted(tex) { return $('#delimiter').value === 'inline' ? '$' + tex + '$' : $('#delimiter').value === 'block' ? '$$\n' + tex + '\n$$' : tex; }
function drawFormulas() {
  $('#formula-count').textContent = state.formulas.length;
  $('#equations').innerHTML = state.formulas.length ? state.formulas.map((f, i) => '<button class="equation-item" data-index="' + i + '" title="复制 LaTeX"><span>' + String(i + 1).padStart(2,'0') + '</span><code>' + escape(f) + '</code>' + icon('copy') + '</button>').join('') : '<p class="micro">识别或输入公式后，会在这里逐条显示。</p>';
  $$('#equations button').forEach(b => b.addEventListener('click', () => copy(formatted(state.formulas[Number(b.dataset.index)])).catch(showError)));
  $('#copy-formulas').disabled = !state.formulas.length; refreshIcons();
}
async function copy(value) {
  if (!value?.trim()) return toast('暂无可复制的内容。');
  try { await navigator.clipboard.writeText(value); }
  catch { const t = document.createElement('textarea'); t.value = value; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.append(t); t.select(); const ok = document.execCommand('copy'); t.remove(); if (!ok) throw new Error('剪贴板权限被拒绝，请选中源码后按 Ctrl + C。'); }
  toast('已复制到剪贴板');
}
function saveCurrent() {
  clearTimeout(saveTimer);
  if (!state.current || !state.dirty) return savePromise;
  const id = state.current.id, mmd = $('#editor').value, title = $('#title').value;
  state.dirty = false; $('#saved').textContent = '正在保存…';
  savePromise = savePromise.catch(() => {}).then(async () => {
    try {
      const updated = await api('/items/' + id, { method:'PATCH', body:{ mmd, title } });
      if (state.current?.id === id && !state.dirty) {
        state.current = { ...updated }; $('#saved').textContent = '已保存到本机';
        $('#confidence').innerHTML = '<span class="dot"></span>' + (updated.demo ? '演示内容 · 无真实置信度' : '已人工编辑');
      }
      await refreshHistory();
    } catch (e) { if (state.current?.id === id) { state.dirty = true; $('#saved').textContent = '保存失败，请重试'; } throw e; }
  });
  return savePromise;
}
function markDirty() { state.dirty = true; $('#saved').textContent = '编辑中…'; clearTimeout(wordTimer); $('#word-status').textContent = '导出时检查并更新官方 Word'; clearTimeout(saveTimer); saveTimer = setTimeout(() => saveCurrent().catch(showError), 650); }
async function loadDemo() { await saveCurrent(); const i = await api('/demo', { method:'POST', body:{} }); await refreshHistory(); await showItem(i); }
async function readDataUrl(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('文件读取失败。')); r.readAsDataURL(file); }); }
async function importFile(file) {
  if (!file) return;
  await saveCurrent();
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name), kind = isPdf ? 'pdf' : 'image';
  if (isPdf) {
    if (file.size > 100*1024*1024) throw new Error('本地 PDF 导入上限为 100 MB，请先拆分较大的文件。');
    const response = await fetch('/api/pdf/import?title='+encodeURIComponent(file.name),{method:'POST',headers:{'x-snip-token':state.token,'Content-Type':'application/pdf'},body:file});
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'PDF 导入失败。');
    await refreshHistory(); await showItem(result); openPdfOptions(); return;
  }
  if (!isPdf && !/^image\/(png|jpeg|webp|bmp)$/.test(file.type)) throw new Error('支持 PNG、JPG、WEBP、BMP 图片和 PDF。');
  if (file.size > (isPdf ? 25 : 15) * 1024 * 1024) throw new Error(isPdf ? 'PDF 不得超过 25 MB。' : '图片不得超过 15 MB。');
  let source = await readDataUrl(file);
  if (isPdf) source = source.replace(/^data:[^;]*;/, 'data:application/pdf;');
  const i = await api('/items', { method:'POST', body:{ title: file.name || '粘贴截图 ' + new Date().toLocaleTimeString('zh-CN'), kind, source } });
  await refreshHistory(); await showItem(i); toast('已导入，默认准备官方 Word；点击“开始识别”即可');
}
async function pasteImage() {
  try {
    const entries = await navigator.clipboard.read();
    for (const entry of entries) { const type = entry.types.find(t => t.startsWith('image/')); if (type) { const blob = await entry.getType(type); await importFile(new File([blob], '粘贴截图 ' + new Date().toLocaleTimeString('zh-CN').replaceAll(':','-') + '.png', { type })); return; } }
    toast('剪贴板中没有图片。请先截图，再按 Ctrl + V。');
  } catch { toast('请先截图，然后在页面按 Ctrl + V 粘贴。', true); }
}
async function recognize(pages = '') {
  if (!state.current || state.busy || desktopState?.busy) return;
  if (!state.settings.configured) return openSettings();
  if (state.current.kind === 'pdf' && !state.current.pdfId) return openPdfOptions();
  if (state.current.pdfId) { await poll(state.current.id); return; }
  await saveCurrent();
  const id = state.current.id; state.busy = true; $('#recognize').disabled = true; $('#delete').disabled = true; $('#recognize').classList.add('busy');
  notice('正在提交识别请求，请稍候…');
  try { const i = await api('/recognize/' + id, { method:'POST', body:{ pages } }); await refreshHistory(); if (state.current?.id === id) await showItem(i); }
  catch (e) { if (state.current?.id === id) { const i = await api('/items/' + id); await showItem(i); } throw e; }
  finally { state.busy = false; $('#recognize').classList.remove('busy'); $('#recognize').disabled = !state.current || state.current.demo || state.current.kind === 'text' || state.current.status === 'completed'; $('#delete').disabled = false; }
}
function schedulePoll(id) { clearTimeout(pollTimer); pollTimer = setTimeout(() => poll(id).catch(e => { notice(e.message + ' 可点击“继续查询”重试。', true); }), 2400); }
async function poll(id) {
  const task = state.current?.id === id && state.current.pdfTask;
  const i = await api((task ? '/items/' : '/poll/') + id);
  await refreshHistory();
  if (state.current?.id !== id) return;
  if (task) {
    if (task.status !== i.pdfTask.status || i.mmd !== state.current.mmd) await showItem(i);
    else { state.current = i; updateNotice(); updatePdfPanel(); updateDesktopControls(); if (pdfActive(i)) schedulePoll(id); }
    return;
  }
  if (i.status === 'completed') { await showItem(i); toast('PDF 识别已完成'); }
  else { state.current = i; updateNotice(); if (i.status !== 'error') schedulePoll(id); }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function filename(ext, title = state.current?.title || '数学笔记') { return title.replace(/\.(png|jpe?g|webp|bmp|pdf)$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,90) + ext; }
let exporting = false;
async function openExport() {
  if (state.current?.pdfTask && !state.current.editedAt) {
    if (state.current.pdfTask.artifacts.docx?.status === 'completed') return api('/pdf/'+state.current.id+'/open',{method:'POST',body:{kind:'word'}});
    return toast('PDF 文件正在准备或需要处理，请查看任务状态。');
  }
  if (exporting) { modal('#export-dialog'); return; }
  if (!$('#editor').value.trim()) return toast('请先识别或输入内容。');
  modal('#export-dialog'); return exportCloud();
}
async function exportCloud() {
  if (exporting) return;
  if (!$('#editor').value.trim()) return toast('请先识别或输入内容。');
  const id = state.current.id;
  exporting = true; $('#export-cloud').hidden = true;
  try {
    await saveCurrent(); $('#export-status').textContent = '正在准备官方 Word 文档…';
    clearTimeout(wordTimer);
    await api('/export/cloud/' + id, { method:'POST', body:{} });
    for (let n = 0; n < 150; n++) {
      if (!$('#export-dialog').open) return;
      const result = await api('/export/cloud/' + id + '/status');
      if (result.status === 'error') throw new Error(result.error || 'Mathpix DOCX 转换失败，请检查内容后重试。');
      if (result.status === 'completed') {
        $('#export-status').textContent = '正在保存 Word，并用默认程序打开…';
        const saved = await api('/export/cloud/' + id + '/save', { method:'POST', body:{} });
        if (state.current?.id === id) { $('#word-status').textContent = saved.opened ? 'Word 已保存并打开' : 'Word 已保存'; $('#word-status').title = saved.path; }
        if (!saved.opened) throw new Error(saved.error + '\n文件位置：' + saved.path);
        $('#export-dialog').close(); toast('Word 已保存并打开：' + saved.path); return;
      }
      $('#export-status').textContent = 'Mathpix 正在生成 DOCX… 完成后保存并打开。关闭此窗口不会中止后台准备。';
      await new Promise(r => setTimeout(r,2000));
    }
    throw new Error('转换仍在进行。稍后再点击“导出 Word”即可继续查询已有任务。');
  } catch (e) { $('#export-status').textContent = e.message; throw e; }
  finally { exporting = false; $('#export-cloud').hidden = false; }
}

let cropImage, cropStart, cropRect;
async function openCrop() {
  cropImage = new Image(); cropImage.src = state.current.source; await cropImage.decode();
  const canvas = $('#crop-canvas'), scale = Math.min(1, 830 / cropImage.width, 550 / cropImage.height);
  canvas.width = Math.round(cropImage.width * scale); canvas.height = Math.round(cropImage.height * scale);
  cropStart = null; cropRect = null; paintCrop(); modal('#crop-dialog');
}
function paintCrop() {
  const c = $('#crop-canvas'), ctx = c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height); ctx.drawImage(cropImage,0,0,c.width,c.height);
  if (cropRect) { const { x,y,w,h } = cropRect; ctx.fillStyle = '#18351e66'; ctx.fillRect(0,0,c.width,c.height); ctx.drawImage(cropImage, x/c.width*cropImage.width,y/c.height*cropImage.height,w/c.width*cropImage.width,h/c.height*cropImage.height,x,y,w,h); ctx.strokeStyle = '#55b371'; ctx.lineWidth = 2; ctx.setLineDash([6,3]); ctx.strokeRect(x,y,w,h); }
}
function cropPoint(e) { const c = $('#crop-canvas'), r = c.getBoundingClientRect(); return { x:Math.max(0,Math.min(c.width,(e.clientX-r.left)*c.width/r.width)),y:Math.max(0,Math.min(c.height,(e.clientY-r.top)*c.height/r.height)) }; }

async function init() {
  refreshIcons();
  const boot = await api('/bootstrap'); state.token = boot.token; state.settings = boot.settings; updateSettings();
  pdfMode = boot.pdfMode || 'files'; pdfRates = boot.pdfRates || pdfRates; outputDirectory = boot.wordDirectory;
  $('#export-location').textContent = boot.wordDirectory || '当前用户的 Documents/Mathsnip';
  $$('.close').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  on('#welcome-configure','click',() => { $('#welcome-dialog').close(); openSettings(); });
  on('#welcome-demo','click',() => $('#welcome-dialog').close());
  $('#welcome-dialog').addEventListener('close',() => { try { localStorage.setItem('mathsnip-welcome-seen','1'); } catch {} });
  initInk({api,copy,saveCurrent,openItem:async item=>{await saveCurrent();await refreshHistory();await showItem(item);}});
  initUsage({api});
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  ['#settings-side','#mode','#notice-action'].forEach(s => on(s,'click',openSettings));
  ['#import','#import-side'].forEach(s => on(s,'click',() => $('#file').click()));
  on('#pdf-import','click',() => $('#pdf-file').click());
  on('#pdf-file','change',async e => { try { await importFile(e.target.files[0]); } finally { e.target.value = ''; } });
  on('#file','change',async e => { try { await importFile(e.target.files[0]); } finally { e.target.value = ''; } });
  on('#paste','click',pasteImage);
  on('#capture','click',async () => {
    await saveCurrent();
    if (window.desktopCapture) return window.desktopCapture.start();
    await api('/capture',{ method:'POST',body:{} }); toast('框选截图后，回到这里按 Ctrl + V 粘贴');
  });
  on('#demo','click',loadDemo); on('#empty-demo','click',loadDemo); on('#help','click',() => modal('#help-dialog'));
  on('#new-text','click',async () => { await saveCurrent(); const i = await api('/items',{ method:'POST',body:{ kind:'text',title:'新建公式笔记' } }); await refreshHistory(); await showItem(i); setTab('preview'); $('#editor').focus(); });
  on('#search','input',drawHistory);
  on('#editor','input',() => { markDirty(); clearTimeout(renderTimer); renderTimer = setTimeout(renderPreview,350); });
  on('#title','input',markDirty);
  on('#copy-all','click',() => copy($('#editor').value)); on('#editor-copy','click',() => copy($('#editor').value));
  on('#copy-formulas','click',() => copy(state.formulas.map(formatted).join('\n\n')));
  on('#equations-toggle','click',() => { state.showFormulas = !state.showFormulas; $('#equations-toggle').classList.toggle('active',state.showFormulas); setTab(state.tab); });
  on('#save-mmd','click',() => { if ($('#editor').value.trim()) download(new Blob([$('#editor').value],{ type:'text/markdown;charset=utf-8' }), filename('.mmd')); else toast('暂无可下载的内容。'); });
  on('#recognize','click',() => {
    if (!state.current) return $('#file').click();
    if (!state.settings.configured) return openSettings();
    if (state.current.kind === 'pdf' && !state.current.pdfId) return openPdfOptions();
    return recognize();
  });
  on('#pdf-start','click',startPdf);
  on('#pdf-pages','input',updatePdfEstimate); on('#pdf-mode','change',updatePdfEstimate);
  on('#pdf-resume','click',async () => { const id = state.current.id; await api('/pdf/'+id+'/resume',{method:'POST',body:{}}); await selectItem(id); });
  on('#pdf-open-word','click',() => openPdfOutput('word'));
  on('#pdf-open-folder','click',() => openPdfOutput('folder'));
  on('#export','click',openExport);
  on('#export-cloud','click',exportCloud);
  on('#show-key','click',() => { $('#app-key').type = $('#app-key').type === 'password' ? 'text' : 'password'; });
  on('#settings-form','submit',async e => {
    e.preventDefault(); const button = $('#settings-form button[type="submit"]'); button.disabled = true;
    try { state.settings = await api('/settings',{ method:'POST',body:{ appId:$('#app-id').value, appKey:$('#app-key').value, remember:$('#remember').checked } }); $('#app-key').value = ''; $('#settings-dialog').close(); updateSettings(); updateNotice(); toast('设置已保存；首次识别时会验证密钥'); }
    catch (err) { $('#settings-error').hidden = false; $('#settings-error').textContent = err.message; }
    finally { button.disabled = false; }
  });
  on('#clear-key','click',async () => { state.settings = await api('/settings',{ method:'DELETE' }); $('#app-key').value = ''; $('#app-id').value = ''; $('#remember').checked = false; updateSettings(); updateNotice(); toast('已清除本机密钥'); $('#settings-dialog').close(); });
  on('#delete','click',() => { if (state.current) modal('#delete-dialog'); });
  on('#delete-confirm','click',async () => {
    const id = state.current?.id; if (!id) return;
    clearTimeout(saveTimer); clearTimeout(pollTimer); await savePromise.catch(() => {}); state.dirty = false;
    await api('/items/' + id,{ method:'DELETE' }); $('#delete-dialog').close(); state.current = null;
    await refreshHistory();
    if (state.items.length) await selectItem(state.items[0].id);
    else {
      ++renderSeq; $('#editor').value = ''; $('#editor').disabled = true; $('#title').value = '未选择记录'; $('#demo-tag').hidden = true;
      $('#original').replaceChildren(); $('#raw').textContent = ''; $('#saved').textContent = ''; $('#confidence').innerHTML = '<span class="dot"></span>就绪';
      $('#recognize').disabled = false; $('#recognize').innerHTML = icon('scan-text') + '开始识别'; $('#crop').hidden = true;
      state.formulas = []; await renderPreview(); setTab('preview'); updateNotice();
    }
    updatePdfPanel(); toast('记录已删除');
  });
  on('#crop','click',openCrop);
  on('#crop-canvas','pointerdown',e => { cropStart = cropPoint(e); e.target.setPointerCapture(e.pointerId); cropRect = null; });
  on('#crop-canvas','pointermove',e => { if (!cropStart) return; const p = cropPoint(e); cropRect = { x:Math.min(p.x,cropStart.x),y:Math.min(p.y,cropStart.y),w:Math.abs(p.x-cropStart.x),h:Math.abs(p.y-cropStart.y) }; paintCrop(); });
  on('#crop-canvas','pointerup',() => { cropStart = null; });
  on('#crop-confirm','click',async () => {
    if (!cropRect || cropRect.w < 8 || cropRect.h < 8) return toast('请先拖动选择一个区域。');
    const c = $('#crop-canvas'), r = cropRect, out = document.createElement('canvas'), sx = cropImage.width/c.width, sy = cropImage.height/c.height;
    out.width = Math.round(r.w*sx); out.height = Math.round(r.h*sy);
    out.getContext('2d').drawImage(cropImage,r.x*sx,r.y*sy,r.w*sx,r.h*sy,0,0,out.width,out.height);
    const blob = await new Promise(resolve => out.toBlob(resolve,'image/png')); if (!blob) throw new Error('裁剪失败。');
    $('#crop-dialog').close(); await importFile(new File([blob],filename('-裁剪.png'),{ type:'image/png' }));
  });
  document.addEventListener('paste',e => {
    const img = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (img && !document.querySelector('dialog[open]')) { e.preventDefault(); importFile(img.getAsFile()).catch(showError); }
  });
  let dragDepth = 0;
  document.addEventListener('dragenter',e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; } });
  document.addEventListener('dragover',e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('dragleave',() => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
  document.addEventListener('drop',e => { e.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true; if (e.dataTransfer.files.length > 1) toast('一次处理一个文件，本次导入第一个文件。'); importFile(e.dataTransfer.files[0]).catch(showError); });
  document.addEventListener('keydown',e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrent().then(() => toast('已保存')).catch(showError); } });
  window.addEventListener('beforeunload',e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  await refreshHistory();
  if (state.items.length) await selectItem(state.items[0].id); else await loadDemo();
  if (window.desktopCapture) {
    $('#capture kbd').textContent = 'Alt ⇧ Q';
    window.desktopCapture.onState(desktopChanged);
    await desktopChanged(await window.desktopCapture.getState());
  }
  if (boot.installed && !state.settings.configured && !localStorage.getItem('mathsnip-welcome-seen')) modal('#welcome-dialog');
}
init().catch(e => { notice(e.message,true); showError(e); });
