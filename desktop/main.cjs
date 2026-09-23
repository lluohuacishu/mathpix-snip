const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray, shell, dialog } = require('electron');
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { pixelRect, processCapture } = require('./capture-core.cjs');
const root = path.dirname(__dirname), PORT = Number(process.env.SNIP_PORT || 47831);
const BASE = 'http://127.0.0.1:' + PORT + '/', HOTKEY = 'Alt+Shift+Q';
const background = process.argv.includes('--background');
const profile = path.join(process.env.SNIP_DATA_DIR || path.join(root, 'data'), 'desktop-shell');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setName('Math Snip');
app.setAppUserModelId('com.mathsnip.local');
let mainWindow, tray, capture, localServer, appService, retryTimer, isQuitting = false, showOnReady = !background, token;
let state = { phase: 'idle', busy: false, registered: false, hotkey: HOTKEY, itemId: null, detail: '', revision: 0 };

function icon() {
  const bytes = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const stroke = x >= 7 && x <= 10 && y >= 10 && y <= 25 || x >= 15 && x <= 18 && y >= 13 && y <= 25 || x >= 23 && x <= 26 && y >= 13 && y <= 25 || y >= 9 && y <= 12 && x >= 7 && x <= 23;
    bytes.set(stroke ? [244, 255, 246, 255] : [87, 107, 23, 255], (y * 32 + x) * 4);
  }
  return nativeImage.createFromBitmap(bytes, { width: 32, height: 32 });
}
function update(patch) {
  state = { ...state, ...patch, revision: state.revision + 1 };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-state', state);
  writeStatus();
}
function writeStatus() {
  // Operational state only: never save screenshot bytes, credentials or OCR text.
  try { writeFileSync(path.join(profile, 'status.json'), JSON.stringify({ pid: process.pid, version: '1.5.1', registered: state.registered, busy: state.busy, phase: state.phase, visible: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(), updatedAt: new Date().toISOString() })); } catch {}
}
async function ensureServer() {
  let response;
  try { response = await fetch(BASE + 'api/health', { signal: AbortSignal.timeout(1500) }); } catch {}
  if (response) {
    const health = await response.json().catch(() => ({}));
    if (!response.ok || health.app !== 'mathpix-snip-local') throw new Error('端口 ' + PORT + ' 被其他程序占用。');
    return;
  }
  const { createApp } = await import(pathToFileURL(path.join(root, 'server.js')).href);
  appService = await createApp({
    openFolder: folder => shell.openPath(folder).then(error => { if (error) throw new Error(error); }),
  });
  await new Promise((resolve, reject) => {
    localServer = appService.app.listen(PORT, '127.0.0.1', resolve);
    localServer.once('error', reject);
  });
}
async function bootstrap() {
  const response = await fetch(BASE + 'api/bootstrap', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('本地服务连接失败，请退出后重新启动工具。');
  const boot = await response.json(); token = boot.token; return boot;
}
async function api(route, method = 'GET', body) {
  const response = await fetch(BASE + 'api' + route, {
    method, headers: { 'x-snip-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(150000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '本地服务返回错误 ' + response.status);
  return data;
}
function external(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && ['mathpix.com', 'console.mathpix.com', 'accounts.mathpix.com', 'docs.mathpix.com'].includes(parsed.hostname)) shell.openExternal(url).catch(() => {});
  } catch {}
}
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 960, minWidth: 900, minHeight: 650, show: false, icon: icon(),
    backgroundColor: '#f6f8f5', title: 'Math Snip · 数学识别工作台', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'main-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(wc === mainWindow.webContents && wc.getURL() === BASE && ['clipboard-read', 'clipboard-sanitized-write'].includes(permission)));
  mainWindow.webContents.on('will-prevent-unload', () => { isQuitting = false; showMain(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== BASE) { event.preventDefault(); external(url); } });
  mainWindow.loadURL(BASE);
  mainWindow.once('ready-to-show', () => { if (showOnReady) showMain(); else writeStatus(); });
  mainWindow.on('show', writeStatus); mainWindow.on('hide', writeStatus);
  let notified = false;
  mainWindow.on('close', event => {
    if (isQuitting) return;
    event.preventDefault(); mainWindow.hide();
    if (!notified) { tray?.displayBalloon({ title: 'Math Snip 仍在后台运行', content: '按 Alt + Shift + Q 框选，调整后按 Enter 识别；从托盘菜单可以退出。' }); notified = true; }
  });
}
function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function closeCapture(session) {
  if (capture === session) capture = null;
  clearTimeout(session.timer);
  if (session.window && !session.window.isDestroyed()) session.window.destroy();
}
function cancelCapture() {
  const session = capture;
  if (!session) return;
  closeCapture(session); update({ phase: 'idle', busy: false, detail: '' });
  if (session.restoreMain) showMain();
}
async function beginCapture() {
  if (state.busy) { if (!capture) showMain(); return; }
  const session = { restoreMain: !!mainWindow?.isFocused() };
  capture = session;
  update({ phase: 'capturing', busy: true, itemId: null, detail: '' });
  try {
    if (session.restoreMain) { mainWindow.hide(); await new Promise(resolve => setTimeout(resolve, 180)); }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await Promise.race([desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
      width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor),
    }, fetchWindowIcons: false }), new Promise((_, reject) => {
      session.timer = setTimeout(() => reject(new Error('获取屏幕超时，请重试。')), 12000);
    })]);
    clearTimeout(session.timer);
    const source = sources.find(s => String(s.display_id) === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法截取鼠标所在屏幕，请重试。');
    if (capture !== session) return;
    session.image = source.thumbnail;
    const win = session.window = new BrowserWindow({
      ...display.bounds, show: false, title: 'Math Snip · 框选截图', frame: false,
      movable: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
      fullscreenable: false, focusable: true, backgroundColor: '#19231e',
      webPreferences: { preload: path.join(__dirname, 'capture-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setMenu(null); win.setAlwaysOnTop(true, 'screen-saver'); win.setBounds(display.bounds);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('closed', () => { if (capture === session) cancelCapture(); });
    session.timer = setTimeout(() => {
      if (capture !== session) return;
      closeCapture(session); update({ phase: 'error', busy: false, detail: '截图界面加载失败，请重试。' }); showMain();
    }, 15000);
    await win.loadFile(path.join(__dirname, 'capture.html'));
    if (capture === session) win.webContents.send('capture-frame', { dataUrl: session.image.toDataURL() });
  } catch (error) {
    closeCapture(session); update({ phase: 'error', busy: false, detail: error.message }); showMain();
  }
}
async function selected(rect) {
  const session = capture;
  if (!session?.image) return;
  // Detach before awaiting so repeated selection cannot upload twice.
  closeCapture(session);
  try {
    const source = session.image.crop(pixelRect(rect, session.image.getSize())).toDataURL();
    session.image = null;
    update({ phase: 'processing', busy: true, detail: '正在保存截图…' });
    const boot = await bootstrap();
    await processCapture({ source, configured: boot.settings.configured, api, report: patch => {
      update(patch); if (patch.itemId) showMain();
    } });
  } catch (error) { update({ phase: 'error', busy: false, detail: error.message }); showMain(); }
}
function trustedMain(event) { return event.sender === mainWindow?.webContents && event.senderFrame?.url === BASE; }
ipcMain.handle('desktop-state', event => { if (!trustedMain(event)) throw new Error('不允许此操作'); return state; });
ipcMain.handle('desktop-capture', event => { if (!trustedMain(event)) throw new Error('不允许此操作'); void beginCapture(); });
ipcMain.on('capture-ready', event => {
  const session = capture;
  if (event.sender !== session?.window?.webContents) return;
  clearTimeout(session.timer); session.window.show(); session.window.focus();
});
ipcMain.on('capture-select', (event, rect) => { if (event.sender === capture?.window?.webContents) void selected(rect); });
ipcMain.on('capture-cancel', event => { if (event.sender === capture?.window?.webContents) cancelCapture(); });
async function boot() {
  await ensureServer(); await bootstrap(); createMainWindow();
  tray = new Tray(icon()); tray.setToolTip('Math Snip · Alt + Shift + Q 截图');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Math Snip', click: showMain },
    { label: '框选截图（Alt + Shift + Q）', click: () => void beginCapture() },
    { type: 'separator' },
    { label: '退出 Math Snip', click: () => {
      if (state.busy) { update({ detail: '请先完成或取消当前截图识别，再退出。' }); showMain(); return; }
      app.quit();
    } },
  ]));
  tray.on('double-click', showMain);
  registerHotkey();
  retryTimer = setInterval(() => { if (!state.registered) registerHotkey(); }, 3000);
  retryTimer.unref();
}
function registerHotkey() {
  const registered = globalShortcut.isRegistered(HOTKEY) || globalShortcut.register(HOTKEY, () => void beginCapture());
  if (registered !== state.registered || state.revision === 0) {
    update({ registered, ...(state.phase === 'idle' ? { detail: registered ? '' : 'Alt + Shift + Q 已被其他程序占用；关闭冲突程序后会自动恢复，也可点击“截取屏幕”。' } : {}) });
  }
}
if (!app.requestSingleInstanceLock({ background })) app.quit();
else {
  app.on('second-instance', (_event, _argv, _cwd, additional) => { registerHotkey(); if (!additional?.background) { showOnReady = true; showMain(); } });
  app.whenReady().then(boot).catch(error => { console.error('Math Snip 启动失败：' + error.message); if (!background) dialog.showErrorBox('Math Snip 启动失败', error.message); app.quit(); });
  app.on('before-quit', () => { isQuitting = true; if (capture) closeCapture(capture); });
  app.on('will-quit', () => { clearInterval(retryTimer); globalShortcut.unregisterAll(); state.registered = false; state.phase = 'stopped'; writeStatus(); tray?.destroy(); appService?.word.close().catch(() => {}); appService?.pdf.close().catch(() => {}); localServer?.close(); });
  app.on('window-all-closed', () => {});
  app.on('activate', showMain);
}
