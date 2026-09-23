const { spawn } = require('node:child_process');
const path = require('node:path');
const { existsSync } = require('node:fs');
const root = path.dirname(__dirname);
const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!existsSync(executable)) {
  console.error('缺少 Electron 桌面运行时，请在工程目录运行 npm install，然后运行 node node_modules/electron/install.js。');
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = [root];
if (process.argv.includes('--background')) args.push('--background');
const child = spawn(executable, args, { cwd: root, detached: true, stdio: 'ignore', env });
child.on('error', error => { console.error('启动失败：' + error.message); process.exitCode = 1; });
child.unref();
