// Reading order for a simple board: rows from top to bottom, text/math runs left to right.
export function planInk(strokes,texts=[]) {
  if(!texts.length)return strokes.x.length?[[{kind:'math',strokes}]]:[];
  const elements=strokes.x.map((xs,i)=>({kind:'stroke',index:i,x:Math.min(...xs),right:Math.max(...xs),y:Math.min(...strokes.y[i]),bottom:Math.max(...strokes.y[i])}));
  elements.push(...texts.map(t=>({...t,kind:'text',right:t.x+t.width,bottom:t.y+(t.fontSize||28)+8})));
  elements.sort((a,b)=>a.y-b.y||a.x-b.x);
  const rows=[];
  for(const item of elements){
    // A small vertical tolerance keeps dots and superscripts with their formula.
    let row=rows.find(r=>item.y<=r.bottom+14&&item.bottom>=r.y-14);
    if(!row){row={y:item.y,bottom:item.bottom,items:[]};rows.push(row);}
    row.y=Math.min(row.y,item.y);row.bottom=Math.max(row.bottom,item.bottom);row.items.push(item);
  }
  return rows.sort((a,b)=>a.y-b.y).map(row=>{
    row.items.sort((a,b)=>a.x-b.x||a.y-b.y);
    const runs=[];let pending=[];
    const flush=()=>{if(!pending.length)return;pending.sort((a,b)=>a.index-b.index);runs.push({kind:'math',strokes:{x:pending.map(s=>strokes.x[s.index]),y:pending.map(s=>strokes.y[s.index])}});pending=[];};
    for(const item of row.items){if(item.kind==='text'){flush();runs.push({kind:'text',text:item.text});}else pending.push(item);}flush();return runs;
  });
}
export function literalMarkdown(text){return text.replace(/[\\`*_{}\[\]()#+.!|><$-]/g,'\\$&');}
