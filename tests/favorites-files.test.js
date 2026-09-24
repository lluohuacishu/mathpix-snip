import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, link, access } from 'node:fs/promises';
import { createApp, root } from '../server.js';
import { Store } from '../lib/store.js';
import { LocalFiles } from '../lib/local-files.js';
import { wordHash } from '../lib/word.js';

await mkdir(path.join(root,'work'),{recursive:true});
async function setup(t) {
  const dataDir=await mkdtemp(path.join(root,'work','favorites-files-')), directory=path.join(dataDir,'output'), opened=[];
  const service=await createApp({dataDir,wordDirectory:directory,openFolder:async file=>opened.push(file),openWord:async file=>opened.push(file),fetchImpl:async()=>{throw new Error('Unexpected Mathpix call');}});
  const server=service.app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await service.pdf.close();await service.word.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const base='http://127.0.0.1:'+server.address().port, boot=await fetch(base+'/api/bootstrap').then(r=>r.json());
  async function req(route,method='GET',body) {
    const response=await fetch(base+'/api'+route,{method,headers:{'x-snip-token':boot.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  const item=(id,extras={})=>({id,title:'公式笔记',kind:'text',mmd:'$x+1$',status:'completed',createdAt:new Date().toISOString(),...extras});
  await mkdir(directory,{recursive:true});
  return {...service,dataDir,directory,opened,req,item};
}

test('favorites persist and remain independent of edits, conversion status and exported files',async t=>{
  const f=await setup(t); await f.store.put(f.item('favorite'));
  assert.equal((await f.req('/items')).body[0].favorite,false);
  const results=await Promise.all([f.req('/items/favorite/favorite','PATCH',{favorite:true}),f.req('/items/favorite','PATCH',{title:'收藏标题',mmd:'$y$'})]);
  assert.ok(results.every(r=>r.status===200));
  const saved=await new Store(f.dataDir).get('favorite'); assert.equal(saved.favorite,true);assert.equal(saved.mmd,'$y$');assert.equal(saved.title,'收藏标题');
  await f.store.put(f.item('processing',{kind:'pdf',pdfTask:{status:'processing',artifacts:{}}}));
  assert.equal((await f.req('/items/processing/favorite','PATCH',{favorite:true})).status,200);
  assert.equal((await f.req('/items/processing','PATCH',{title:'busy'})).status,409);
  assert.equal((await f.req('/items/favorite/favorite','PATCH',{favorite:'true'})).status,400);
  assert.equal((await f.req('/items/favorite/favorite','PATCH',{favorite:false})).body.favorite,false);
  assert.equal((await f.store.get('favorite')).mmd,'$y$');
  assert.equal((await f.req('/items/missing/favorite','PATCH',{favorite:true})).status,404);
});

test('Word exports are linked to records; legacy files can be renamed without modifying bytes or calling OCR',async t=>{
  const f=await setup(t), content=Buffer.from('PK\x03\x04word'), mmd='$x$',hash=wordHash(mmd);
  await f.store.put(f.item('word',{mmd,word:{status:'completed',hash},favorite:true}));
  const cache=f.word.cachePath('word',hash);await mkdir(path.dirname(cache),{recursive:true});await writeFile(cache,content);
  const saved=await f.req('/export/cloud/word/save','POST',{});assert.equal(saved.status,200);
  assert.equal((await f.store.get('word')).localExports[0].path,saved.body.path);
  const edited=Buffer.from('PK\x03\x04user-edited-word');await writeFile(saved.body.path,edited);
  let files=(await f.req('/local-files')).body.files; const row=files.find(file=>file.path===saved.body.path);assert.deepEqual(row.recordIds,['word']);
  const result=await f.req('/local-files/'+row.id+'/rename','POST',{name:'我的公式.docx'}); assert.equal(result.status,200);
  assert.equal(path.basename(result.body.path),'我的公式.docx');assert.deepEqual(await readFile(result.body.path),edited);
  await assert.rejects(access(saved.body.path),{code:'ENOENT'});
  const item=await f.store.get('word');assert.equal(item.localExports[0].path,result.body.path);assert.equal(item.favorite,true);assert.equal(item.title,'公式笔记');
  assert.equal((await f.req('/local-files/'+row.id+'/rename','POST',{name:'过期路径'})).status,404);
  const legacy=path.join(f.directory,'旧版导出.docx');await writeFile(legacy,content);
  files=(await f.req('/local-files')).body.files;const old=files.find(file=>file.path===legacy);assert.deepEqual(old.recordIds,[]);
  const renamed=await f.req('/local-files/'+old.id+'/rename','POST',{name:'旧文件新名称'});assert.equal(renamed.status,200);
  assert.equal((await f.req('/local-files/'+renamed.body.id+'/open','POST',{})).status,200);assert.equal(f.opened.at(-1),f.directory);
});

async function bundle(f,id='pdf',status='completed') {
  const folder=path.join(f.directory,'原文档'), stem='原文档', artifacts={};await mkdir(path.join(folder,'images'),{recursive:true});
  await writeFile(path.join(folder,'images','diagram.png'),'image-bytes');
  for(const ext of ['docx','md','mmd']) { const file=path.join(folder,stem+'.'+ext);await writeFile(file,ext==='md'?'![配图](images/diagram.png)\n\n$x$':'original-'+ext);artifacts[ext]={status:'completed',path:file}; }
  await f.store.put(f.item(id,{title:'PDF 原始标题',kind:'pdf',favorite:true,pdfTask:{folder,stem,outputDirectory:f.directory,status,artifacts}}));
  return (await f.req('/local-files')).body.files.find(file=>file.kind==='bundle');
}

test('PDF renames the bundle and its three files, preserves images and updates all open paths',async t=>{
  const f=await setup(t), row=await bundle(f), result=await f.req('/local-files/'+row.id+'/rename','POST',{name:'高等数学 第一章'});
  assert.equal(result.status,200);const folder=result.body.path;
  assert.deepEqual((await readdir(folder)).sort(),['images','高等数学 第一章.docx','高等数学 第一章.md','高等数学 第一章.mmd'].sort());
  assert.equal(await readFile(path.join(folder,'高等数学 第一章.md'),'utf8'),'![配图](images/diagram.png)\n\n$x$');
  assert.equal(await readFile(path.join(folder,'images','diagram.png'),'utf8'),'image-bytes');
  const item=await f.store.get('pdf');assert.equal(item.pdfTask.folder,folder);assert.equal(item.pdfTask.stem,'高等数学 第一章');assert.equal(item.favorite,true);
  for(const key of ['docx','md','mmd'])assert.equal(item.pdfTask.artifacts[key].path,path.join(folder,'高等数学 第一章.'+key));
  assert.equal((await f.req('/pdf/pdf/open','POST',{kind:'word'})).status,200);assert.equal(f.opened.at(-1),path.join(folder,'高等数学 第一章.docx'));
  assert.equal((await f.req('/pdf/pdf/open','POST',{kind:'folder'})).status,200);assert.equal(f.opened.at(-1),folder);
  // Deleting history retains exported documents, which remain discoverable.
  assert.equal((await f.req('/items/pdf','DELETE')).status,200);
  assert.equal((await f.req('/local-files')).body.files[0].path,folder);
});

test('busy PDF and destination collisions do not modify any original files',async t=>{
  const f=await setup(t), row=await bundle(f,'pdf','saving');
  assert.equal(row.busy,true);assert.equal((await f.req('/local-files/'+row.id+'/rename','POST',{name:'新名称'})).status,409);
  const item=await f.store.get('pdf');item.pdfTask.status='completed';await f.store.put(item);
  await mkdir(path.join(f.directory,'目标'));await writeFile(path.join(f.directory,'目标','personal.txt'),'keep');
  assert.equal((await f.req('/local-files/'+row.id+'/rename','POST',{name:'目标'})).status,409);
  await writeFile(path.join(row.path,'新名称.docx'),'do-not-overwrite');
  assert.equal((await f.req('/local-files/'+row.id+'/rename','POST',{name:'新名称'})).status,409);
  assert.equal(await readFile(path.join(row.path,'新名称.docx'),'utf8'),'do-not-overwrite');
  assert.equal(await readFile(path.join(row.path,'原文档.docx'),'utf8'),'original-docx');
  for(const name of ['../escape','CON','A/B','bad?.docx','trailing.','.hidden'])assert.equal((await f.req('/local-files/'+row.id+'/rename','POST',{name})).status,400,name);
  assert.equal((await f.req('/local-files/unknown/rename','POST',{name:'ok'})).status,400);
});

test('metadata persistence failure rolls a bundle rename back without losing original or edited files',async t=>{
  const f=await setup(t),row=await bundle(f),put=f.store.put.bind(f.store);let fail=true;
  f.store.put=async item=>{if(fail&&item.pdfTask?.stem==='失败回滚'){fail=false;throw new Error('simulated write failure');}return put(item);};
  const result=await f.req('/local-files/'+row.id+'/rename','POST',{name:'失败回滚'});assert.equal(result.status,409);
  assert.equal(await readFile(path.join(row.path,'原文档.docx'),'utf8'),'original-docx');
  assert.equal((await f.store.get('pdf')).pdfTask.folder,row.path);assert.equal((await f.store.get('pdf')).favorite,true);
  await assert.rejects(access(path.join(f.dataDir,'file-rename.json')),{code:'ENOENT'});
  assert.equal((await f.req('/local-files/'+row.id+'/rename','POST',{name:'成功改名'})).status,200);
});

test('case-only renames and restart recovery of an interrupted exclusive file move preserve references',async t=>{
  const f=await setup(t),from=path.join(f.directory,'Test.docx');await writeFile(from,'user document');
  await f.store.put(f.item('local',{localExports:[{path:from}]}));
  const row=(await f.req('/local-files')).body.files[0];
  const renamed=await f.req('/local-files/'+row.id+'/rename','POST',{name:'test'});assert.equal(renamed.status,200);
  assert.ok((await readdir(f.directory)).includes('test.docx'));
  const source=renamed.body.path,to=path.join(f.directory,'恢复完成.docx'),s=await lstat(source,{bigint:true});await link(source,to);
  const job={from:source,to,kind:'file',recordIds:['local'],paths:[{from:source,to}],steps:[{from:source,to,identity:s.dev.toString()+':'+s.ino.toString(),started:true}]};
  await writeFile(path.join(f.dataDir,'file-rename.json'),JSON.stringify(job));
  const recovered=new LocalFiles({store:f.store,directory:f.directory,getDirectory:()=>f.directory,lock:async(id,fn)=>fn()});await recovered.init();
  assert.equal(recovered.warning,'');assert.equal(await readFile(to,'utf8'),'user document');assert.equal((await f.store.get('local')).localExports[0].path,to);
  await assert.rejects(access(source),{code:'ENOENT'});
});

test('tracked exports in an earlier custom directory remain discoverable after changing settings',async t=>{
  const f=await setup(t),older=path.join(f.dataDir,'earlier'),current=path.join(f.dataDir,'current');await mkdir(older);
  const file=path.join(older,'past.docx');await writeFile(file,'past');await f.store.put(f.item('past',{localExports:[{path:file}]}));
  assert.equal((await f.req('/preferences','POST',{outputDirectory:current,autoOpenWord:false})).status,200);
  assert.ok((await f.req('/local-files')).body.files.some(row=>row.path===file));
});

test('restart rolls back an interrupted rename when the new name was taken by another file',async t=>{
  const f=await setup(t),from=path.join(f.directory,'original.docx'),to=path.join(f.directory,'taken.docx');
  await writeFile(from,'original');await writeFile(to,'another user file');const s=await lstat(from,{bigint:true});
  const job={from,to,kind:'file',recordIds:[],paths:[{from,to}],steps:[{from,to,identity:s.dev.toString()+':'+s.ino.toString(),started:true}]};
  await writeFile(path.join(f.dataDir,'file-rename.json'),JSON.stringify(job));
  const recovered=new LocalFiles({store:f.store,directory:f.directory,getDirectory:()=>f.directory,lock:async(id,fn)=>fn()});await recovered.init();
  assert.equal(recovered.warning,'');assert.equal(await readFile(from,'utf8'),'original');assert.equal(await readFile(to,'utf8'),'another user file');
  await assert.rejects(access(path.join(f.dataDir,'file-rename.json')),{code:'ENOENT'});
});

test('a bundle selected as export directory stays grouped and moves extra recorded Word paths with it',async t=>{
  const f=await setup(t),row=await bundle(f),extra=path.join(row.path,'额外导出.docx');await writeFile(extra,'extra');
  await f.store.put(f.item('extra',{localExports:[{path:extra}]}));
  await f.req('/preferences','POST',{outputDirectory:row.path,autoOpenWord:false});
  const listed=(await f.req('/local-files')).body.files;
  assert.equal(listed.filter(f=>f.name==='原文档.docx').length,0);assert.ok(listed.some(f=>f.name==='额外导出.docx'));
  assert.equal((await f.req('/local-files/'+row.id+'/rename','POST',{name:'完整资料'})).status,409);
  await f.req('/preferences','POST',{outputDirectory:f.directory,autoOpenWord:false});
  assert.equal((await f.req('/local-files/'+row.id+'/rename','POST',{name:'完整资料'})).status,200);
  const next=path.join(f.directory,'完整资料','额外导出.docx');assert.equal((await f.store.get('extra')).localExports[0].path,next);assert.equal(await readFile(next,'utf8'),'extra');
});
