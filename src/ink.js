import DOMPurify from 'dompurify';
const textSize=t=>t.fontSize||28;
const textHeight=t=>textSize(t)+8;

export function paintStrokes(canvas,strokes,texts=[]) {
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle='#213e34';ctx.fillStyle='#213e34';ctx.lineWidth=3.4;ctx.lineCap='round';ctx.lineJoin='round';
  for(const stroke of strokes) {
    if(!stroke.length) continue;
    ctx.beginPath();ctx.moveTo(...stroke[0]);for(const point of stroke.slice(1)) ctx.lineTo(...point);ctx.stroke();
    if(stroke.length===1) {ctx.beginPath();ctx.arc(...stroke[0],1.7,0,Math.PI*2);ctx.fill();}
  }
  ctx.textBaseline='top';
  for(const text of texts){ctx.font=textSize(text)+'px "Microsoft YaHei",sans-serif';ctx.fillText(text.text,text.x+4,text.y+4);}
}

// Render only the user's strokes and text on white, preserving their 2D layout.
// The grid, selection borders and text editing controls are never uploaded.
export function inkLayoutImage(strokes,texts) {
  const full=document.createElement('canvas');full.width=2400;full.height=900;
  const ctx=full.getContext('2d');ctx.scale(2,2);paintStrokes(full,strokes,texts);
  ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fff';ctx.fillRect(0,0,1200,450);
  const bounds=[...strokes.flat().map(([x,y])=>({x,y,right:x,bottom:y})),...texts.map(t=>({x:t.x,y:t.y,right:t.x+t.width,bottom:t.y+textHeight(t)}))];
  const x=Math.max(0,Math.floor(Math.min(...bounds.map(b=>b.x))-20)),y=Math.max(0,Math.floor(Math.min(...bounds.map(b=>b.y))-20));
  const right=Math.min(1200,Math.ceil(Math.max(...bounds.map(b=>b.right))+20)),bottom=Math.min(450,Math.ceil(Math.max(...bounds.map(b=>b.bottom))+20));
  const image=document.createElement('canvas');image.width=(right-x)*2;image.height=(bottom-y)*2;
  image.getContext('2d').drawImage(full,x*2,y*2,image.width,image.height,0,0,image.width,image.height);
  return image.toDataURL('image/png');
}

