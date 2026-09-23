import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Store } from './lib/store.js';
import { Credentials } from './lib/credentials.js';
import { ApiError, MathpixClient } from './lib/mathpix.js';
import { WordExports, wordHash } from './lib/word.js';
import { defaultWordDirectory, saveAndOpenWord } from './lib/word-save.js';
import { demoMmd } from './lib/demo.js';
import { PDFDocument } from 'pdf-lib';
import { PdfJobs } from './lib/pdf-jobs.js';
import { PDF_MAX_BYTES, PDF_RATES } from './lib/pdf-options.js';
import { atomicWrite } from './lib/files.js';
import { InkRecognition } from './lib/ink.js';
import { UsageStats } from './lib/usage.js';

const require = createRequire(import.meta.url);
const { MathpixMarkdownModel: MM } = require('mathpix-markdown-it');
export const root = path.dirname(fileURLToPath(import.meta.url));

export async function createApp({ dataDir = process.env.SNIP_DATA_DIR || path.join(root, 'data'), fetchImpl, testCredentials, wordOptions, pdfOptions, wordDirectory = defaultWordDirectory, openWord, openFolder } = {}) {
  await mkdir(dataDir, { recursive: true });
  const store = new Store(dataDir); await store.init();
  const credentials = new Credentials(root, dataDir);
  if (testCredentials) credentials.value = testCredentials; else await credentials.init();
  const client = new MathpixClient({ credentials: () => credentials.value, fetchImpl });
  const ink = new InkRecognition({store,client}), usage = new UsageStats(client);
  const app = express(), token = randomBytes(32).toString('hex'), locks = new Map(), wordSaves = new Map();
  const preferencePath = path.join(dataDir,'pdf-preferences.json');
  let pdfMode = 'files';
  try { const saved = JSON.parse(await readFile(preferencePath,'utf8')); if (Object.hasOwn(PDF_RATES,saved.mode)) pdfMode = saved.mode; } catch {}
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).json({ error: '只允许本机访问。' });
    if (req.headers.origin && !['http://' + host].includes(req.headers.origin)) return res.status(403).json({ error: '不允许跨站请求。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://cdn.mathpix.com; font-src 'self' data:; connect-src 'self'; object-src 'self' blob:; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'");
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.path !== '/api/bootstrap' && req.path !== '/api/health' && req.headers['x-snip-token'] !== token)
        return res.status(403).json({ error: '会话已失效，请刷新页面。' });
    }
    next();
  });
  app.use(express.json({ limit: '40mb' }));
  app.get('/api/health', (req, res) => res.json({ app: 'mathpix-snip-local', version: '1.5.1', inkLayout: 2 }));
  app.get('/api/bootstrap', (req, res) => res.json({ token, settings: credentials.public(), nativeCapture: process.platform === 'win32', wordDirectory, pdfMode, pdfRates:PDF_RATES, pdfMaxBytes:PDF_MAX_BYTES }));
  app.get('/api/items', async (req, res) => res.json(await store.list()));
  app.post('/api/ink/recognize',async(req,res)=>res.json(await ink.recognize(req.body)));
  app.post('/api/ink/:id/save',async(req,res)=>locked('ink-'+req.params.id,async()=>res.json(await ink.save(req.params.id))));
  app.get('/api/usage',async(req,res)=>res.json(await usage.get(req.query.from,req.query.to,req.query.refresh==='1')));
  async function getItem(id) { const i = await store.get(id); if (!i) throw new ApiError('记录不存在。', 404); return i; }
  async function locked(id, fn) {
    const previous = locks.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(fn);
    locks.set(id, operation);
    try { return await operation; } finally { if (locks.get(id) === operation) locks.delete(id); }
  }
  const word = new WordExports({ store, client, ...wordOptions, update: (id, fn) => locked(id, async () => {
    const item = await getItem(id); await fn(item); await store.put(item);
  }) });
  const pdf = new PdfJobs({store,client,word,directory:wordDirectory,openWord,openFolder,...pdfOptions,update:(id,fn) => locked(id,async () => {
    const item = await getItem(id); await fn(item); await store.put(item);
  })});
  app.post('/api/pdf/import',express.raw({type:'application/pdf',limit:PDF_MAX_BYTES}),async (req,res) => {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.subarray(0,5).equals(Buffer.from('%PDF-'))) throw new ApiError('请选择有效的 PDF 文件。');
    let document;
    try { document = await PDFDocument.load(bytes,{updateMetadata:false}); }
    catch { throw new ApiError('无法读取 PDF。请检查文件是否损坏或加密；加密文件请先自行解锁。'); }
    const id = randomUUID(), numPages = document.getPageCount();
    if (!numPages) throw new ApiError('PDF 没有可识别的页面。');
    await mkdir(path.dirname(store.sourcePath(id)),{recursive:true}); await atomicWrite(store.sourcePath(id),bytes);
    res.json(await store.put({id,title:String(req.query.title || '未命名 PDF').slice(0,120),kind:'pdf',sourceFile:true,numPages,size:bytes.length,mmd:'',status:'ready',createdAt:new Date().toISOString(),demo:false}));
  });
  app.get('/api/items/:id/source',async (req,res) => {
    const item = await getItem(req.params.id);
    if (!item.sourceFile) throw new ApiError('这条记录没有独立的 PDF 文件。',404);
    res.type('application/pdf').send(await readFile(store.sourcePath(item.id)));
  });
  app.post('/api/pdf/:id/start',async (req,res) => locked(req.params.id,async () => {
    const item = await getItem(req.params.id);
    if (!credentials.public().configured) throw new ApiError('请先填写 API 凭据。',428);
    const mode = req.body.mode || pdfMode;
    if (!Object.hasOwn(PDF_RATES,mode)) throw new ApiError('请选择经济模式或快速模式。');
    pdfMode = mode; await atomicWrite(preferencePath,JSON.stringify({mode}));
    res.json(await pdf.submit(item,{mode,pages:req.body.pages}));
  }));
  app.post('/api/pdf/:id/resume',async (req,res) => { await pdf.retry(req.params.id); res.json(await getItem(req.params.id)); });
  app.post('/api/pdf/:id/open',async (req,res) => res.json(await pdf.open(req.params.id,req.body.kind === 'folder' ? 'folder' : 'word')));
  app.get('/api/items/:id', async (req, res) => res.json(await getItem(req.params.id)));
  app.patch('/api/items/:id', async (req, res) => locked(req.params.id, async () => {
    const i = await getItem(req.params.id);
    if (i.pdfTask && ['submitting','processing','saving'].includes(i.pdfTask.status)) throw new ApiError('PDF 正在处理，完成后再编辑或重命名。',409);
    if (typeof req.body.mmd === 'string' && req.body.mmd !== i.mmd) {
      if (req.body.mmd.length > 1_000_000) throw new ApiError('内容超过 100 万字符。');
      i.mmd = req.body.mmd; i.editedAt = new Date().toISOString(); delete i.conversionId; delete i.word; i.wordRequested = false;
    }
    if (typeof req.body.title === 'string') i.title = req.body.title.slice(0, 120).trim() || '未命名记录';
    res.json(await store.put(i));
  }));
  app.delete('/api/items/:id', async (req, res) => locked(req.params.id, async () => {
    const item = await getItem(req.params.id);
    if (item.pdfTask && ['submitting','processing','saving'].includes(item.pdfTask.status)) throw new ApiError('PDF 正在处理，请完成后再删除记录。已导出的文件夹会保留。',409);
    await store.remove(req.params.id); await word.remove(req.params.id); res.json({ ok: true });
  }));
  app.post('/api/items', async (req, res) => {
    const { source, title, kind } = req.body;
    if (!['image', 'pdf', 'text'].includes(kind)) throw new ApiError('不支持的文件类型。');
    if (kind !== 'text') {
      if (typeof source !== 'string' || !(kind === 'image' ? /^data:image\/(png|jpeg|webp|bmp);base64,[A-Za-z0-9+/=\r\n]+$/ : /^data:application\/pdf;base64,[A-Za-z0-9+/=\r\n]+$/).test(source))
        throw new ApiError('请选择 PNG、JPG、WEBP、BMP 图片或 PDF 文件。');
      const size = Buffer.byteLength(source.split(',')[1], 'base64');
      if (size > (kind === 'pdf' ? 25 : 15) * 1024 * 1024) throw new ApiError(kind === 'pdf' ? 'PDF 上限为 25 MB。' : '图片上限为 15 MB。');
      if (kind === 'pdf' && !Buffer.from(source.split(',')[1], 'base64').subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new ApiError('这不是有效的 PDF 文件。');
    }
    res.json(await store.put({ id: randomUUID(), title: String(title || '未命名记录').slice(0, 120), kind, source: source || '', mmd: '', status: kind === 'text' ? 'completed' : 'ready', createdAt: new Date().toISOString(), demo: false }));
  });
  app.post('/api/demo', async (req, res) => {
    let i = await store.get('demo-circles');
    if (!i) i = await store.put({ id: 'demo-circles', title: '两圆的公共弦问题', kind: 'image', source: '/sample.svg', mmd: demoMmd, status: 'completed', createdAt: new Date().toISOString(), demo: true });
    res.json(i);
  });
  app.post('/api/settings', async (req, res) => res.json(await credentials.set(req.body)));
  app.delete('/api/settings', async (req, res) => { await credentials.clear(); res.json(credentials.public()); });
  app.post('/api/capture', (req, res) => {
    if (process.platform !== 'win32') throw new ApiError('请使用系统截图快捷键，然后回到这里粘贴。');
    const p = spawn('explorer.exe', ['ms-screenclip:'], { windowsHide: true, detached: true, stdio: 'ignore' });
    p.on('error', () => {}); p.unref(); res.json({ ok: true });
  });
  app.post('/api/recognize/:id', async (req, res) => locked(req.params.id, async () => {
    const i = await getItem(req.params.id);
    if (i.demo || i.kind === 'text') throw new ApiError('请导入图片或 PDF 后进行识别。');
    if (i.pdfTask) return res.json(i);
    if (i.pdfId) return res.json(i); // Resume without submitting the same PDF twice.
    if (i.status === 'completed') throw new ApiError('该记录已识别完成。需要重新识别时请重新导入原图。');
    if (!credentials.public().configured) throw new ApiError('请先填写 App ID 和 App Key。', 428);
    const pages = String(req.body.pages || '').trim();
    if (pages && !/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(pages)) throw new ApiError('页码请使用 1-3,5 这样的格式。');
    i.status = 'processing'; delete i.error; await store.put(i);
    try {
      if (i.kind === 'image') {
        const result = await client.image(i.source);
        i.raw = result; i.mmd = result.text || (result.latex_styled ? '$$' + result.latex_styled + '$$' : '');
        i.confidence = result.confidence_rate ?? result.confidence;
        i.status = 'completed';
        if (!i.mmd) throw new ApiError('未识别到文字或公式，请检查原图。', 422);
      } else {
        const result = await client.pdf(Buffer.from(i.source.split(',')[1], 'base64'), i.title, pages);
        if (!result.pdf_id) throw new ApiError('Mathpix 未返回 PDF 任务编号。', 502);
        i.pdfId = result.pdf_id; i.pages = pages; i.raw = result; i.wordFromPdf = true;
      }
      i.wordRequested = true;
      await store.put(i);
      if (i.status === 'completed') word.start(i.id);
      res.json(i);
    } catch (e) { i.status = 'error'; i.error = e.message; await store.put(i); throw e; }
  }));
  app.get('/api/poll/:id', async (req, res) => locked(req.params.id, async () => {
    const i = await getItem(req.params.id);
    if (!i.pdfId || i.status === 'completed') return res.json(i);
    const result = await client.pdfStatus(i.pdfId);
    i.raw = result; i.progress = result.percent_done ?? 0;
    if (result.status === 'error') { i.status = 'error'; i.error = result.error || 'PDF 识别失败。'; }
    else if (result.status === 'completed') {
      i.mmd = await client.pdfText(i.pdfId); i.status = 'completed'; delete i.error;
    } else { i.status = 'processing'; delete i.error; }
    await store.put(i);
    if (i.status === 'completed') word.start(i.id);
    res.json(i);
  }));
  app.post('/api/render', (req, res) => {
    const mmd = req.body.mmd;
    if (typeof mmd !== 'string' || mmd.length > 150_000) throw new ApiError('预览最多支持 15 万字符；可以导出全文查看。');
    const html = MM.markdownToHTML(mmd.replace(/\\pagebreak\b/g, '\n\n---\n\n'), {
      htmlTags: false, breaks: true, width: 840,
      outMath: { include_latex: true, include_mathml: true, include_svg: true },
      mathJax: { mtextInheritFont: true }, accessibility: { assistiveMml: false },
    });
    res.json({ html });
  });
  app.get('/math-style.css', (req, res) => res.type('css').send(MM.getMathpixStyle(true)));
  app.post('/api/export/cloud/:id', async (req, res) => locked(req.params.id, async () => {
    const i = await getItem(req.params.id);
    if (!i.mmd?.trim()) throw new ApiError('没有可导出的内容。');
    if (await word.cached(i)) return res.json({ status: 'completed' });
    if (!credentials.public().configured) throw new ApiError('请先填写 App ID 和 App Key。', 428);
    i.wordRequested = true;
    i.word = { ...i.word, hash: wordHash(i.mmd), status: 'processing', error: undefined };
    await store.put(i);
    word.start(i.id);
    res.json({ status: 'processing' });
  }));
  app.get('/api/export/cloud/:id/status', async (req, res) => {
    res.json(word.status(await getItem(req.params.id)));
  });
  app.get('/api/export/cloud/:id/download', async (req, res) => {
    const buffer = await word.cached(await getItem(req.params.id));
    if (!buffer) throw new ApiError('DOCX 尚未完成转换。请点击“导出 Word”准备文档。', 409);
    res.setHeader('Content-Disposition', 'attachment; filename="math-notes.docx"');
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buffer);
  });
  app.post('/api/export/cloud/:id/save', async (req, res) => {
    const id = req.params.id;
    let task = wordSaves.get(id);
    if (!task) {
      task = (async () => {
        const item = await getItem(id), buffer = await word.cached(item);
        if (!buffer) throw new ApiError('DOCX 尚未完成转换，请稍后重试。', 409);
        try { return await saveAndOpenWord({ buffer, title:item.title, directory:wordDirectory, openFile:openWord }); }
        catch (error) { throw new ApiError(error.message, 500); }
      })();
      wordSaves.set(id, task);
    }
    try { res.json(await task); }
    finally { if (wordSaves.get(id) === task) wordSaves.delete(id); }
  });
  app.use(express.static(path.join(root, 'public')));
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: err.type === 'entity.too.large' ? '文件太大，请减小文件后重试。' : status < 500 || err instanceof ApiError ? err.message : '本地服务出错，请重试或查看启动日志。' });
  });
  if (credentials.public().configured) {
    await pdf.resume();
    for (const entry of await store.list()) {
      const item = await store.get(entry.id);
      // Only resume known submissions. An interrupted submission with no ID is ambiguous.
      if (item?.status === 'completed' && item.word?.status === 'processing' &&
          item.word.hash === wordHash(item.mmd) && (item.conversionId || (item.pdfId && item.wordFromPdf))) word.start(item.id);
    }
  }
  return { app, store, credentials, word, pdf };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 47831);
  const { app } = await createApp();
  const server = app.listen(port, '127.0.0.1', () => console.log('Math Snip ready: http://127.0.0.1:' + port));
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '端口已被占用，请打开已有窗口或设置 PORT。' : '启动失败：' + e.message); process.exit(1); });
}
