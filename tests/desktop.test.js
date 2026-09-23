import test from 'node:test';
import assert from 'node:assert/strict';
import core from '../desktop/capture-core.cjs';
const { pixelRect, processCapture } = core;

test('capture coordinates retain physical pixels at 150% scale and clip screen boundaries', () => {
  assert.deepEqual(pixelRect({ x: 200/1920, y: 100/1080, w: 400/1920, h: 300/1080 }, { width: 2880, height: 1620 }), { x:300, y:150, width:600, height:450 });
  assert.deepEqual(pixelRect({ x:-0.1, y:0.9, w:0.5, h:0.2 }, { width:1000, height:1000 }), { x:0, y:900, width:400, height:100 });
  for (const rect of [null, { x:NaN,y:0,w:1,h:1 }, { x:0,y:0,w:-1,h:1 }, { x:1,y:0,w:1,h:1 }, { x:0,y:0,w:0.001,h:0.001 }]) assert.throws(() => pixelRect(rect, { width:100, height:100 }));
});
test('capture without a key saves locally without attempting OCR', async () => {
  const calls = [], states = [];
  await processCapture({ source:'test-image', configured:false, api: async (...args) => { calls.push(args); return { id:'capture-1' }; }, report: s => states.push(s) });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '/items');
  assert.equal(states[0].phase, 'needs-key'); assert.equal(states[0].itemId, 'capture-1'); assert.equal(states[0].busy, false);
});
test('capture shows imported image before OCR finishes and submits exactly once', async () => {
  const calls = [], states = []; let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const task = processCapture({ source:'test-image', configured:true, api: async (route) => { calls.push(route); if (route === '/items') return { id:'capture-2' }; await done; return { id:'capture-2' }; }, report: s => states.push(s) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states[0].phase, 'processing'); assert.equal(states[0].itemId, 'capture-2');
  finish(); await task;
  assert.deepEqual(calls, ['/items', '/recognize/capture-2']);
  assert.equal(states.at(-1).phase, 'completed'); assert.equal(states.at(-1).busy, false);
});
test('OCR failure preserves captured record and never silently retries', async () => {
  const calls = [], states = [];
  await processCapture({ source:'test-image', configured:true, api: async route => { calls.push(route); if (route === '/items') return { id:'capture-3' }; throw new Error('Request too large'); }, report: s => states.push(s) });
  assert.equal(calls.length, 2); assert.equal(states.at(-1).itemId, 'capture-3');
  assert.equal(states.at(-1).phase, 'error'); assert.equal(states.at(-1).busy, false); assert.equal(states.at(-1).detail, 'Request too large');
});
