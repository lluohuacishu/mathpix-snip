// Run the desktop integration test in invisible windows without using the desktop.
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.dirname(__dirname), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'tests/desktop-runtime.cjs'), '--background'], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
