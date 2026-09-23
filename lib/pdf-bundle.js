import path from 'node:path';
import yauzl from 'yauzl';
import { mkdir, open, readFile, lstat, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { wordFilename } from './word-save.js';

function zipPath(name) {
  const parts = name.replaceAll('\\','/').split('/').filter(Boolean);
  if (!parts.length || /^[\\/]/.test(name) || parts.some(p => p === '..' || p === '.' || /[<>:"|?*\x00-\x1f]|[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p))) throw new Error('Markdown 压缩包包含无效路径。');
  return parts.join('/');
}
export async function unpackMarkdown(buffer) {
  const zip = await new Promise((resolve,reject) => yauzl.fromBuffer(buffer,{lazyEntries:true},(e,z) => e ? reject(e) : resolve(z)));
  const entries = new Map(); let total = 0, count = 0;
  return new Promise((resolve,reject) => {
    const fail = error => { zip.close(); reject(error); };
    zip.on('error',fail);
    zip.on('entry', async entry => {
      try {
        const name = zipPath(entry.fileName);
        if (++count > 10000 || (total += entry.uncompressedSize) > 512*1024*1024 || entry.uncompressedSize > 100*1024*1024) throw new Error('Markdown 压缩包解压后过大。');
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Markdown 压缩包不允许符号链接。');
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        if (!/\.(md|png|jpe?g|gif|webp|bmp|svg|tiff?)$/i.test(name)) throw new Error('Markdown 压缩包包含非预期文件：' + name);
        if ([...entries.keys()].some(key => key.toLowerCase() === name.toLowerCase())) throw new Error('Markdown 压缩包包含重名文件。');
        const stream = await new Promise((r,j) => zip.openReadStream(entry,(e,s) => e ? j(e) : r(s)));
        const chunks = []; let actual = 0;
        for await (const chunk of stream) { actual += chunk.length; if (actual > entry.uncompressedSize) throw new Error('压缩包文件长度异常。'); chunks.push(chunk); }
        entries.set(name,Buffer.concat(chunks)); zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.on('end', () => {
      const markdown = [...entries.keys()].filter(name => /\.md$/i.test(name));
      if (markdown.length !== 1) return reject(new Error('官方压缩包应包含一份 Markdown 文件。'));
      const mdName = markdown[0], prefix = path.posix.dirname(mdName);
      let text = entries.get(mdName).toString('utf8');
      // Moving a nested Markdown file to the bundle root keeps asset references valid.
      if (prefix !== '.') {
        const local = value => /^(?:[a-z]+:|\/|#)/i.test(value) ? value : prefix + '/' + value;
        text = text.replace(/(!?\[[^\]\n]*\]\()([^\s)]+)([^)]*\))/g, (_m,a,b,c) => a+local(b)+c)
          .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm,(_m,a,b) => a+local(b))
          .replace(/(\bsrc=["'])([^"']+)(["'])/gi,(_m,a,b,c) => a+local(b)+c);
      }
      entries.delete(mdName); resolve({ text, images:entries });
    });
    zip.readEntry();
  });
}
export async function reserveBundle(directory, title) {
  await mkdir(directory,{recursive:true});
  const stem = wordFilename(title).slice(0,-5);
  for (let n=0;n<10000;n++) {
    const folder = path.join(directory,stem+(n ? ' ('+(n+1)+')' : ''));
    try { await mkdir(folder); return { folder, stem }; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名文件夹过多，请修改记录标题。');
}
export async function writeBundleFile(folder, relative, bytes) {
  const safe = zipPath(relative), target = path.join(folder,...safe.split('/'));
  let current = folder;
  if ((await lstat(folder)).isSymbolicLink()) throw new Error('输出文件夹不能是符号链接。');
  for (const part of safe.split('/').slice(0,-1)) {
    current = path.join(current,part);
    await mkdir(current,{recursive:true});
    if ((await lstat(current)).isSymbolicLink()) throw new Error('输出路径不能是符号链接。');
  }
  const temp = path.join(folder,'.saving-'+randomUUID()+'.tmp');
  try {
    const handle = await open(temp,'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Publish a complete file without replacing an existing name, including on Windows.
    try { await link(temp,target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await lstat(target)).isSymbolicLink() || !(await readFile(target)).equals(Buffer.from(bytes))) throw new Error('文件已被修改，已保留原文件：' + target);
    }
  } finally { await unlink(temp).catch(() => {}); }
  return target;
}
