function pixelRect(rect, size) {
  if (!rect || !['x','y','w','h'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key])) || rect.w <= 0 || rect.h <= 0)
    throw new Error('截图选区无效，请重新框选。');
  const clamp = value => Math.max(0, Math.min(1, value));
  const x = Math.round(clamp(rect.x) * size.width), y = Math.round(clamp(rect.y) * size.height);
  const right = Math.round(clamp(rect.x + rect.w) * size.width), bottom = Math.round(clamp(rect.y + rect.h) * size.height);
  if (right - x < 2 || bottom - y < 2) throw new Error('截图区域太小，请重新框选。');
  return { x, y, width: right - x, height: bottom - y };
}
async function processCapture({ source, configured, api, report }) {
  const item = await api('/items', 'POST', { kind: 'image', source, title: '快捷键截图 ' + new Date().toLocaleString('zh-CN').replace(/[/:]/g, '-') });
  if (!configured) {
    report({ itemId: item.id, phase: 'needs-key', busy: false, detail: '截图已保存在本机。请配置 API 后点击“开始识别”。' });
    return;
  }
  report({ itemId: item.id, phase: 'processing', busy: true, detail: '正在自动识别截图…' });
  try {
    await api('/recognize/' + item.id, 'POST', {});
    report({ itemId: item.id, phase: 'completed', busy: false, detail: '识别完成，正在准备官方 Word。' });
  } catch (error) { report({ itemId: item.id, phase: 'error', busy: false, detail: error.message }); }
}
function maskBitmap(bitmap,crop,size,masks=[]) {
  if(!Array.isArray(masks)||masks.length>100)throw new Error('遮罩数量无效，最多支持 100 个。');
  if(bitmap.length!==crop.width*crop.height*4)throw new Error('截图像素尺寸不匹配。');
  for(const m of masks){
    if(!m||!['white','black'].includes(m.color)||!['x','y','w','h'].every(key=>typeof m[key]==='number'&&Number.isFinite(m[key]))||m.w<=0||m.h<=0)throw new Error('遮罩数据无效，请重新截图。');
    const left=Math.max(0,Math.floor(m.x*size.width)-crop.x),top=Math.max(0,Math.floor(m.y*size.height)-crop.y);
    const right=Math.min(crop.width,Math.ceil((m.x+m.w)*size.width)-crop.x),bottom=Math.min(crop.height,Math.ceil((m.y+m.h)*size.height)-crop.y);
    const color=m.color==='white'?255:0;
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){const offset=(y*crop.width+x)*4;bitmap[offset]=bitmap[offset+1]=bitmap[offset+2]=color;bitmap[offset+3]=255;}
  }
  return bitmap;
}
module.exports = { pixelRect, processCapture, maskBitmap };
