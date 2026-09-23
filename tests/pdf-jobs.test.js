import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument } from 'pdf-lib';
import yazl from 'yazl';
import { createApp, root } from '../server.js';
import { selectedPages } from '../lib/pdf-options.js';
import { unpackMarkdown } from '../lib/pdf-bundle.js';
import { MathpixClient } from '../lib/mathpix.js';

await mkdir(path.join(root,'work'),{recursive:true});

const credentials = {appId:'test-pdf',appKey:'fake-key'};
const rawMmd = '原始 Mathpix MMD\n\\begin{tabular}{cc}a&b\\end{tabular}\n$\\frac{1}{2}$';
const docx = Buffer.from('PK\x03\x04official-docx-test');
const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function zip(entries = {'document.md':'# 普通 Markdown\n\n![图](./images/figure.png)\n\n$x^2$', 'images/figure.png':Buffer.from('image')}) {
  const archive = new yazl.ZipFile();
  for (const [name,data] of Object.entries(entries)) archive.addBuffer(Buffer.from(data),name);
  const chunks = []; const completed = new Promise((resolve,reject) => archive.outputStream.on('data',c => chunks.push(c)).on('end',() => resolve(Buffer.concat(chunks))).on('error',reject));
  archive.end(); return completed;
}
async function until(fn) { for (let n=0;n<500;n++) { const result = await fn(); if (result) return result; await delay(10); } throw new Error('PDF test timed out'); }
async function fixture(t,options = {}) {
  const dataDir = options.dataDir || await mkdtemp(path.join(root,'work','pdf-test-'));
  const archive = await zip(), opened = [], calls = []; let ready = options.ready !== false, failMd = !!options.failMd, pendingDownload = !!options.pendingDownload;
  const fetchImpl = options.fetchImpl || (async (url,req) => {
    calls.push({url,req});
    if (req.method === 'POST') return json(url.endsWith('/files/v1') ? {file_id:'files-job'} : {pdf_id:'fast-job'});
    if (url.endsWith('.docx')) return new Response(docx);
    if (url.endsWith('.mmd')) return new Response(rawMmd);
    if (url.endsWith('.md.zip')) {
      if (pendingDownload) { pendingDownload = false; return new Response(JSON.stringify({error:'format_not_ready'}),{status:404}); }
      return new Response(archive);
    }
    const status = ready ? 'completed' : 'processing';
    const formats = {docx:status,'md.zip':failMd ? 'error' : status,md:status};
    return json({status:'completed',percent_done:100,num_pages:2,formats,conversion_status:Object.fromEntries(Object.entries(formats).map(([k,v]) => [k,{status:v}]))});
  });
  const openedFolders = [];
  const service = await createApp({dataDir,testCredentials:credentials,wordDirectory:path.join(dataDir,'output'),openWord:async file => { opened.push(file); assert.deepEqual(await readFile(file),docx); },openFolder:async folder => { openedFolders.push(folder); },fetchImpl,pdfOptions:{pollMs:10,maxPolls:500},...options});
  const server = service.app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => { await service.pdf.close(); await service.word.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:'+server.address().port;
  const boot = await (await fetch(base+'/api/bootstrap')).json();
  const req = (route,method='GET',body) => fetch(base+'/api'+route,{method,headers:{'x-snip-token':boot.token,'Content-Type':'application/json'},body:body===undefined ? undefined : JSON.stringify(body)});
  const pdfDoc = await PDFDocument.create(); pdfDoc.addPage(); pdfDoc.addPage(); const pdfBytes = await pdfDoc.save();
  const importPdf = async (title='PDF 样例.pdf') => {
    const res = await fetch(base+'/api/pdf/import?title='+encodeURIComponent(title),{method:'POST',headers:{'x-snip-token':boot.token,'Content-Type':'application/pdf'},body:pdfBytes});
    assert.equal(res.status,200); return res.json();
  };
  const done = id => until(async () => { const item = await service.store.get(id); return ['completed','partial','error'].includes(item?.pdfTask?.status) && item; });
  return {...service,dataDir,calls,opened,openedFolders,base,req,importPdf,pdfBytes,done,ready:() => { ready = true; },fixMd:() => {failMd=false;}};
}

test('page ranges reject invalid bounds and count overlap once', () => {
  assert.deepEqual(selectedPages('5,1-3,2-4,7',8),{ranges:'1-5,7',count:6});
  assert.deepEqual(selectedPages('',8),{ranges:'',count:8});
  for (const pages of ['0','3-1','9','-1','1,,2','9999999999999999999']) assert.throws(() => selectedPages(pages,8));
});
for (const mode of ['files','fast']) test(mode+' PDF creates official DOCX, plain MD, exact raw MMD and offline assets from one submission',async t => {
  const f = await fixture(t,{pendingDownload:true}), item = await f.importPdf();
  assert.equal(item.numPages,2); assert.equal(item.source,undefined); assert.deepEqual(await readFile(f.store.sourcePath(item.id)),Buffer.from(f.pdfBytes));
  const started = await f.req('/pdf/'+item.id+'/start','POST',{mode,pages:'2,1-2'}); assert.equal(started.status,200);
  const complete = await f.done(item.id); assert.equal(complete.pdfTask.status,'completed');
  await until(() => f.opened.length===1);
  const posts = f.calls.filter(c => c.req.method==='POST'); assert.equal(posts.length,1);
  assert.equal(new URL(posts[0].url).pathname,mode==='files'?'/files/v1':'/v3/pdf');
  assert.equal(posts[0].req.headers.app_key,credentials.appKey);
  assert.equal(posts[0].req.headers.app_id,mode==='files'?undefined:credentials.appId);
  const opts = JSON.parse(posts[0].req.body.get('options_json')); assert.deepEqual(opts.conversion_formats,{docx:true,md:true,'md.zip':true});
  assert.equal(opts.page_ranges,'1-2'); assert.equal(opts.metadata.improve_mathpix,false);
  assert.equal(complete.pdfTask.estimatedCost,mode==='files'?0.003:0.01);
  const {folder,stem} = complete.pdfTask;
  const openedFolder = await (await f.req('/pdf/'+item.id+'/open','POST',{kind:'folder'})).json();
  assert.equal(openedFolder.path,folder); assert.deepEqual(f.openedFolders,[folder]);
  assert.deepEqual((await readdir(folder)).sort(),[stem+'.docx',stem+'.md',stem+'.mmd','images'].sort());
  assert.deepEqual(await readFile(path.join(folder,stem+'.docx')),docx);
  assert.equal(await readFile(path.join(folder,stem+'.mmd'),'utf8'),rawMmd);
  assert.match(await readFile(path.join(folder,stem+'.md'),'utf8'),/# 普通 Markdown/);
  assert.equal(await readFile(path.join(folder,'images/figure.png'),'utf8'),'image');
  assert.deepEqual(await f.word.cached(complete),docx);
  await f.req('/pdf/'+item.id+'/start','POST',{mode:mode==='files'?'fast':'files'});
  await f.req('/pdf/'+item.id+'/resume','POST',{});
  assert.equal(f.calls.filter(c=>c.req.method==='POST').length,1); assert.equal(f.opened.length,1);
  const boot = await (await fetch(f.base+'/api/bootstrap')).json();
  assert.equal(boot.pdfMode,mode==='files'?'fast':'files');
});
test('100% OCR waits for each format; partial failure preserves successful files and retry only fetches missing output',async t => {
  const f = await fixture(t,{ready:false,failMd:true}), item=await f.importPdf();
  await f.req('/pdf/'+item.id+'/start','POST',{mode:'files'});
  await until(async () => (await f.store.get(item.id)).pdfTask.artifacts.mmd?.status==='completed');
  assert.equal((await f.store.get(item.id)).pdfTask.status,'processing'); assert.equal(f.opened.length,0);
  assert.equal((await f.req('/items/'+item.id,'DELETE')).status,409);
  assert.equal((await f.req('/items/'+item.id,'PATCH',{mmd:'edit'})).status,409);
  f.ready(); const partial=await f.done(item.id); assert.equal(partial.pdfTask.status,'partial');
  const file = partial.pdfTask.artifacts.docx.path; await writeFile(file,'user-edited-docx');
  f.fixMd(); await f.req('/pdf/'+item.id+'/resume','POST',{});
  const completed=await f.done(item.id); assert.equal(completed.pdfTask.status,'completed');
  assert.equal(await readFile(file,'utf8'),'user-edited-docx');
  assert.equal(f.calls.filter(c=>c.req.method==='POST').length,1);
  assert.equal(f.calls.filter(c=>c.url.endsWith('.docx')).length,1);
});
test('saved remote task resumes after restart without re-upload; completed task does not auto-open again',async t => {
  const first=await fixture(t,{ready:false}),item=await first.importPdf();
  await first.req('/pdf/'+item.id+'/start','POST',{mode:'files'});
  await until(async ()=>(await first.store.get(item.id)).pdfTask.artifacts.mmd?.status==='completed');
  await first.pdf.close();
  const second=await fixture(t,{dataDir:first.dataDir}); const done=await second.done(item.id); assert.equal(done.pdfTask.status,'completed');
  await until(()=>second.opened.length===1); assert.equal(second.calls.filter(c=>c.req.method==='POST').length,0);
  await second.pdf.close(); const third=await fixture(t,{dataDir:first.dataDir}); await delay(50); assert.equal(third.opened.length,0); assert.equal(third.calls.length,0);
});
test('ambiguous submission is saved and cannot silently resubmit or switch modes',async t => {
  let calls=0;
  const f=await fixture(t,{fetchImpl:async()=>{calls++; throw new Error('connection lost');}}),item=await f.importPdf();
  assert.equal((await f.req('/pdf/'+item.id+'/start','POST',{mode:'files'})).status,502);
  assert.equal((await f.store.get(item.id)).pdfTask.status,'uncertain');
  assert.equal((await f.req('/pdf/'+item.id+'/start','POST',{mode:'fast'})).status,400); assert.equal(calls,1);
  assert.equal((await f.req('/pdf/'+item.id+'/resume','POST',{})).status,400);
});
test('invalid mode/pages and unauthenticated uploads never submit',async t=>{
  const f=await fixture(t),item=await f.importPdf();
  assert.equal((await fetch(f.base+'/api/pdf/import',{method:'POST',headers:{'Content-Type':'application/pdf'},body:f.pdfBytes})).status,403);
  for(const body of [{mode:'unknown'},{mode:'files',pages:'3'}]) assert.equal((await f.req('/pdf/'+item.id+'/start','POST',body)).status,400);
  assert.equal(f.calls.length,0);
});
test('nested Markdown assets remain relative and unsafe ZIP entries are rejected',async()=>{
  const bundle=await unpackMarkdown(await zip({'out/doc.md':'![图](./images/a.png)','out/images/a.png':'image'}));
  assert.equal(bundle.text,'![图](out/./images/a.png)'); assert.equal(bundle.images.has('out/images/a.png'),true);
  await assert.rejects(unpackMarkdown(await zip({'doc.md':'text','CON.png':'image'})),/无效路径/);
  await assert.rejects(unpackMarkdown(await zip({'doc.md':'text','run.exe':'bad'})),/非预期文件/);
  await assert.rejects(unpackMarkdown(await zip({'doc.md':'text','other.md':'text'})),/一份 Markdown/);
});
test('not-ready output HTTP 202 and Files format_not_ready are polling states',async()=>{
  for(const status of [202,404]) {
    const client=new MathpixClient({credentials:()=>credentials,fetchImpl:async()=>new Response(JSON.stringify({error:'format_not_ready'}),{status})});
    await assert.rejects(client.documentOutput('job','files','md.zip'),e=>e.pending===true);
  }
});
