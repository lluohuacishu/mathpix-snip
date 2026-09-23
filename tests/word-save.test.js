import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveAndOpenWord, wordFilename } from '../lib/word-save.js';

const work = fileURLToPath(new URL('../work/', import.meta.url));
await mkdir(work, { recursive:true });
const docx = Buffer.from('PK\x03\x04mock-official-docx');

test('saved Word is complete before opening; concurrent same-name exports preserve existing edits', async () => {
  const directory = await mkdtemp(path.join(work, 'word-save-'));
  const original = path.join(directory, '题目.docx'); await writeFile(original, 'user-edited-word');
  const opened = [];
  const exports = await Promise.all(Array.from({length:3}, () => saveAndOpenWord({ buffer:docx, title:'题目.png', directory, openFile:async file => { assert.deepEqual(await readFile(file), docx); opened.push(file); } })));
  assert.equal(await readFile(original, 'utf8'), 'user-edited-word');
  assert.equal(new Set(exports.map(result => result.path)).size, 3);
  assert.equal(exports.every(result => result.opened && path.dirname(result.path) === directory), true);
  assert.equal(opened.length, 3);
  assert.deepEqual((await readdir(directory)).sort(), ['题目 (2).docx','题目 (3).docx','题目 (4).docx','题目.docx'].sort());
});

test('Word names handle traversal, Windows reserved names and trailing dots safely', () => {
  for (const name of ['../../outside.docx', '..\\..\\outside.exe', 'C:\\outside', 'CON', 'NUL.txt', 'COM1.pdf', 'LPT¹.docx', '...', '题目.  ']) {
    const safe = wordFilename(name);
    assert.equal(path.basename(safe), safe); assert.match(safe, /\.docx$/);
    assert.doesNotMatch(safe, /[<>:"/\\|?*\x00-\x1f]/);
    assert.doesNotMatch(safe, /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i);
  }
});

test('opening failure returns the saved path; save failure never launches a document', async () => {
  const directory = await mkdtemp(path.join(work, 'word-save-error-'));
  const result = await saveAndOpenWord({ buffer:docx, title:'打不开', directory, openFile:async () => { throw new Error('no association'); } });
  assert.equal(result.opened, false); assert.match(result.error, /已保存/); assert.deepEqual(await readFile(result.path), docx);
  let opened = false;
  await assert.rejects(saveAndOpenWord({ buffer:docx, title:'failed', directory:result.path, openFile:async () => { opened = true; } }), /保存失败/);
  await assert.rejects(saveAndOpenWord({ buffer:Buffer.from('not-docx'), title:'invalid', directory, openFile:async () => { opened = true; } }), /无效/);
  assert.equal(opened, false);
});
