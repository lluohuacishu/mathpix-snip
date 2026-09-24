import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, root } from '../server.js';
import { MathpixClient, conversionState, MAX_IMAGE_UPLOAD_BYTES } from '../lib/mathpix.js';
import { wordHash } from '../lib/word.js';
import { Credentials } from '../lib/credentials.js';
import { demoMmd } from '../lib/demo.js';
import http from 'node:http';

await mkdir(path.join(root, 'work'), { recursive: true });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const credentials = { appId: 'test-id', appKey: 'fake-test-secret' };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ8sAAAAASUVORK5CYII=';
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\nmock').toString('base64');
const mmd = '中文 $x^2$\n\n\\begin{tabular}{cc}a&b\\\\c&d\\end{tabular}\n\n<smiles>CCO</smiles>';

async function until(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for test condition');
}
async function fixture(t, options = {}) {
  const dataDir = options.dataDir || await mkdtemp(path.join(root, 'work', 'test-'));
  const service = await createApp({ dataDir, wordDirectory:path.join(dataDir, 'exports'), openWord:async () => { throw new Error('Test must supply an opener'); }, wordOptions: { pollMs: 5, maxPolls: 500 }, ...options });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await service.word.close(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const boot = await (await fetch(url + '/api/bootstrap')).json();
  const req = (p, method = 'GET', body) => fetch(url + '/api' + p, {
    method, headers: { 'x-snip-token': boot.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const waitWord = (id, status = 'completed') => until(async () => {
    const item = await service.store.get(id); return item?.word?.status === status && item;
  });
  return { ...service, req, url, dataDir, waitWord };
}
async function importItem(f, kind = 'image') {
  return (await f.req('/items', 'POST', { kind, source: kind === 'image' ? png : kind === 'pdf' ? pdf : '', title: 'test.' + kind })).json();
}
function mockApi({ text = mmd, formatStatus = () => 'completed', failConvert = false } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/v3/text')) return json({ text, confidence:0.67, confidence_rate: 0.94, request_id: 'mock-image' });
    if (url.endsWith('/v3/pdf') && opts.method === 'POST') return json({ pdf_id: 'mock-pdf' });
    if (url.endsWith('/v3/converter') && opts.method === 'POST') {
      if (failConvert) throw new Error('offline');
      return json({ conversion_id: 'mock-conversion-' + calls.filter(c => c.url.endsWith('/v3/converter')).length });
    }
    if (url.endsWith('.mmd')) return new Response(text);
    if (url.endsWith('.docx')) return new Response(Buffer.from('PK\x03\x04fake-docx:' + url));
    if (url.endsWith('/v3/pdf/mock-pdf')) return json({ status: 'completed', percent_done: 100 });
    return json({ status: 'completed', conversion_status: { docx: { status: formatStatus() } } });
  } };
}
const count = (mock, suffix, method) => mock.calls.filter(c => c.url.endsWith(suffix) && (!method || c.opts.method === method)).length;

test('no key: preview/edit stay available; OCR and official Word need key; local routes removed', async t => {
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; throw new Error('Unexpected network'); } });
  const demo = await (await f.req('/demo', 'POST', {})).json();
  assert.equal(demo.demo, true); assert.equal(demo.confidence, undefined);
  const rendered = await (await f.req('/render', 'POST', { mmd: demoMmd })).json();
  assert.match(rendered.html, /<svg/);
  const i = await importItem(f);
  assert.equal((await f.req('/recognize/' + i.id, 'POST', {})).status, 428);
  assert.equal((await f.req('/export/cloud/' + demo.id, 'POST', {})).status, 428);
  assert.equal((await f.req('/export/local', 'POST', { mmd: demoMmd })).status, 404);
  assert.equal((await f.req('/export/check', 'POST', { mmd: demoMmd })).status, 404);
  await f.req('/items/' + demo.id, 'PATCH', { mmd: '中文 $x=2$' });
  assert.equal((await f.store.get(demo.id)).mmd, '中文 $x=2$'); assert.equal(calls, 0);
  assert.equal((await fetch(f.url + '/api/items')).status, 403);
  assert.equal((await fetch(f.url + '/api/bootstrap', { headers: { Origin: 'https://example.com' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const r = http.get(f.url + '/api/bootstrap', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject);
  });
  assert.equal(hostStatus, 403);
});

test('image OCR automatically prepares official Word from unchanged MMD without leaking key', async t => {
  const mock = mockApi(); const f = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await importItem(f);
  assert.equal(mock.calls.length, 0, 'Import alone must not upload');
  const recognized = await (await f.req('/recognize/' + i.id, 'POST', {})).json();
  assert.equal(recognized.status, 'completed'); assert.equal(recognized.confidence, 0.67);
  const done = await f.waitWord(i.id);
  assert.equal(done.mmd, mmd); assert.equal(done.wordRequested, true);
  assert.equal(count(mock, '/v3/text'), 1); assert.equal(count(mock, '/v3/converter', 'POST'), 1);
  const imageBody = JSON.parse(mock.calls[0].opts.body.get('options_json'));
  assert.equal(mock.calls[0].opts.body.get('file').type, 'image/png');
  assert.equal(mock.calls[0].opts.headers['Content-Type'], undefined, 'fetch must generate the multipart boundary');
  assert.deepEqual(Buffer.from(await mock.calls[0].opts.body.get('file').arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'));
  assert.equal(imageBody.src, undefined, 'No base64 image in options');
  assert.deepEqual(imageBody.data_options, { include_latex: true, include_mathml: true });
  assert.equal(imageBody.metadata.improve_mathpix, false);
  assert.ok(!imageBody.formats.includes('docx'), 'v3/text cannot directly request DOCX');
  const conversion = JSON.parse(mock.calls.find(c => c.url.endsWith('/v3/converter')).opts.body);
  assert.equal(conversion.mmd, mmd); assert.deepEqual(conversion.formats, { docx: true });
  assert.equal((await f.req('/recognize/' + i.id, 'POST', {})).status, 400);
  assert.doesNotMatch(JSON.stringify(done), /fake-test-secret/);
});

test('PDF requests DOCX on upload and reuses job; edited text uses converter without repeat OCR', async t => {
  const mock = mockApi(); const f = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await importItem(f, 'pdf');
  const started = await (await f.req('/recognize/' + i.id, 'POST', { pages: '1-3,5' })).json();
  assert.equal(started.pdfId, 'mock-pdf');
  const options = JSON.parse(mock.calls[0].opts.body.get('options_json'));
  assert.equal(options.page_ranges, '1-3,5'); assert.deepEqual(options.conversion_formats, { docx: true });
  await f.req('/recognize/' + i.id, 'POST', {});
  assert.equal(count(mock, '/v3/pdf', 'POST'), 1);
  await f.req('/poll/' + i.id); const done = await f.waitWord(i.id);
  assert.equal(done.mmd, mmd); assert.equal(count(mock, '/v3/converter', 'POST'), 0);
  assert.equal(count(mock, '/v3/pdf/mock-pdf.docx'), 1);
  await f.req('/items/' + i.id, 'PATCH', { mmd: '编辑 $x=3$' });
  assert.equal((await f.req('/export/cloud/' + i.id + '/download')).status, 409);
  await f.req('/export/cloud/' + i.id, 'POST', {}); await f.waitWord(i.id);
  assert.equal(count(mock, '/v3/converter', 'POST'), 1); assert.equal(count(mock, '/v3/pdf', 'POST'), 1);
});

test('wait for DOCX status; concurrent clicks reuse job; cached downloads work offline without key', async t => {
  let status = 'processing'; const mock = mockApi({ formatStatus: () => status });
  const f = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await (await f.req('/demo', 'POST', {})).json();
  await Promise.all(Array.from({ length: 4 }, () => f.req('/export/cloud/' + i.id, 'POST', {})));
  await until(() => count(mock, '/v3/converter', 'POST') === 1);
  assert.equal((await f.req('/export/cloud/' + i.id + '/download')).status, 409);
  assert.equal(conversionState({ status: 'completed' }), 'processing');
  status = 'completed'; await f.waitWord(i.id); await until(() => !f.word.jobs.size);
  const before = mock.calls.length;
  f.credentials.value = {};
  for (let n = 0; n < 3; n++) {
    assert.equal((await f.req('/export/cloud/' + i.id, 'POST', {})).status, 200);
    const download = await f.req('/export/cloud/' + i.id + '/download');
    assert.equal(download.status, 200); assert.match(await download.text(), /^PK\x03\x04fake-docx/);
  }
  assert.equal(mock.calls.length, before);
  const cache = f.word.cachePath(i.id, wordHash(i.mmd)); await access(cache);
  await f.req('/items/' + i.id, 'DELETE');
  await assert.rejects(access(cache), { code: 'ENOENT' });
});

test('editing invalidates old Word; renaming or saving unchanged MMD preserves cache', async t => {
  const mock = mockApi(); const f = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await (await f.req('/demo', 'POST', {})).json();
  await f.req('/export/cloud/' + i.id, 'POST', {}); await f.waitWord(i.id); await until(() => !f.word.jobs.size);
  await f.req('/items/' + i.id, 'PATCH', { mmd: i.mmd, title: '只改名字' });
  await f.req('/export/cloud/' + i.id, 'POST', {});
  assert.equal(count(mock, '/v3/converter', 'POST'), 1);
  await f.req('/items/' + i.id, 'PATCH', { mmd: '新版本 $x=2$' });
  assert.equal((await f.req('/export/cloud/' + i.id + '/download')).status, 409);
  await f.req('/export/cloud/' + i.id, 'POST', {});
  const done = await f.waitWord(i.id);
  assert.equal(done.word.hash, wordHash('新版本 $x=2$')); assert.equal(count(mock, '/v3/converter', 'POST'), 2);
});

test('export after an edit during conversion never serves the previous revision', async t => {
  let status = 'processing'; const mock = mockApi({ formatStatus: () => status });
  const f = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await (await f.req('/demo', 'POST', {})).json();
  await f.req('/export/cloud/' + i.id, 'POST', {});
  await until(() => count(mock, '/v3/converter', 'POST') === 1);
  await f.req('/items/' + i.id, 'PATCH', { mmd: '新版 $x=9$' });
  await f.req('/export/cloud/' + i.id, 'POST', {});
  status = 'completed';
  const done = await f.waitWord(i.id);
  assert.equal(done.word.hash, wordHash('新版 $x=9$'));
  assert.equal(count(mock, '/v3/converter', 'POST'), 2);
  assert.match(await (await f.req('/export/cloud/' + i.id + '/download')).text(), /mock-conversion-2.docx$/);
});

test('conversion network failure preserves OCR and never resubmits automatically', async t => {
  const mock = mockApi({ failConvert: true }); const f = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await importItem(f);
  await f.req('/recognize/' + i.id, 'POST', {}); const done = await f.waitWord(i.id, 'error');
  await until(() => !f.word.jobs.size);
  assert.equal(done.status, 'completed'); assert.equal(done.mmd, mmd); assert.match(done.word.error, /无法连接/);
  assert.equal(count(mock, '/v3/text'), 1); assert.equal(count(mock, '/v3/converter', 'POST'), 1);
  assert.equal((await f.req('/recognize/' + i.id, 'POST', {})).status, 400);
});

test('legacy records reuse conversion ID without another OCR or conversion submission', async t => {
  const mock = mockApi(); const f = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await (await f.req('/demo', 'POST', {})).json();
  await f.store.put({ ...i, conversionId: 'legacy-job' });
  await f.req('/export/cloud/' + i.id, 'POST', {}); await f.waitWord(i.id);
  assert.equal(count(mock, '/v3/text'), 0); assert.equal(count(mock, '/v3/converter', 'POST'), 0);
  assert.equal(count(mock, '/v3/converter/legacy-job.docx'), 1);
});

test('restart resumes a known conversion; cached Word survives another restart', async t => {
  const mock = mockApi(); const first = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await (await first.req('/demo', 'POST', {})).json();
  await first.store.put({ ...i, conversionId: 'restart-job', word: { status: 'processing', hash: wordHash(i.mmd) } });
  await first.word.close();
  const second = await fixture(t, { dataDir: first.dataDir, testCredentials: credentials, fetchImpl: mock.fetchImpl });
  await second.waitWord(i.id); await second.word.close();
  const before = mock.calls.length;
  const third = await fixture(t, { dataDir: first.dataDir, fetchImpl: mock.fetchImpl });
  assert.equal((await third.req('/export/cloud/' + i.id + '/download')).status, 200);
  assert.equal(mock.calls.length, before); assert.equal(count(mock, '/v3/converter', 'POST'), 0);
});

test('deleting a pending record cannot resurrect it when conversion finishes', async t => {
  let status = 'processing'; const mock = mockApi({ formatStatus: () => status });
  const f = await fixture(t, { testCredentials: credentials, fetchImpl: mock.fetchImpl });
  const i = await (await f.req('/demo', 'POST', {})).json();
  await f.req('/export/cloud/' + i.id, 'POST', {});
  await until(() => count(mock, '/v3/converter', 'POST') === 1);
  await f.req('/items/' + i.id, 'DELETE'); status = 'completed';
  await until(() => !f.word.jobs.size);
  assert.equal(await f.store.get(i.id), null);
});

test('API errors cover invalid key, quota and HTTP-200 error response', async () => {
  for (const code of [401, 403, 429, 500]) {
    const c = new MathpixClient({ credentials: () => credentials, fetchImpl: async () => new Response('{}', { status: code }) });
    await assert.rejects(c.image(png), code === 401 ? /无效/ : code === 429 ? /额度/ : /API|Mathpix/);
  }
  const c = new MathpixClient({ credentials: () => credentials, fetchImpl: async () => json({ error_info: { message: 'not recognizable' } }) });
  await assert.rejects(c.image(png), /not recognizable/);
});

test('large image uses lossless binary upload below the complete multipart body limit', async () => {
  // This image fits the file limit but its old base64 JSON request exceeded 5 MB.
  const bytes = Buffer.alloc(4_586_577, 173);
  const src = 'data:image/png;base64,' + bytes.toString('base64');
  assert.ok(Buffer.byteLength(JSON.stringify({ src })) > 5_000_000);
  let calls = 0;
  const client = new MathpixClient({ credentials: () => credentials, fetchImpl: async (url, opts) => {
    calls++; assert.equal(url, 'https://api.mathpix.com/v3/text');
    const request = new Request(url, opts);
    const serialized = await request.clone().arrayBuffer();
    assert.ok(serialized.byteLength < 5_000_000);
    assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
    const received = await request.formData();
    assert.deepEqual(Buffer.from(await received.get('file').arrayBuffer()), bytes);
    const options = JSON.parse(received.get('options_json'));
    assert.deepEqual(options.formats, ['text', 'data', 'latex_styled']);
    assert.equal(options.metadata.improve_mathpix, false);
    return json({ text: 'large image recognized' });
  } });
  assert.equal((await client.image(src)).text, 'large image recognized');
  assert.equal(calls, 1);
});

test('oversized files are rejected locally and upstream size errors explain how to crop', async () => {
  let calls = 0;
  const client = new MathpixClient({ credentials: () => credentials, fetchImpl: async () => { calls++; return json({}); } });
  await assert.rejects(client.image('data:image/png;base64,' + Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1).toString('base64')),
    e => e.status === 413 && /4.90 MB|裁剪/.test(e.message));
  assert.equal(calls, 0);
  for (const status of [200, 400, 413]) {
    const c = new MathpixClient({ credentials: () => credentials, fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error: 'Request too large', error_info: { id: 'sys_request_too_large' } }), { status });
    } });
    await assert.rejects(c.image(png), e => e.status === 413 && /原图|裁剪/.test(e.message));
  }
  assert.equal(calls, 3, 'Failed submissions must not be retried automatically');
});

test('Windows key encryption round trip never stores plaintext', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(root, 'work', 'credential-test-'));
  const c = new Credentials(root, dir);
  await c.set({ appId: 'fake-test-id', appKey: 'fake-secret-do-not-use', remember: true });
  const disk = await readFile(path.join(dir, 'credentials.dpapi'), 'utf8');
  assert.doesNotMatch(disk, /fake-secret|appKey/);
  const reread = new Credentials(root, dir); await reread.init();
  assert.equal(reread.value.appKey, 'fake-secret-do-not-use'); assert.equal(reread.public().appKey, undefined);
  await reread.clear(); assert.equal(reread.public().configured, false);
});
