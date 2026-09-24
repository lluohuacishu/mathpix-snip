import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createApp, root } from '../server.js';
import { Preferences } from '../lib/preferences.js';
import { wordHash } from '../lib/word.js';
import { checkCredentials } from '../lib/credential-check.js';
import { HotkeyController, normalizeHotkey } from '../desktop/hotkey.cjs';

await mkdir(path.join(root,'work'),{recursive:true});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
test('hotkey switch registers before releasing old key and rolls back on conflicts or write failures',async()=>{
  const active=new Map(), events=[];let failSave=false;
  const shortcuts={isRegistered:key=>active.has(key),register:(key,fn)=>{events.push('register:'+key);if(key==='Ctrl+Q')return false;active.set(key,fn);return true;},unregister:key=>{events.push('unregister:'+key);active.delete(key);}};
  const controller=new HotkeyController({shortcuts,capture:()=>{},persist:async key=>{events.push('save:'+key);if(failSave)throw Error();}});
  assert.equal(controller.register(),true);
  await assert.rejects(controller.set('Ctrl+Q'),/占用/);assert.equal(active.has('Alt+Shift+Q'),true);
  failSave=true;await assert.rejects(controller.set('Ctrl+Alt+J'),/保存失败/);assert.equal(active.has('Alt+Shift+Q'),true);assert.equal(active.has('Ctrl+Alt+J'),false);
  failSave=false;events.length=0;await controller.set('ctrl + alt + j');
  assert.deepEqual(events,['register:Ctrl+Alt+J','save:Ctrl+Alt+J','unregister:Alt+Shift+Q']);assert.equal(controller.hotkey,'Ctrl+Alt+J');
  assert.equal(normalizeHotkey('Win+shift+f12'),'Shift+Super+F12');
  for(const value of ['Q','Shift+Q','Ctrl++Q','Ctrl+Ctrl+Q','Ctrl+F25','Ctrl+Escape'])assert.throws(()=>normalizeHotkey(value));
});

test('export preferences validate writable absolute paths, persist, and leave original settings on failure',async()=>{
  const data=await mkdtemp(path.join(root,'work','preferences-')), original=path.join(data,'original');
  const prefs=new Preferences(data,original);await prefs.init();
  const next=path.join(data,'中文 文件夹');await prefs.set({outputDirectory:next,autoOpenWord:false});
  const restored=new Preferences(data,original);await restored.init();assert.deepEqual(restored.public(),prefs.public());
  const file=path.join(data,'existing-file');await writeFile(file,'keep');
  for(const input of [{outputDirectory:'relative',autoOpenWord:true},{outputDirectory:file,autoOpenWord:true},{outputDirectory:next,autoOpenWord:'false'}])await assert.rejects(prefs.set(input));
  assert.equal(prefs.value.outputDirectory,next);assert.equal(await readFile(file,'utf8'),'keep');
});

test('credential probe only queries usage and distinguishes invalid, restricted and unavailable credentials without echoing secrets',async()=>{
  const credentials={appId:'test-app',appKey:'fake-key'};
  for(const [status,data,expected] of [[200,{ocr_usage:[]},'valid'],[401,{error:'fake-key'},'invalid'],[403,{},'forbidden'],[429,{},'limited'],[500,{error:'fake-key'},'unavailable'],[200,{error:'fake-key'},'unavailable'],[200,{},'unavailable']]){
    const result=await checkCredentials(credentials,async(url,req)=>{assert.equal(new URL(url).pathname,'/v3/ocr-usage');assert.equal(req.method,'GET');assert.equal(req.body,undefined);assert.equal(req.headers.app_key,'fake-key');return json(data,status);});
    assert.equal(result.status,expected);assert.ok(!JSON.stringify(result).includes('fake-key'));
  }
  assert.equal((await checkCredentials(credentials,async()=>{throw Error('fake-key');})).status,'unavailable');
});

test('settings API verifies unsaved credentials without changing saved credentials; exports honor updated directory and auto-open preference',async t=>{
  const dataDir=await mkdtemp(path.join(root,'work','settings-api-')), opened=[], calls=[];
  const service=await createApp({dataDir,wordDirectory:path.join(dataDir,'original'),testCredentials:{appId:'test-existing',appKey:'fake-existing'},openWord:async file=>opened.push(file),fetchImpl:async(url,req)=>{calls.push(req.headers);return json({ocr_usage:[]});}});
  const server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await service.pdf.close();await service.word.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port, boot=await fetch(base+'/api/bootstrap').then(r=>r.json());
  const request=(route,body)=>fetch(base+'/api'+route,{method:'POST',headers:{'x-snip-token':boot.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/settings/check',{method:'POST'})).status,403);
  const checked=await request('/settings/check',{appId:'test-new',appKey:'fake-new'});assert.equal((await checked.json()).status,'valid');assert.equal(service.credentials.value.appKey,'fake-existing');assert.equal(calls[0].app_key,'fake-new');
  assert.equal((await request('/settings/check',{appId:'test-new',appKey:''})).status,400);assert.equal(calls.length,1);
  assert.equal((await request('/settings/check',{appId:'test-existing',appKey:''})).status,200);assert.equal(calls[1].app_key,'fake-existing');
  const directory=path.join(dataDir,'new exports');assert.equal((await request('/preferences',{outputDirectory:directory,autoOpenWord:false})).status,200);
  const mmd='$x$',hash=wordHash(mmd),docx=Buffer.from('PK\x03\x04fake-docx');
  await service.store.put({id:'test-export',title:'公式',kind:'text',mmd,status:'completed',word:{status:'completed',hash}});
  const cache=service.word.cachePath('test-export',hash);await mkdir(path.dirname(cache),{recursive:true});await writeFile(cache,docx);
  const saved=await request('/export/cloud/test-export/save',{}).then(r=>r.json());assert.equal(saved.path,path.join(directory,'公式.docx'));assert.equal(saved.opened,false);assert.equal(saved.autoOpen,false);assert.equal(saved.error,undefined);assert.equal(opened.length,0);assert.deepEqual(await readFile(saved.path),docx);
  const current=await fetch(base+'/api/bootstrap').then(r=>r.json());assert.equal(current.wordDirectory,directory);assert.equal(current.preferences.autoOpenWord,false);
});
