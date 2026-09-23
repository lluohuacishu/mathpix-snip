import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp, root } from '../server.js';
import { wordHash } from '../lib/word.js';

await mkdir(path.join(root,'work'),{recursive:true});

test('Word save API uses fixed directory and cached bytes without a key or network, rejects stale cache', async t => {
  const dataDir = await mkdtemp(path.join(root,'work','word-api-'));
  const wordDirectory = path.join(dataDir,'exports'), opened = [];
  const service = await createApp({dataDir, wordDirectory, openWord:async file => { opened.push(file); }, fetchImpl:async () => { throw new Error('Unexpected external request'); }});
  const server = service.app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => { await service.word.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const boot = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(boot.wordDirectory,wordDirectory); assert.equal(boot.settings.configured,false);
  const mmd = '$x^2$', hash = wordHash(mmd), docx = Buffer.from('PK\x03\x04cached-docx');
  await service.store.put({ id:'saved-word', title:'题目.png', kind:'image', mmd, status:'completed', createdAt:new Date().toISOString(), word:{status:'completed',hash} });
  const cache = service.word.cachePath('saved-word',hash); await mkdir(path.dirname(cache),{recursive:true}); await writeFile(cache,docx);
  const route = base + '/api/export/cloud/saved-word/save';
  assert.equal((await fetch(route,{method:'POST'})).status,403);
  const req = () => fetch(route,{method:'POST',headers:{'x-snip-token':boot.token,'Content-Type':'application/json'},body:JSON.stringify({directory:'C:\\ignored-user-input',title:'ignored.exe'})});
  const first = await (await req()).json();
  assert.equal(first.opened,true); assert.equal(first.path,path.join(wordDirectory,'题目.docx')); assert.deepEqual(await readFile(first.path),docx);
  const second = await (await req()).json(); assert.equal(second.path,path.join(wordDirectory,'题目 (2).docx')); assert.equal(opened.length,2);
  const item = await service.store.get('saved-word'); item.mmd = 'modified'; await service.store.put(item);
  assert.equal((await req()).status,409); assert.equal(opened.length,2);
});