export function initInk({api,copy,saveCurrent,openItem}) {
  const $=s=>document.querySelector(s),dialog=$('#ink-dialog'),canvas=$('#ink-canvas');
  let strokes=[],active=null,pointer=null,result=null,resultKey='',attempt=null,busy=false,timer,renderId=0,failed=false;
  let texts=[],tool='pen',textDrag=null;const undoStack=[];
  const cache=new Map();
  const cleanTexts=()=>texts.filter(t=>t.text.trim()).map(({text,x,y,width,fontSize})=>({text,x,y,width,...(fontSize&&fontSize!==28?{fontSize}:{})}));
  const key=()=>JSON.stringify(cleanTexts().length?{strokes,texts:cleanTexts(),layoutVersion:2}:strokes);
  const coordinates=()=>({x:strokes.map(s=>s.map(p=>p[0])),y:strokes.map(s=>s.map(p=>p[1]))});
  const hasContent=()=>strokes.length||cleanTexts().length;
  const remember=()=>{undoStack.push(JSON.stringify({strokes,texts}));if(undoStack.length>30)undoStack.shift();};
  const status=(message,error=false)=>{ $('#ink-status').textContent=message;$('#ink-status').classList.toggle('error',error); };
  try {
    const draft=JSON.parse(localStorage.getItem('mathsnip-ink-draft')||'null');
    if(Array.isArray(draft?.strokes) && draft.strokes.length<=500 && draft.strokes.flat().length<=20000 && draft.strokes.every(s=>Array.isArray(s)&&s.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&v>=0&&v<=1200)))) {
      strokes=draft.strokes;result=draft.result;resultKey=draft.resultKey||'';attempt=draft.attempt;
      if(Array.isArray(draft.texts)&&draft.texts.length<=20&&draft.texts.every(t=>typeof t.text==='string'&&t.text.length<=200&&[t.x,t.y,t.width].every(Number.isFinite)&&t.x>=0&&t.x<=1200&&t.y>=0&&t.y<=450-textHeight(t)&&t.width>=30&&t.width<=1200&&Number.isInteger(t.fontSize??28)&&(t.fontSize??28)>=12&&(t.fontSize??28)<=96))texts=draft.texts.map(t=>({...t,id:crypto.randomUUID()}));
      if(result && resultKey===key()) cache.set(resultKey,result);
    }
  } catch {}
  function persist() { try {localStorage.setItem('mathsnip-ink-draft',JSON.stringify({strokes,texts,result,resultKey,attempt}));} catch {status('草稿暂时无法保存到本机，请先保存识别结果。',true);} }
  function controls() {
    const current=result && resultKey===key() && !active;
    $('#ink-recognize').disabled=busy || !hasContent() || !!active || !!textDrag;
    $('#ink-recognize').textContent=busy?'正在识别…':failed?'重试识别':'识别公式';
    $('#ink-copy').disabled=!current;$('#ink-save').disabled=!current;
    $('#ink-copy').textContent=result?.latex?'复制 LaTeX':'复制识别文本';
    $('#ink-undo').disabled=(!undoStack.length&&!strokes.length) || !!active;$('#ink-clear').disabled=(!strokes.length&&!texts.length) || !!active;
    $('#ink-count').textContent=strokes.length+' 笔'+(texts.length?' · '+texts.length+' 个文字框':'');
    $('#ink-group-count').textContent=strokes.length?(cleanTexts().length?'文字与笔迹按当前排布一起识别；修改文字、字号或位置需要重新识别。':'纯手写使用笔迹识别，未改动的内容会复用。'):'仅输入文字时本地整理，无需调用识别接口。';
  }
  async function present(value,fingerprint) {
    result=value;resultKey=fingerprint;$('#ink-source').value=value.latex||value.mmd;controls();persist();
    const seq=++renderId;
    try {
      const {html}=await api('/render',{method:'POST',body:{mmd:value.mmd}});
      if(seq!==renderId || key()!==fingerprint) return;
      $('#ink-preview').innerHTML=DOMPurify.sanitize(html,{ADD_TAGS:['mjx-container','mjx-assistive-mml','latex','mathml'],ADD_ATTR:['jax','overflow','focusable','xmlns:xlink'],FORBID_TAGS:['style','iframe','object','embed','script']});
    } catch(e) { if(seq===renderId) $('#ink-preview').textContent='预览失败，仍可复制源码：'+e.message; }
  }
  function schedule() {clearTimeout(timer);if($('#ink-auto').checked && dialog.open && hasContent() && !active && !textDrag && !document.activeElement?.matches('.ink-text input')) timer=setTimeout(()=>recognize(false),1500);}
  function changed(redrawTexts=true) {
    ++renderId;failed=false;attempt=null;result=null;resultKey='';$('#ink-source').value='';$('#ink-preview').textContent='识别结果将在这里显示';
    status(hasContent()?'内容已更新，可点击识别。':'在画板书写，或选择“文字”后点击插入位置。');
    paintStrokes(canvas,strokes);if(redrawTexts)drawTexts();controls();persist();schedule();
  }
  function setTool(value){tool=value;$('#ink-pen-tool').classList.toggle('active',value==='pen');$('#ink-text-tool').classList.toggle('active',value==='text');canvas.style.cursor=value==='text'?'text':'crosshair';}
  function drawTexts(){
    const layer=$('#ink-text-layer');layer.replaceChildren();const scale=canvas.getBoundingClientRect().width/1200;
    for(const text of texts){
      const box=document.createElement('div');box.className='ink-text';box.dataset.id=text.id;
      const place=()=>Object.assign(box.style,{left:text.x/12+'%',top:text.y/4.5+'%',width:text.width/12+'%',fontSize:textSize(text)*scale+'px',height:textHeight(text)*scale+'px'});place();
      const grip=document.createElement('button');grip.className='ink-text-grip';grip.textContent='拖动';grip.setAttribute('aria-label','拖动文字框');
      const input=document.createElement('input');input.className='ink-text-content';input.value=text.text;input.maxLength=200;input.placeholder='输入汉字';input.setAttribute('aria-label','文字框内容');
      const remove=document.createElement('button');remove.className='ink-text-delete';remove.textContent='×';remove.setAttribute('aria-label','删除文字框');
      const sizeLabel=document.createElement('label');sizeLabel.className='ink-text-size-label';sizeLabel.textContent='字号';
      const size=document.createElement('input');size.type='number';size.className='ink-text-size';size.min='12';size.max='96';size.step='1';size.value=textSize(text);size.setAttribute('aria-label','文字字号');sizeLabel.append(size);
      const fit=()=>{const ctx=canvas.getContext('2d');ctx.font=textSize(text)+'px "Microsoft YaHei",sans-serif';text.width=Math.min(1200,Math.max(60,ctx.measureText(text.text||'输入汉字').width+16));text.x=Math.min(text.x,1200-text.width);text.y=Math.min(text.y,450-textHeight(text));place();};
      size.addEventListener('focus',()=>clearTimeout(timer));
      size.addEventListener('change',()=>{const value=Number(size.value);if(!Number.isInteger(value)||value<12||value>96){size.value=textSize(text);return status('字号范围为 12–96。',true);}if(value!==textSize(text)){remember();text.fontSize=value;fit();changed(false);}});
      size.addEventListener('blur',()=>{size.value=textSize(text);persist();schedule();});
      let editing=false;
      input.addEventListener('input',()=>{
        if(!editing){remember();editing=true;}text.text=input.value;
        fit();changed(false);
      });
      input.addEventListener('focus',()=>clearTimeout(timer));
      input.addEventListener('blur',()=>{editing=false;persist();schedule();});
      input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();input.blur();}});
      remove.addEventListener('click',()=>{remember();texts=texts.filter(t=>t!==text);changed();});
      grip.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();remember();clearTimeout(timer);textDrag={text,start:point(e),x:text.x,y:text.y,pointer:e.pointerId,place};grip.setPointerCapture(e.pointerId);controls();});
      const actions=document.createElement('div');actions.className='ink-text-actions';actions.append(grip,sizeLabel,remove);box.append(input,actions);layer.append(box);
    }
  }
  function point(e) {const r=canvas.getBoundingClientRect();return [Math.max(0,Math.min(1200,(e.clientX-r.left)*1200/r.width)),Math.max(0,Math.min(450,(e.clientY-r.top)*450/r.height))];}
  function addPoint(e) {
    if(strokes.reduce((n,s)=>n+s.length,0)>=20000) return;
    active.push(point(e));
  }
  canvas.addEventListener('pointerdown',e=>{
    if(active || (e.pointerType==='mouse' && e.button!==0) || e.button===5) return;
    if(tool==='text'){
      if(texts.length>=20)return status('最多插入 20 个文字框。',true);
      e.preventDefault();remember();const [x,y]=point(e),id=crypto.randomUUID();texts.push({id,text:'',x:Math.min(x,1040),y:Math.min(y,414),width:160});changed();$('#ink-text-layer').lastElementChild.querySelector('input').focus();return;
    }
    if(strokes.length>=500) return status('最多支持 500 笔，请分成几个公式。',true);
    e.preventDefault();clearTimeout(timer);remember();active=[];pointer=e.pointerId;strokes.push(active);addPoint(e);
    canvas.setPointerCapture(e.pointerId);changed();
  });
  canvas.addEventListener('pointermove',e=>{
    if(!active || e.pointerId!==pointer) return;e.preventDefault();
    const samples=e.getCoalescedEvents?.();for(const sample of samples?.length?samples:[e]) addPoint(sample);
    paintStrokes(canvas,strokes);
  });
  function end(e,cancelled=false) {
    if(!active || e.pointerId!==pointer) return;
    if(cancelled){strokes.pop();undoStack.pop();}else addPoint(e);
    active=null;pointer=null;if(canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    changed();
  }
  canvas.addEventListener('pointerup',e=>end(e));canvas.addEventListener('pointercancel',e=>end(e,true));
  canvas.addEventListener('lostpointercapture',e=>end(e,true));
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  document.addEventListener('pointermove',e=>{
    if(!textDrag||e.pointerId!==textDrag.pointer)return;e.preventDefault();const [x,y]=point(e),d=textDrag;
    d.text.x=Math.max(0,Math.min(1200-d.text.width,d.x+x-d.start[0]));d.text.y=Math.max(0,Math.min(450-textHeight(d.text),d.y+y-d.start[1]));d.place();
  });
  const stopDrag=e=>{if(!textDrag||e.pointerId!==textDrag.pointer)return;if(e.type!=='pointerup'){textDrag.text.x=textDrag.x;textDrag.text.y=textDrag.y;undoStack.pop();}textDrag=null;changed();};
  document.addEventListener('pointerup',stopDrag);document.addEventListener('pointercancel',stopDrag);document.addEventListener('lostpointercapture',stopDrag);
  async function recognize(manual=true) {
    clearTimeout(timer);if(busy || active || textDrag || !hasContent() || !dialog.open) return;
    const fingerprint=key();
    if(cache.has(fingerprint)) {await present(cache.get(fingerprint),fingerprint);status('已复用相同画板的结果，没有再次调用识别。');return;}
    if(!attempt || attempt.key!==fingerprint || (manual&&failed)) attempt={id:crypto.randomUUID(),key:fingerprint};
    const request={id:attempt.id,...coordinates(),texts:cleanTexts()};
    const mixed=strokes.length&&request.texts.length;
    if(mixed)request.layoutImage=inkLayoutImage(strokes,request.texts);
    busy=true;failed=false;persist();controls();status(mixed?'正在按画板排布识别文字和笔迹…':strokes.length?'正在识别手写内容…':'正在整理文字…');
    try {
      if(mixed&&(await api('/health')).inkLayout!==2)throw new Error('后台版本较旧，请从托盘退出 Math Snip，再双击桌面快捷方式启动。');
      const value=await api('/ink/recognize',{method:'POST',body:request});
      cache.set(fingerprint,value);if(cache.size>40) cache.delete(cache.keys().next().value);
      if(key()===fingerprint && !active) {await present(value,fingerprint);status('识别完成，可复制或保存到历史。');}
    } catch(e) {
      $('#ink-auto').checked=false;failed=true;status(e.message+' 自动识别已暂停；手动重试会发起新请求。',true);
    } finally {busy=false;controls();if(key()!==fingerprint) schedule();}
  }
  $('#open-ink').addEventListener('click',async()=>{
    try {await saveCurrent();dialog.showModal();paintStrokes(canvas,strokes);drawTexts();controls();if(result&&resultKey===key()) await present(result,resultKey);}
    catch(e) {status(e.message,true);}
  });
  $('#ink-recognize').addEventListener('click',()=>recognize());
  $('#ink-auto').addEventListener('change',()=>{if($('#ink-auto').checked) schedule();else clearTimeout(timer);});
  $('#ink-pen-tool').addEventListener('click',()=>setTool('pen'));
  $('#ink-text-tool').addEventListener('click',()=>{setTool('text');status('点击画板上的位置输入文字；文字框上方可调整字号和拖动位置。');});
  $('#ink-undo').addEventListener('click',()=>{if(!active){if(undoStack.length){const previous=JSON.parse(undoStack.pop());strokes=previous.strokes;texts=previous.texts;}else strokes.pop();changed();}});
  $('#ink-clear').addEventListener('click',()=>{if(!active){remember();strokes=[];texts=[];changed();}});
  $('#ink-copy').addEventListener('click',async()=>{
    try {await copy(result?.latex || result?.mmd);status('已复制到剪贴板。');} catch(e){status(e.message,true);}
  });
  $('#ink-save').addEventListener('click',async()=>{
    const saved=result;if(!saved || resultKey!==key()) return;$('#ink-save').disabled=true;
    try {const item=await api('/ink/'+saved.id+'/save',{method:'POST',body:{}});await openItem(item);dialog.close();}
    catch(e){status(e.message,true);} finally {controls();}
  });
  dialog.addEventListener('close',()=>{
    clearTimeout(timer);$('#ink-auto').checked=false;
    if(active) {strokes.pop();undoStack.pop();active=null;pointer=null;changed();}if(textDrag){textDrag=null;changed();}persist();
  });
  new ResizeObserver(()=>{if(dialog.open&&!textDrag&&!document.activeElement?.matches('.ink-text input'))drawTexts();}).observe(canvas);
  paintStrokes(canvas,strokes);controls();
}
