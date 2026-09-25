const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const copy=value=>JSON.parse(JSON.stringify(value));

// Coordinates remain relative to the original image, even if its preview or
// screenshot selection changes size. Decoration is never part of the output.
export class MaskEditor {
  constructor({surface,layer,bounds=()=>({x:0,y:0,w:1,h:1}),enabled=()=>true,changed=()=>{}}) {
    Object.assign(this,{surface,layer,bounds,enabled,changed});
    this.masks=[];this.history=[];this.selected=-1;this.tool='off';this.drag=null;
    surface.addEventListener('pointerdown',e=>this.down(e));
    surface.addEventListener('pointermove',e=>this.move(e));
    surface.addEventListener('pointerup',e=>this.up(e));
    surface.addEventListener('pointercancel',e=>this.cancel(e));
    surface.addEventListener('lostpointercapture',e=>this.cancel(e));
    document.addEventListener('keydown',e=>this.key(e));
  }
  get active(){return this.tool!=='off'&&this.enabled();}
  point(e){const r=this.surface.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height};}
  limited(p,b){return{x:clamp(p.x,b.x,b.x+b.w),y:clamp(p.y,b.y,b.y+b.h)};}
  snapshot(){return{masks:copy(this.masks),selected:this.selected};}
  restore(snapshot){this.masks=copy(snapshot.masks);this.selected=snapshot.selected;}
  remember(snapshot){this.history.push(snapshot);if(this.history.length>100)this.history.shift();}
  setTool(tool){if(this.drag)return;this.tool=tool;this.selected=-1;this.render();this.changed();}
  reset(){this.drag=null;this.masks=[];this.history=[];this.selected=-1;this.render();this.changed();}
  undo(){if(this.drag||!this.history.length)return;this.restore(this.history.pop());this.render();this.changed();}
  remove(){if(this.drag||this.selected<0)return;this.remember(this.snapshot());this.masks.splice(this.selected,1);this.selected=-1;this.render();this.changed();}
  clear(){if(this.drag||!this.masks.length)return;this.remember(this.snapshot());this.masks=[];this.selected=-1;this.render();this.changed();}
  render(){
    const b=this.bounds();this.layer.replaceChildren();this.layer.dataset.active=String(this.active);
    this.layer.style.clipPath=b?`inset(${b.y*100}% ${(1-b.x-b.w)*100}% ${(1-b.y-b.h)*100}% ${b.x*100}%)`:'inset(100%)';
    this.masks.forEach((mask,index)=>{
      const node=document.createElement('div');node.className='mask-block';node.dataset.mask=String(index);node.style.background=mask.color;
      Object.assign(node.style,{left:mask.x*100+'%',top:mask.y*100+'%',width:mask.w*100+'%',height:mask.h*100+'%'});
      if(this.active&&index===this.selected){node.classList.add('selected');for(const edge of ['nw','n','ne','e','se','s','sw','w']){const handle=document.createElement('span');handle.className='mask-handle';handle.dataset.maskEdge=edge;node.append(handle);}}
      this.layer.append(node);
    });
  }
  down(e){
    if(!this.active||e.button!==0||this.drag||e.target.closest('button,input,select,textarea'))return;
    e.preventDefault();e.stopPropagation();const b=this.bounds();if(!b)return;
    let p=this.point(e);if(p.x<b.x||p.y<b.y||p.x>b.x+b.w||p.y>b.y+b.h)return;
    const before=this.snapshot(),node=e.target.closest('[data-mask]');let index=node?Number(node.dataset.mask):-1;
    if(index<0)for(let n=this.masks.length-1;n>=0;n--){const m=this.masks[n];if(p.x>=m.x&&p.y>=m.y&&p.x<=m.x+m.w&&p.y<=m.y+m.h){index=n;break;}}
    const mode=index<0?'new':e.target.dataset.maskEdge||'move';
    if(index<0){if(this.masks.length>=100)return;index=this.masks.length;this.masks.push({...p,w:0,h:0,color:this.tool});}
    this.selected=index;this.drag={pointer:e.pointerId,start:p,bounds:b,before,mode,original:{...this.masks[index]}};
    try{this.surface.setPointerCapture(e.pointerId);}catch{}
    this.render();this.changed();
  }
  move(e){
    const d=this.drag;if(!d||d.pointer!==e.pointerId)return;e.preventDefault();e.stopPropagation();
    const p=this.limited(this.point(e),d.bounds),o=d.original,b=d.bounds;let next;
    if(d.mode==='new')next={x:Math.min(d.start.x,p.x),y:Math.min(d.start.y,p.y),w:Math.abs(p.x-d.start.x),h:Math.abs(p.y-d.start.y),color:o.color};
    else if(d.mode==='move')next={...o,x:clamp(o.x+p.x-d.start.x,b.x,Math.max(b.x,b.x+b.w-o.w)),y:clamp(o.y+p.y-d.start.y,b.y,Math.max(b.y,b.y+b.h-o.h))};
    else{let l=o.x,r=o.x+o.w,t=o.y,bottom=o.y+o.h;if(d.mode.includes('w'))l=p.x;if(d.mode.includes('e'))r=p.x;if(d.mode.includes('n'))t=p.y;if(d.mode.includes('s'))bottom=p.y;next={x:Math.min(l,r),y:Math.min(t,bottom),w:Math.abs(r-l),h:Math.abs(bottom-t),color:o.color};}
    this.masks[this.selected]=next;this.render();
  }
  up(e){
    if(!this.drag||e.pointerId!==this.drag.pointer||e.button!==0)return;
    this.move(e);const d=this.drag,m=this.masks[this.selected],r=this.surface.getBoundingClientRect();this.drag=null;
    if(m.w*r.width<2||m.h*r.height<2)this.restore(d.before);
    else if(JSON.stringify(d.before.masks)!==JSON.stringify(this.masks))this.remember(d.before);
    if(this.surface.hasPointerCapture(e.pointerId))this.surface.releasePointerCapture(e.pointerId);this.render();this.changed();
  }
  cancel(e){if(!this.drag||e.pointerId!==this.drag.pointer)return;this.restore(this.drag.before);this.drag=null;this.render();this.changed();}
  key(e){
    if(!this.active||this.drag||e.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.stopImmediatePropagation();this.undo();}
    else if(['Delete','Backspace'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();this.remove();}
    else if(this.selected>=0&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
      e.preventDefault();e.stopImmediatePropagation();const b=this.bounds(),r=this.surface.getBoundingClientRect(),m=this.masks[this.selected],n=e.shiftKey?10:1;this.remember(this.snapshot());
      m.x=clamp(m.x+(e.key==='ArrowLeft'?-n:e.key==='ArrowRight'?n:0)/r.width,b.x,Math.max(b.x,b.x+b.w-m.w));m.y=clamp(m.y+(e.key==='ArrowUp'?-n:e.key==='ArrowDown'?n:0)/r.height,b.y,Math.max(b.y,b.y+b.h-m.h));this.render();this.changed();
    }
  }
}

export function paintMasks(context,masks,width,height){
  for(const mask of masks){const x=Math.floor(mask.x*width),y=Math.floor(mask.y*height),right=Math.ceil((mask.x+mask.w)*width),bottom=Math.ceil((mask.y+mask.h)*height);context.fillStyle=mask.color;context.fillRect(x,y,right-x,bottom-y);}
}
