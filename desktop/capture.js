const frame=document.querySelector('#frame'),selection=document.querySelector('#selection'),shade=document.querySelector('#shade'),tip=document.querySelector('#tip'),actions=document.querySelector('#actions');
let drag=null,rect=null,submitted=false,ready=false;
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const point=e=>({x:clamp(e.clientX,0,innerWidth),y:clamp(e.clientY,0,innerHeight)});
const valid=()=>rect&&rect.w>=6&&rect.h>=6;
window.captureOverlay.onFrame(async({dataUrl})=>{frame.src=dataUrl;await frame.decode();ready=true;document.body.dataset.ready='true';window.captureOverlay.ready();});
function draw(){
  selection.hidden=!rect;shade.hidden=!!rect;tip.hidden=!!drag;
  if(rect)Object.assign(selection.style,{left:rect.x+'px',top:rect.y+'px',width:rect.w+'px',height:rect.h+'px'});
  actions.hidden=!valid()||!!drag;
  if(!actions.hidden){
    document.querySelector('#dimensions').textContent=Math.round(rect.w*frame.naturalWidth/innerWidth)+' × '+Math.round(rect.h*frame.naturalHeight/innerHeight);
    const width=actions.offsetWidth,height=actions.offsetHeight;
    const top=rect.y+rect.h+12+height<innerHeight?rect.y+rect.h+12:rect.y-height-12>=0?rect.y-height-12:innerHeight-height-12;
    Object.assign(actions.style,{left:clamp(rect.x+rect.w-width,8,Math.max(8,innerWidth-width-8))+'px',top:clamp(top,8,innerHeight-height-8)+'px'});
  }
}
function confirm(){
  if(!ready||submitted||drag||!valid())return;
  submitted=true;document.querySelector('#confirm').disabled=true;
  window.captureOverlay.select({x:rect.x/innerWidth,y:rect.y/innerHeight,w:rect.w/innerWidth,h:rect.h/innerHeight});
}
function reset(){if(submitted)return;drag=null;rect=null;draw();}
document.querySelector('#confirm').addEventListener('click',confirm);
document.querySelector('#reset').addEventListener('click',reset);
document.querySelector('#cancel').addEventListener('click',()=>window.captureOverlay.cancel());
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();window.captureOverlay.cancel();}
  if(e.key==='Enter'){e.preventDefault();confirm();}
  if(rect&&!drag&&!submitted&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    e.preventDefault();const n=e.shiftKey?10:1;
    rect.x=clamp(rect.x+(e.key==='ArrowLeft'?-n:e.key==='ArrowRight'?n:0),0,innerWidth-rect.w);
    rect.y=clamp(rect.y+(e.key==='ArrowUp'?-n:e.key==='ArrowDown'?n:0),0,innerHeight-rect.h);draw();
  }
});
document.addEventListener('contextmenu',e=>{e.preventDefault();window.captureOverlay.cancel();});
function hit(p){
  if(!rect)return '';
  const l=Math.abs(p.x-rect.x)<8,r=Math.abs(p.x-rect.x-rect.w)<8,t=Math.abs(p.y-rect.y)<8,b=Math.abs(p.y-rect.y-rect.h)<8;
  if(p.x<rect.x-8||p.x>rect.x+rect.w+8||p.y<rect.y-8||p.y>rect.y+rect.h+8)return '';
  return (t?'n':b?'s':'')+(l?'w':r?'e':'')||'move';
}
document.addEventListener('pointerdown',e=>{
  if(e.button!==0||submitted||drag||!ready||e.target.closest('#actions'))return;
  e.preventDefault();const start=point(e),mode=e.target.dataset.edge||hit(start)||'new';
  drag={start,mode,original:rect?{...rect}:null,pointer:e.pointerId};
  document.body.setPointerCapture(e.pointerId);if(mode==='new')rect={x:start.x,y:start.y,w:0,h:0};draw();
});
function move(e){
  if(!drag||e.pointerId!==drag.pointer||submitted)return;
  const p=point(e),{start,mode,original:o}=drag;
  if(mode==='new')rect={x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)};
  else if(mode==='move')rect={...o,x:clamp(o.x+p.x-start.x,0,innerWidth-o.w),y:clamp(o.y+p.y-start.y,0,innerHeight-o.h)};
  else{
    let l=o.x,r=o.x+o.w,t=o.y,b=o.y+o.h;
    if(mode.includes('w'))l=p.x;if(mode.includes('e'))r=p.x;if(mode.includes('n'))t=p.y;if(mode.includes('s'))b=p.y;
    rect={x:Math.min(l,r),y:Math.min(t,b),w:Math.abs(r-l),h:Math.abs(b-t)};
  }draw();
}
document.addEventListener('pointermove',move);
document.addEventListener('pointerup',e=>{
  if(!drag||e.pointerId!==drag.pointer||e.button!==0)return;
  move(e);const previous=drag.original;drag=null;
  if(!valid())rect=previous;
  if(document.body.hasPointerCapture(e.pointerId))document.body.releasePointerCapture(e.pointerId);draw();
});
function cancelDrag(e){if(!drag||e.pointerId!==drag.pointer)return;rect=drag.original;drag=null;draw();}
document.addEventListener('pointercancel',cancelDrag);document.addEventListener('lostpointercapture',cancelDrag);
