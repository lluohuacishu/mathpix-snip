import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createApp, root } from '../server.js';
import { validateStrokes } from '../lib/ink.js';
import { usageRange, summarizeUsage } from '../lib/usage.js';
import { planInk } from '../lib/ink-layout.js';

await mkdir(path.join(root,'work'),{recursive:true});
const creds={appId:'ink-test',appKey:'fake-not-a-real-key'};
const json=data=>new Response(JSON.stringify(data));
const input=()=>({id:randomUUID(),x:[[20,30,40],[30,30]],y:[[30,30,30],[20,40]]});
async function fixture(t,options={}) {
  const dataDir=options.dataDir||await mkdtemp(path.join(root,'work','ink-test-'));
  const calls=[];
  const service=await createApp({dataDir,testCredentials:creds,fetchImpl:async(url,req)=>{calls.push({url,req});return json(url.includes('ocr-usage')?{ocr_usage:[]}:{text:'$x^2$',latex_styled:'x^2',request_id:'mock',confidence_rate:.99});},...options});
  const server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await service.pdf.close();await service.word.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const base='http://127.0.0.1:'+server.address().port,boot=await(await fetch(base+'/api/bootstrap')).json();
  const request=(route,body,token=boot.token)=>fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{'x-snip-token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {...service,dataDir,calls,request};
}
test('ink rejects empty, mismatched, excessive and invalid points before remote submission',async t=>{
  const f=await fixture(t);
  for(const body of [{id:randomUUID(),x:[],y:[]},{...input(),x:[[NaN]]},{...input(),y:[[1]]},{...input(),x:[[-1,5]],y:[[1,5]]}]) assert.equal((await f.request('/ink/recognize',body)).status,400);
  assert.throws(()=>validateStrokes({x:[Array(20001).fill(1)],y:[Array(20001).fill(1)]}));
  assert.equal((await f.request('/ink/recognize',input(),'wrong')).status,403);
  assert.equal(f.calls.length,0);
});
test('ink sends raw stroke coordinates once; repeat requests and restarts reuse completed results; save is local',async t=>{
  const f=await fixture(t),body=input();
  const responses=await Promise.all([f.request('/ink/recognize',body),f.request('/ink/recognize',body)]);
  assert.equal(responses.every(r=>r.status===200),true);const result=await responses[0].json();assert.equal(result.latex,'x^2');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://api.mathpix.com/v3/strokes');
  const payload=JSON.parse(f.calls[0].req.body);assert.deepEqual(payload.strokes,{strokes:{x:body.x,y:body.y}});assert.equal(payload.metadata.improve_mathpix,false);
  assert.equal(payload.strokes_session_id,undefined);assert.equal(f.calls[0].req.headers.app_key,creds.appKey);
  const saved=await(await f.request('/ink/'+body.id+'/save',{})).json();assert.equal(saved.mmd,'$x^2$');assert.deepEqual(saved.strokes,{x:body.x,y:body.y});assert.equal(saved.wordRequested,false);
  saved.mmd='user edit';await f.store.put(saved);assert.equal((await(await f.request('/ink/'+body.id+'/save',{})).json()).mmd,'user edit');
  const again=await fixture(t,{dataDir:f.dataDir});assert.equal((await again.request('/ink/recognize',body)).status,200);assert.equal(again.calls.length,0);
  assert.equal((await f.request('/ink/recognize',{...body,x:[[1]],y:[[2]]})).status,409);
});
test('ink accepts text-only response and never resubmits failed or interrupted requests automatically',async t=>{
  let calls=0;
  const f=await fixture(t,{fetchImpl:async()=>{calls++;return json({text:'文字与 $x$'});}}),body=input();
  const value=await(await f.request('/ink/recognize',body)).json();assert.equal(value.latex,'');assert.equal(value.mmd,'文字与 $x$');
  const failed=await fixture(t,{fetchImpl:async()=>{calls++;throw new Error('offline');}}),bad=input();
  assert.equal((await failed.request('/ink/recognize',bad)).status,502);assert.equal((await failed.request('/ink/recognize',bad)).status,409);assert.equal(calls,2);
  const file=path.join(f.dataDir,'ink-requests',body.id+'.json');const entry=JSON.parse(await readFile(file));entry.status='submitting';delete entry.result;await writeFile(file,JSON.stringify(entry));
  assert.equal((await f.request('/ink/recognize',body)).status,409);assert.equal(calls,2);
});
test('ink uses overall confidence and corrects legacy cached result scores without another OCR call',async t=>{
  let calls=0;
  const f=await fixture(t,{fetchImpl:async()=>{calls++;return json({text:'$x$',confidence:0.42,confidence_rate:0.999});}}),body=input();
  const result=await(await f.request('/ink/recognize',body)).json();assert.equal(result.confidence,0.42);
  const file=path.join(f.dataDir,'ink-requests',body.id+'.json'),entry=JSON.parse(await readFile(file));entry.result.confidence=0.999;await writeFile(file,JSON.stringify(entry));
  const cached=await(await f.request('/ink/recognize',body)).json();assert.equal(cached.confidence,0.42);assert.equal(calls,1);
  const saved=await(await f.request('/ink/'+body.id+'/save',{})).json();assert.equal(saved.confidence,0.42);assert.equal(saved.raw.confidence,0.42);
});
test('usage date range is inclusive UTC and rejects invalid/reversed/oversized ranges',()=>{
  assert.deepEqual(usageRange('2026-09-01','2026-09-23'),{from_date:'2026-09-01T00:00:00.000Z',to_date:'2026-09-24T00:00:00.000Z'});
  for(const [from,to] of [['2026-02-30','2026-03-01'],['2026-10-01','2026-09-01'],['2020-01-01','2026-01-01'],['bad','2026-01-01']]) assert.throws(()=>usageRange(from,to));
});
const layoutImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=';
test('mixed ink submits one complete layout image, preserves returned subscripts and caches without stroke splicing',async t=>{
  const calls=[],latex=String.raw`U_{\text{真实}}`;
  const f=await fixture(t,{fetchImpl:async(url,req)=>{calls.push({url,req});return json({text:'$$\n'+latex+'\n$$',latex_styled:latex});}});
  const body={id:randomUUID(),x:[[150,190]],y:[[100,140]],texts:[{text:'真实',x:195,y:135,width:60,fontSize:18}],layoutImage};
  const first=await(await f.request('/ink/recognize',body)).json();assert.equal(first.latex,latex);assert.equal(first.mmd,'$$\n'+latex+'\n$$');assert.equal(first.mode,'layout-image');assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.mathpix.com/v3/text');assert.equal(calls[0].req.body.get('file').type,'image/png');assert.equal(JSON.parse(calls[0].req.body.get('options_json')).metadata.improve_mathpix,false);assert.equal(JSON.parse(calls[0].req.body.get('options_json')).enable_document_layout,false);assert.equal(JSON.parse(calls[0].req.body.get('options_json')).auto_rotate_confidence_threshold,1);
  assert.deepEqual(Buffer.from(await calls[0].req.body.get('file').arrayBuffer()),Buffer.from(layoutImage.split(',')[1],'base64'));
  assert.equal((await f.request('/ink/recognize',body)).status,200);assert.equal(calls.length,1);
  const saved=await(await f.request('/ink/'+body.id+'/save',{})).json();assert.deepEqual(saved.inkTexts,body.texts);assert.equal(saved.inkMode,'layout-image');assert.equal(saved.wordRequested,false);
  const restarted=await fixture(t,{dataDir:f.dataDir});assert.equal((await restarted.request('/ink/recognize',{...body,id:randomUUID()})).status,200);assert.equal(restarted.calls.length,0);
  assert.equal((await f.request('/ink/recognize',{...body,texts:[{...body.texts[0],fontSize:36}]})).status,409);
});
test('mixed layout rejects old clients, invalid images and font sizes before any remote call',async t=>{
  const f=await fixture(t),body={...input(),texts:[{text:'中文',x:100,y:40,width:90,fontSize:28}]};
  assert.equal((await f.request('/ink/recognize',body)).status,409);
  assert.equal((await f.request('/ink/recognize',{...body,layoutImage:'data:image/png;base64,abcd'})).status,400);
  for(const fontSize of [0,11,97,1.5,'18'])assert.equal((await f.request('/ink/recognize',{...body,layoutImage,texts:[{...body.texts[0],fontSize}]})).status,400);
  assert.equal(f.calls.length,0);
});
test('mixed layout failure does not fall back to separate recognition or repeat automatically',async t=>{
  let calls=0;const f=await fixture(t,{fetchImpl:async()=>{calls++;throw new Error('offline');}});
  const body={...input(),texts:[{text:'真实',x:50,y:45,width:60,fontSize:18}],layoutImage};
  assert.equal((await f.request('/ink/recognize',body)).status,502);
  assert.equal((await f.request('/ink/recognize',body)).status,409);assert.equal(calls,1);
});

test('typed-only board works without a key or OCR, preserves literal punctuation and is stored with positions',async t=>{
  const f=await fixture(t,{testCredentials:{appId:'',appKey:''}}),body={id:randomUUID(),x:[],y:[],texts:[{text:'中文 $5 <标记>',x:10,y:20,width:300}]};
  const response=await f.request('/ink/recognize',body);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.mmd,'中文 \\$5 \\<标记\\>');assert.equal(result.mathGroups,0);assert.equal(f.calls.length,0);
  const saved=await(await f.request('/ink/'+body.id+'/save',{})).json();assert.equal(saved.inkTexts[0].text,body.texts[0].text);
  for(const invalid of [{...body.texts[0],text:''},{...body.texts[0],y:500},{...body.texts[0],width:-1}])assert.equal((await f.request('/ink/recognize',{...body,id:randomUUID(),texts:[invalid]})).status,400);
});
test('mixed layout keeps superscripts with their row and reads separate rows from top to bottom',()=>{
  const strokes={x:[[180,195],[150,160],[140,170]],y:[[80,100],[105,145],[300,350]]};
  const rows=planInk(strokes,[{text:'第一行',x:10,y:105,width:100},{text:'第二行',x:10,y:310,width:100}]);
  assert.equal(rows.length,2);assert.equal(rows[0][0].text,'第一行');assert.equal(rows[0][1].strokes.x.length,2);assert.equal(rows[1][0].text,'第二行');
});
test('usage separates units, aggregates duplicate rows, preserves unknown types without inventing prices',()=>{
  const ocr_usage=[['image',2],['image',3],['scs-page',36],['pdf-page',1],['c-docx',5],['unknown',9]].map(([usage_type,count])=>({usage_type,count,from_date:'2026-09-22T00:00:00Z'}));
  const summary=summarizeUsage({ocr_usage});assert.equal(summary.breakdown.find(r=>r.type==='image').count,5);assert.equal(summary.daily.length,5);
  assert.equal(summary.breakdown.find(r=>r.type==='scs-page').unit,'页');assert.equal(summary.breakdown.find(r=>r.type==='c-docx').estimate,null);
  assert.ok(Math.abs(summary.estimatedKnownCost-.069)<1e-10);assert.deepEqual(summary.unpricedTypes,['c-docx','unknown']);
  assert.throws(()=>summarizeUsage({}));assert.throws(()=>summarizeUsage({ocr_usage:[{usage_type:'image',count:-1,from_date:'bad'}]}));
});
test('usage uses read-only official API with cache; explicit refresh, key changes, auth and invalid dates are handled',async t=>{
  const f=await fixture(t),url='/usage?from=2026-09-01&to=2026-09-23';
  const response=await f.request(url);assert.equal(response.status,200);assert.deepEqual((await response.json()).breakdown,[]);
  const call=f.calls[0],query=new URL(call.url).searchParams;assert.equal(call.req.method,'GET');assert.equal(query.get('group_by'),'usage_type');assert.equal(query.get('timespan'),'day');assert.equal(query.get('to_date'),'2026-09-24T00:00:00.000Z');
  await f.request(url);assert.equal(f.calls.length,1);await f.request(url+'&refresh=1');assert.equal(f.calls.length,2);
  f.credentials.value={...creds,appKey:'other-key'};await f.request(url);assert.equal(f.calls.length,3);
  assert.equal((await f.request('/usage?from=bad&to=bad')).status,400);assert.equal((await f.request(url,undefined,'wrong')).status,403);assert.equal(f.calls.length,3);
  f.credentials.value={appId:'',appKey:''};assert.equal((await f.request(url)).status,428);
});
