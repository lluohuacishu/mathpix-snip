import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './mathpix.js';

export class Credentials {
  constructor(root, dataDir) {
    this.root = root; this.file = path.join(dataDir, 'credentials.dpapi');
    this.value = { appId: process.env.MATHPIX_APP_ID || '', appKey: process.env.MATHPIX_APP_KEY || '' };
    this.remember = false;
  }
  async crypt(mode, input) {
    if (process.platform !== 'win32') throw new ApiError('此版本的加密保存仅支持 Windows；可使用当前会话或环境变量。');
    return new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.root, 'scripts', 'credentials.ps1'), '-Mode', mode], { windowsHide: true, timeout: 15_000 });
      let out = '';
      p.stdout.on('data', b => { out += b.toString(); }); p.stderr.resume();
      p.on('error', () => reject(new ApiError('Windows 密钥加密功能不可用。', 500)));
      p.on('close', c => c === 0 ? resolve(out) : reject(new ApiError('Windows 无法读取或保存加密密钥。', 500)));
      p.stdin.on('error', () => {}); p.stdin.end(input);
    });
  }
  async init() {
    try { this.value = JSON.parse(await this.crypt('unprotect', await readFile(this.file, 'utf8'))); this.remember = true; }
    catch (e) { if (e.code !== 'ENOENT') console.warn('保存的密钥未加载；请在界面重新填写。'); }
  }
  public() { return { appId: this.value.appId, configured: !!(this.value.appId && this.value.appKey), keyHint: this.value.appKey ? '••••' + this.value.appKey.slice(-4) : '', remember: this.remember }; }
  async set({ appId, appKey, remember = false }) {
    appId = String(appId || '').trim(); appKey = String(appKey || this.value.appKey || '').trim();
    if (!appId || !appKey || appId.length > 200 || appKey.length > 500 || /[\r\n]/.test(appId + appKey)) throw new ApiError('请填写有效的 App ID 和 App Key。');
    const value = { appId, appKey };
    if (remember) await writeFile(this.file, await this.crypt('protect', JSON.stringify(value)), { mode: 0o600 });
    else await rm(this.file, { force: true });
    this.value = value; this.remember = !!remember;
    return this.public();
  }
  async clear() { await rm(this.file, { force: true }); this.value = { appId: '', appKey: '' }; this.remember = false; }
}
