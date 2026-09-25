// Exercise the actual packaged application without showing windows or calling Mathpix.
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {mkdir,mkdtemp,readFile,writeFile}=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const root=path.dirname(__dirname),executable=path.resolve(process.argv[2]||path.join(root,'dist','win-unpacked','Math Snip.exe'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child,blocker,browser;
async function connect(url){
 const socket=new WebSocket(url),pending=new Map();let serial=0;
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data),task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(new Error(message.error.message)):task.resolve(message.result);}});
 return {close:()=>socket.close(),send:(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));})};
}
async function stop(){
 if(!child)return;
 if(browser){void browser.send('Browser.close');for(let n=0;n<100&&child.exitCode===null;n++)await delay(100);browser.close();browser=null;}
 if(child.exitCode===null)try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}
 child=null;await delay(250);
}
async function run(){
 await mkdir(path.join(root,'work'),{recursive:true});const dataDir=await mkdtemp(path.join(root,'work','packaged-smoke-'));
 blocker=net.createServer();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));const occupied=blocker.address().port;
 const env={...process.env,SNIP_DATA_DIR:dataDir,SNIP_PORT:String(occupied)};delete env.MATHPIX_APP_ID;delete env.MATHPIX_APP_KEY;delete env.ELECTRON_RUN_AS_NODE;
 async function launch(){
  let logs='';child=spawn(executable,['--background','--remote-debugging-port=0'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});child.on('error',e=>{logs+=e.message;});
  for(let n=0;n<300;n++){
   if(child.exitCode!==null)throw new Error('Packaged application exited with code '+child.exitCode+' '+logs.slice(-3500));
   try{const state=JSON.parse(await readFile(path.join(dataDir,'desktop-shell','status.json'),'utf8'));if(state.pid===child.pid&&state.phase!=='stopped'){
    assert.equal(state.visible,false);assert.equal(state.installed,true);assert.notEqual(state.port,occupied);
    const base='http://127.0.0.1:'+state.port,health=await fetch(base+'/api/health').then(r=>r.json()),boot=await fetch(base+'/api/bootstrap').then(r=>r.json());
    assert.equal(health.version,require('../package.json').version);assert.equal(boot.installed,true);
    const [debugPort,debugPath]=(await readFile(path.join(dataDir,'desktop-shell','DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
    browser=await connect('ws://127.0.0.1:'+debugPort+debugPath);
    const targets=await fetch('http://127.0.0.1:'+debugPort+'/json/list').then(r=>r.json());
    const target=targets.find(t=>t.type==='page'&&t.url.startsWith(base));if(!target){browser.close();browser=null;await delay(100);continue;}
    const page=await connect(target.webSocketDebuggerUrl);
    const evaluate=async expression=>{const result=await page.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value;};
    return {base,boot,evaluate,page};
   }}catch(error){if(error.code==='ERR_ASSERTION')throw error;}
   await delay(100);
  }throw new Error('Packaged startup timed out; data directory: '+dataDir);
 }
 const first=await launch();assert.equal(first.boot.settings.configured,false);
 async function until(ctx,expression){for(let n=0;n<150;n++){if(await ctx.evaluate(expression))return;await delay(100);}throw new Error('Renderer check timed out: '+expression);}
 await until(first,'document.querySelector("#welcome-dialog")?.open');
 await first.evaluate('document.querySelector("#welcome-demo").click()');
 await until(first,'!document.querySelector("#welcome-dialog").open && localStorage.getItem("mathsnip-welcome-seen")==="1"');
 await first.evaluate('localStorage.removeItem("mathsnip-welcome-seen");location.reload()');
 await until(first,'document.querySelector("#welcome-dialog")?.open');
 await first.evaluate('document.querySelector("#welcome-configure").click()');
 await until(first,'document.querySelector("#settings-dialog").open');
 await first.evaluate('document.querySelector("#settings-dialog").close()');
 const request=(ctx,route,body)=>fetch(ctx.base+'/api'+route,{method:'POST',headers:{'x-snip-token':ctx.boot.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const html=await fetch(first.base).then(r=>r.text());assert.ok(html.includes('welcome-dialog'));
 assert.equal((await fetch(first.base+'/app.js')).status,200);assert.equal((await fetch(first.base+'/sample.svg')).status,200);
 assert.equal((await fetch(first.base+'/mask-editor.js')).status,200);assert.equal((await fetch(first.base+'/mask-editor.css')).status,200);
 const source=await first.evaluate(`(()=>{const c=document.createElement('canvas');c.width=400;c.height=240;const x=c.getContext('2d');x.fillStyle='#646464';x.fillRect(0,0,400,240);return c.toDataURL();})()`);
 assert.equal((await request(first,'/items',{kind:'image',title:'Packaged mask.png',source})).status,200);
 await first.evaluate('location.reload()');await until(first,'document.querySelector("#title")?.value==="Packaged mask.png" && !document.querySelector("#mask-open").disabled');
 await first.evaluate('document.querySelector("#mask-open").click()');await until(first,'document.querySelector("#mask-dialog").open');
 await first.evaluate(`{
  const s=document.querySelector('#mask-stage'),r=s.getBoundingClientRect();s.setPointerCapture=()=>{};
  for(const [type,x,y] of [['pointerdown',.1,.1],['pointermove',.4,.4],['pointerup',.4,.4]])s.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:r.x+r.width*x,clientY:r.y+r.height*y}));
  document.querySelector('#mask-save').click();
 }`);
 await until(first,'!document.querySelector("#mask-dialog").open && document.querySelector("#title").value==="Packaged mask-遮罩.png"');
 const maskedPixels=await first.evaluate(`(async()=>{const img=document.querySelector('#original img');await img.decode();const c=document.createElement('canvas');c.width=400;c.height=240;const x=c.getContext('2d');x.drawImage(img,0,0);return [[...x.getImageData(80,48,1,1).data],[...x.getImageData(300,200,1,1).data]];})()`);
 assert.deepEqual(maskedPixels,[[255,255,255,255],[100,100,100,255]]);
 const render=await request(first,'/render',{mmd:'中文公式 $x^2+1$'});assert.equal(render.status,200);assert.match((await render.json()).html,/mjx-container/);
 const saved=await request(first,'/settings',{appId:'fake-packaged-id',appKey:'fake-packaged-key',remember:true});assert.equal(saved.status,200);
 const encrypted=await readFile(path.join(dataDir,'credentials.safe'),'utf8');assert.ok(!encrypted.includes('fake-packaged'));
 const hotkey=await first.evaluate('window.desktopCapture.setHotkey("Ctrl+Alt+Shift+F23")');assert.equal(hotkey.hotkey,'Ctrl+Alt+Shift+F23');
 const outputDirectory=path.join(dataDir,'custom exports');
 assert.equal((await request(first,'/preferences',{outputDirectory,autoOpenWord:false})).status,200);
 await writeFile(path.join(outputDirectory,'old.docx'),'packaged-local-file');
 const imported=await (await request(first,'/items',{kind:'text',title:'Packaged favorite'})).json();
 assert.equal((await fetch(first.base+'/api/items/'+imported.id+'/favorite',{method:'PATCH',headers:{'x-snip-token':first.boot.token,'Content-Type':'application/json'},body:JSON.stringify({favorite:true})})).status,200);
 const files=await fetch(first.base+'/api/local-files',{headers:{'x-snip-token':first.boot.token}}).then(r=>r.json());
 const local=files.files.find(file=>file.name==='old.docx');assert.ok(local);
 assert.equal((await request(first,'/local-files/'+local.id+'/rename',{name:'renamed'})).status,200);
 assert.equal(await readFile(path.join(outputDirectory,'renamed.docx'),'utf8'),'packaged-local-file');
 first.page.close();await stop();const second=await launch();assert.equal(second.boot.settings.configured,true,'Saved credentials must load after a normal exit');assert.equal(second.boot.settings.remember,true);assert.equal(second.boot.settings.appId,'fake-packaged-id');
 assert.equal(second.boot.preferences.outputDirectory,outputDirectory);assert.equal(second.boot.preferences.autoOpenWord,false);
 const restored=await fetch(second.base+'/api/items/'+imported.id,{headers:{'x-snip-token':second.boot.token}}).then(r=>r.json());assert.equal(restored.favorite,true);
 await until(second,'!!window.desktopCapture');const desktop=await second.evaluate('window.desktopCapture.getState()');assert.equal(desktop.hotkey,'Ctrl+Alt+Shift+F23');assert.equal(desktop.registered,true);
 await until(second,'document.querySelector("#mode")?.textContent.includes("API 已配置")');assert.equal(await second.evaluate('document.querySelector("#welcome-dialog").open'),false);second.page.close();
 await stop();blocker.close();blocker=null;
 console.log(JSON.stringify({result:'PASS',checks:['standalone executable','hidden startup','port collision fallback','built frontend and SVG','math rendering in ASAR','first-run demo and settings actions','native encrypted credentials survive restart','custom shortcut re-registers after restart','export preferences and favorites survive restart','local file rename in ASAR','no Mathpix requests'],dataDir}));
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await stop();blocker?.close();});
