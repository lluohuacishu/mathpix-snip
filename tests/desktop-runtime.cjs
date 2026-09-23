// Real Electron renderers and IPC, synthetic screen pixels, isolated API/data.
// No OS input, screenshots, focus changes, clipboard access or external requests.
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync, mkdtempSync, readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PDFDocument } = require('pdf-lib');
const yazl = require('yazl');
const electron = require('electron');
const { app, BrowserWindow, nativeImage, screen } = electron;
const root = path.dirname(__dirname);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 18000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(50); }
  throw new Error('Timed out: ' + label);
}
mkdirSync(path.join(root,'work'),{recursive:true});
const dataDir = mkdtempSync(path.join(root, 'work', 'desktop-runtime-'));
process.env.SNIP_DATA_DIR = dataDir;
let service, server, main, releaseOcr, failOcr = false, hotkeyCallback, registered = false, registerAttempts = 0;
const counts = { ocr: 0, conversion: 0, show: 0, screenshot: 0 };
const openedWords = [], openedFolders = [], fakeDocx = Buffer.from('PK\x03\x04synthetic-docx');
let failOpenFolder = false;
const pdfSubmissions = [];
const errors = [];
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const mmd = '隐藏窗口集成验证：$x^2+y^2=r^2$';
async function run() {
  const { createApp } = await import(pathToFileURL(path.join(root, 'server.js')).href);
  const zip = new yazl.ZipFile(); zip.addBuffer(Buffer.from('# Plain Markdown\n\n$x^2$'),'result.md');
  const chunks = []; const zipped = new Promise(resolve => zip.outputStream.on('data',c => chunks.push(c)).on('end',() => resolve(Buffer.concat(chunks)))); zip.end(); const archive = await zipped;
  service = await createApp({ dataDir, pdfOptions:{pollMs:50,maxPolls:100}, wordDirectory:path.join(dataDir,'exports'), openFolder:async folder => { if (failOpenFolder) throw new Error('测试资源管理器失败'); openedFolders.push(folder); }, openWord:async file => { assert.deepEqual(readFileSync(file),fakeDocx); openedWords.push(file); }, testCredentials: { appId:'desktop-test', appKey:'fake-key-never-sent' }, wordOptions: { pollMs:20 }, fetchImpl: async (url, options) => {
    if (options.method === 'POST' && (url.endsWith('/files/v1') || url.endsWith('/v3/pdf'))) {
      pdfSubmissions.push({url,options:JSON.parse(options.body.get('options_json'))});
      return json(url.endsWith('/files/v1') ? {file_id:'ui-files'} : {pdf_id:'ui-fast'});
    }
    if (url.endsWith('.md.zip')) return new Response(archive);
    if (url.endsWith('.mmd')) return new Response(mmd);
    if (url.endsWith('/v3/text')) {
      counts.ocr++;
      if (failOcr) return new Response(JSON.stringify({ error:'Request too large' }), { status:413 });
      await new Promise(resolve => { releaseOcr = resolve; });
      return json({ text:mmd, confidence_rate:0.98 });
    }
    if (url.endsWith('/v3/converter') && options.method === 'POST') { counts.conversion++; return json({ conversion_id:'test-conversion' }); }
    if (url.endsWith('.docx')) return new Response(fakeDocx);
    return json({ status:'completed',percent_done:100,num_pages:2,formats:{docx:'completed','md.zip':'completed'},conversion_status:{docx:{status:'completed'},'md.zip':{status:'completed'}} });
  } });
  server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  process.env.SNIP_PORT = String(server.address().port);
  class FakeTray extends EventEmitter { setToolTip() {} setContextMenu() {} displayBalloon() {} destroy() {} }
  function HiddenWindow(options) {
    const win = new BrowserWindow({ ...options, show:false, alwaysOnTop:false, webPreferences:{ ...options.webPreferences, backgroundThrottling:false } });
    win.show = () => { counts.show++; };
    win.focus = () => {};
    win.setAlwaysOnTop = () => {};
    win.webContents.on('console-message', (...args) => {
      const details = args.find(v => v && typeof v === 'object' && 'message' in v);
      if (details?.level === 'error') errors.push(details.message);
    });
    return win;
  }
  const source = nativeImage.createFromBitmap(Buffer.alloc(640 * 400 * 4, 255), { width:640, height:400 });
  const testElectron = { ...electron, BrowserWindow:HiddenWindow, Tray:FakeTray,
    globalShortcut: {
      register: (key, fn) => { assert.equal(key, 'Alt+Shift+Q'); hotkeyCallback = fn; registered = ++registerAttempts > 1; return registered; },
      isRegistered: () => registered, unregisterAll: () => { registered = false; },
    },
    desktopCapturer: { getSources: async () => { counts.screenshot++; return [{ display_id:String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id), thumbnail:source }]; } },
  };
  const originalLoad = Module._load;
  Module._load = function(name, parent, ...rest) { return name === 'electron' && parent?.filename === path.join(root, 'desktop/main.cjs') ? testElectron : originalLoad.call(this, name, parent, ...rest); };
  require('../desktop/main.cjs');
  Module._load = originalLoad;
  await app.whenReady();
  main = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http:')), 'main window');
  const evalMain = js => main.webContents.executeJavaScript(js);
  const getState = () => evalMain('window.desktopCapture.getState()');
  await until(async () => (await evalMain('document.querySelector("#desktop-note")?.textContent'))?.includes('占用'), 'initial shortcut conflict');
  await until(async () => (await getState()).registered, 'shortcut recovers after conflict');
  assert.equal(registerAttempts, 2); assert.equal(main.isVisible(), false); assert.equal(counts.show, 0);
  const initialCount = (await service.store.list()).length;
  async function overlay() {
    return until(async () => {
      const win = BrowserWindow.getAllWindows().find(w => w !== main);
      if (!win || win.webContents.isLoading()) return;
      return await win.webContents.executeJavaScript('!!window.captureOverlay && document.querySelector("#frame")?.naturalWidth === 640 && document.body.dataset.ready === "true"') && win;
    }, 'overlay frame');
  }
  async function choose(win,adjust=false,button=false) {
    const before=counts.ocr;
    await win.webContents.executeJavaScript(`
      document.body.setPointerCapture = () => {};
      for (const [type,x,y] of [['pointerdown',.75,.75],['pointermove',.25,.25],['pointerup',.25,.25]]) {
        document.body.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:innerWidth*x,clientY:innerHeight*y}));
      }
    `).catch(error => { if (!win.isDestroyed()) throw error; });
    assert.equal(counts.ocr,before);assert.equal(win.isDestroyed(),false);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#actions").hidden'),false);
    if(adjust)await win.webContents.executeJavaScript(`
      for(const [a,b,c,d] of [[.5,.5,.55,.55],[.8,.8,.9,.9],[.3,.3,.4,.4]]){
        for(const [type,x,y] of [['pointerdown',a,b],['pointermove',c,d],['pointerup',c,d]])document.body.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:innerWidth*x,clientY:innerHeight*y}));
      }
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft'}));
      const r=document.querySelector('#selection').getBoundingClientRect();if(Math.abs(r.x/innerWidth-.4)>.005||Math.abs(r.width/innerWidth-.5)>.005)throw new Error('adjusted selection incorrect');
    `);
    assert.equal(counts.ocr,before);
    await win.webContents.executeJavaScript(button?'document.querySelector("#confirm").click()':'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}));document.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}))').catch(error=>{if(!win.isDestroyed())throw error;});
  }
  await evalMain('document.querySelector("#capture").click()');
  let win = await overlay();
  await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}))');
  assert.equal(win.isDestroyed(),false);assert.equal(counts.ocr,0);
  await win.webContents.executeJavaScript(`
    document.body.setPointerCapture=()=>{};
    for(const [type,x,y] of [['pointerdown',.1,.1],['pointermove',.4,.4],['pointerup',.4,.4]])document.body.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:innerWidth*x,clientY:innerHeight*y}));
    document.querySelector('#reset').click();
    if(!document.querySelector('#selection').hidden)throw new Error('reset should clear selection');
    for(const [type,x,y] of [['pointerdown',.2,.2],['pointermove',.5,.5],['pointerup',.5,.5]])document.body.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:innerWidth*x,clientY:innerHeight*y}));
  `);
  assert.equal(counts.ocr,0);
  await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))').catch(error => { if (!win.isDestroyed()) throw error; });
  await until(async () => !(await getState()).busy, 'Escape cancels capture');
  assert.equal((await service.store.list()).length, initialCount); assert.equal(counts.ocr, 0);
  // The global shortcut callback still works when the main window has been closed to tray.
  main.close(); assert.equal(main.isDestroyed(), false); hotkeyCallback(); win = await overlay(); await choose(win,true);
  await until(() => counts.ocr === 1 && releaseOcr, 'OCR starts once');
  const processing = await getState(); assert.equal(processing.phase, 'processing');
  await until(() => evalMain('document.querySelector("#editor").disabled && document.querySelector("#notice").textContent.includes("自动识别")'), 'imported image shown while processing');
  const stored = await service.store.get(processing.itemId);
  assert.deepEqual(nativeImage.createFromDataURL(stored.source).getSize(), { width:320, height:200 });
  hotkeyCallback(); assert.equal(counts.ocr, 1); assert.equal(BrowserWindow.getAllWindows().length, 1);
  releaseOcr();
  await until(async () => (await getState()).phase === 'completed', 'OCR completes');
  await until(() => evalMain('document.querySelector("#editor").value.includes("x^2+y^2=r^2") && !document.querySelector("#editor").disabled'), 'result appears automatically');
  await until(async () => (await service.store.get(processing.itemId)).word?.status === 'completed', 'official Word cached');
  assert.equal(counts.conversion, 1);
  await evalMain('document.querySelector("#export").click()');
  await until(() => openedWords.length === 1, 'Word saved before opening');
  await until(() => evalMain('!document.querySelector("#export-dialog").open && document.querySelector("#word-status").textContent.includes("保存并打开")'), 'saved and opened notice');
  assert.equal(path.dirname(openedWords[0]),path.join(dataDir,'exports'));
  assert.equal(counts.conversion,1);
  await evalMain('document.querySelector("#export").click()');
  await until(() => openedWords.length === 2, 'second export');
  assert.notEqual(openedWords[0],openedWords[1]); assert.equal(counts.conversion,1);
  await until(() => evalMain('!document.querySelector("#export-dialog").open'), 'export closes');
  // Save a pending edit before changing records, then retain the failed image.
  await evalMain('document.querySelector("#new-text").click()');
  await until(() => evalMain('document.querySelector("#title").value === "新建公式笔记"'), 'new note');
  await evalMain('document.querySelector("#editor").value = "保留未保存的编辑 $a+b$"; document.querySelector("#editor").dispatchEvent(new Event("input",{bubbles:true}))');
  failOcr = true; hotkeyCallback(); win = await overlay(); await choose(win,false,true);
  await until(async () => (await getState()).phase === 'error', 'OCR failure');
  const failed = await getState();
  await until(() => evalMain('document.querySelector("#notice").textContent.includes("裁剪")'), 'size error visible');
  assert.equal((await service.store.get(failed.itemId)).status, 'error');
  const notes = (await service.store.list()).filter(item => item.kind === 'text');
  assert.equal((await service.store.get(notes[0].id)).mmd, '保留未保存的编辑 $a+b$');
  assert.equal(counts.ocr, 2);
  service.credentials.value = { appId:'', appKey:'' };
  hotkeyCallback(); win = await overlay(); await choose(win);
  await until(async () => (await getState()).phase === 'needs-key', 'missing key');
  assert.equal(counts.ocr, 2);
  assert.equal((await service.store.get((await getState()).itemId)).status, 'ready');
  service.credentials.value = {appId:'desktop-test',appKey:'fake-key-never-sent'};
  const samplePdf = await PDFDocument.create(); samplePdf.addPage(); samplePdf.addPage(); const bytes = await samplePdf.save();
  for (const mode of ['files','fast']) {
    await evalMain(`{
      const transfer=new DataTransfer(); transfer.items.add(new File([Uint8Array.from(${JSON.stringify([...bytes])})],${JSON.stringify('PDF '+mode+'.pdf')},{type:'application/pdf'}));
      document.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
    }`);
    await until(() => evalMain('document.querySelector("#pdf-dialog").open'), 'PDF dialog opens after drop');
    assert.match(await evalMain('document.querySelector("#pdf-name").textContent'),/2 页/);
    await evalMain('document.querySelector("#pdf-pages").value="3";document.querySelector("#pdf-pages").dispatchEvent(new Event("input",{bubbles:true}))');
    assert.equal(await evalMain('document.querySelector("#pdf-start").disabled'),true);
    await evalMain('document.querySelector("#pdf-pages").value="1-2";document.querySelector("#pdf-pages").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#pdf-mode").value='+JSON.stringify(mode)+';document.querySelector("#pdf-mode").dispatchEvent(new Event("change",{bubbles:true}))');
    assert.match(await evalMain('document.querySelector("#pdf-estimate").textContent'),mode==='files'?/0.0030/:/0.0100/);
    await evalMain('document.querySelector("#pdf-start").click()');
    await until(() => evalMain('!document.querySelector("#pdf-result").hidden && document.querySelector("#pdf-result-title").textContent.includes("三份文件已保存")'), 'PDF completion updates UI');
    assert.match(await evalMain('document.querySelector("#pdf-result-files").textContent'),/DOCX: 已保存.*MD: 已保存.*MMD: 已保存/);
    const entry=(await service.store.list()).find(i=>i.title==='PDF '+mode+'.pdf'), item=await service.store.get(entry.id);
    assert.equal(item.pdfTask.mode,mode); assert.equal(item.pdfTask.status,'completed');
    assert.equal(readFileSync(item.pdfTask.artifacts.mmd.path,'utf8'),mmd);
    assert.match(readFileSync(item.pdfTask.artifacts.md.path,'utf8'),/^# Plain Markdown/);
    await evalMain('document.querySelector("#pdf-open-folder").click()');
    await until(() => openedFolders.includes(item.pdfTask.folder), 'folder button opens the saved directory');
    await until(() => evalMain('!document.querySelector("#pdf-open-folder").disabled && document.querySelector("#toast").textContent.includes("资源管理器")'), 'folder open feedback');
  }
  failOpenFolder = true;
  await evalMain('document.querySelector("#pdf-open-folder").click()');
  await until(() => evalMain('!document.querySelector("#pdf-open-folder").disabled && document.querySelector("#toast").textContent.includes("打开文件夹失败")'), 'folder failure is visible and button recovers');
  // The deliberate HTTP 500 above is reported by Chromium as a resource error.
  assert.equal(errors.every(message => /Failed to load resource.*500/.test(message)),true);
  errors.length = 0;
  assert.equal(pdfSubmissions.length,2);
  assert.equal(pdfSubmissions[0].url.endsWith('/files/v1'),true);assert.equal(pdfSubmissions[1].url.endsWith('/v3/pdf'),true);
  assert.equal(BrowserWindow.getAllWindows().every(w => !w.isVisible()), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result:'PASS', checks:['hotkey conflict recovery','Escape cancellation without upload','close to tray','background hotkey callback','reverse drag and DPI crop','release does not submit','move and resize selection','Enter and button confirmation','reset and empty Enter','processing and automatic result UI','single OCR submission','official Word cache','fixed-directory export and open','preserve same-name files','save pending edits','error record preserved','missing key stays local','PDF drop and mode selection','page validation and cost estimates','three PDF outputs saved automatically','no visible windows'], counts }));
}
run().then(async () => { await service.pdf.close(); await service.word.close(); server.closeAllConnections(); server.close(); app.exit(0); }).catch(async error => { console.error(error.stack); await service?.pdf.close(); await service?.word.close(); server?.closeAllConnections(); server?.close(); app.exit(1); });
