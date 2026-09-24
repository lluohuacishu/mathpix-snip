import path from 'node:path';
import { mkdir, readFile, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ApiError } from './mathpix.js';
import { atomicWrite } from './files.js';

function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value.trim()) || /[<>"|?*\x00-\x1f]/.test(value) || (process.platform === 'win32' && /:/.test(value.replace(/^[A-Za-z]:/, ''))))
    throw new ApiError('请选择文件夹，或填写完整的绝对路径。');
  return path.resolve(value.trim());
}

export class Preferences {
  constructor(dataDir, defaultDirectory) {
    this.file = path.join(dataDir, 'preferences.json');
    this.defaultDirectory = path.resolve(defaultDirectory);
    this.value = { outputDirectory: this.defaultDirectory, autoOpenWord: true };
  }
  async init() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof saved.autoOpenWord !== 'boolean') throw new Error('Invalid preferences');
      this.value = { outputDirectory: directory(saved.outputDirectory), autoOpenWord: saved.autoOpenWord };
    } catch (error) { if (error.code !== 'ENOENT') console.warn('导出设置未加载，已使用默认值。'); }
  }
  public() { return { ...this.value, defaultOutputDirectory: this.defaultDirectory }; }
  async set(input) {
    const next = { outputDirectory: directory(input?.outputDirectory), autoOpenWord: input?.autoOpenWord };
    if (typeof next.autoOpenWord !== 'boolean') throw new ApiError('请选择保存后是否自动打开 Word。');
    const probe = path.join(next.outputDirectory, '.mathsnip-write-' + randomUUID() + '.tmp');
    try {
      await mkdir(next.outputDirectory, { recursive: true });
      const handle = await open(probe, 'wx'); await handle.close(); await unlink(probe);
    } catch { throw new ApiError('无法写入这个文件夹，请检查目录权限、磁盘或网络盘连接。'); }
    try { await atomicWrite(this.file, JSON.stringify(next)); }
    catch { throw new ApiError('设置保存失败，原设置仍然有效。', 500); }
    this.value = next;
    return this.public();
  }
}
