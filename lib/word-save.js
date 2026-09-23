import path from 'node:path';
import os from 'node:os';
import { mkdir, open, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const defaultWordDirectory = path.join(os.homedir(), 'Documents', 'Mathsnip');

export function wordFilename(title) {
  let stem = String(title || '数学笔记').replace(/\.(png|jpe?g|webp|bmp|pdf|docx)$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 90).replace(/[. ]+$/g, '');
  if (!stem) stem = '数学笔记';
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  return stem + '.docx';
}

export function openWordFile(file) {
  if (process.platform !== 'win32') return Promise.reject(new Error('请在文件管理器中打开已保存的文档。'));
  return new Promise((resolve, reject) => {
    // Explorer delegates this .docx to the user's existing file association.
    const child = spawn('explorer.exe', [file], { windowsHide:true, detached:true, stdio:'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function openFolderPath(folder) {
  if (process.platform !== 'win32') return Promise.reject(new Error('请在文件管理器中打开已保存的文件夹。'));
  const target = path.resolve(folder);
  return new Promise((resolve, reject) => {
    // Open the directory itself in Explorer. Keep this separate from the
    // document association path so the PDF "打开文件夹" action is reliable.
    const child = spawn('explorer.exe', [target], { windowsHide:false, detached:true, stdio:'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function saveAndOpenWord({ buffer, title, directory = defaultWordDirectory, openFile = openWordFile }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('官方 Word 文件无效，请重新准备文档。');
  const folder = path.resolve(directory), name = wordFilename(title), stem = name.slice(0, -5);
  let file;
  try {
    await mkdir(folder, { recursive:true });
    for (let index = 0; index < 10000; index++) {
      const candidate = path.join(folder, stem + (index ? ' (' + (index + 1) + ')' : '') + '.docx');
      let handle;
      try { handle = await open(candidate, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      try { await handle.writeFile(buffer); await handle.sync(); }
      catch (error) { await handle.close(); await unlink(candidate).catch(() => {}); throw error; }
      await handle.close(); file = candidate; break;
    }
    if (!file) throw new Error('同名文件过多，请修改记录标题后重试。');
  } catch (error) {
    throw new Error('Word 保存失败：' + folder + '。' + (error.code === 'ENOSPC' ? '磁盘空间不足。' : ['EACCES','EPERM'].includes(error.code) ? '请检查目录写入权限。' : error.message));
  }
  try {
    await openFile(file);
    return { path:file, opened:true };
  } catch (error) {
    // A launch failure must not hide the successfully saved document.
    return { path:file, opened:false, error:'文档已保存，但自动打开失败：' + error.message };
  }
}
