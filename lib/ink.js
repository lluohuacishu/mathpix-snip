import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, MAX_IMAGE_UPLOAD_BYTES } from './mathpix.js';
import { atomicWrite } from './files.js';
import { planInk, literalMarkdown } from './ink-layout.js';

export function validateStrokes({x,y} = {},allowEmpty=false) {
  if (!Array.isArray(x) || !Array.isArray(y) || (!allowEmpty&&!x.length) || x.length !== y.length || x.length > 500) throw new ApiError('请先在画板中写一个公式，最多支持 500 笔。');
  let count = 0;
  for (let i=0;i<x.length;i++) {
    if (!Array.isArray(x[i]) || !Array.isArray(y[i]) || !x[i].length || x[i].length !== y[i].length) throw new ApiError('笔迹坐标不完整，请重新书写。');
    count += x[i].length;
    if (count > 20000 || [...x[i],...y[i]].some(n => !Number.isFinite(n) || n < 0 || n > 10000)) throw new ApiError('笔迹过多或坐标无效，请分成几个公式识别。');
  }
  return {x,y};
}
function validateTexts(texts=[]) {
  if(!Array.isArray(texts)||texts.length>20)throw new ApiError('最多插入 20 个文字框。');
  return texts.map(t=>{
    if(!t||typeof t.text!=='string'||!t.text.trim()||t.text.length>200||/[\r\n\x00-\x08]/.test(t.text)||!Number.isFinite(t.x)||!Number.isFinite(t.y)||t.x<0||t.x>1200||t.y<0||t.y>450-((t.fontSize??28)+8)||!Number.isFinite(t.width)||t.width<30||t.width>1200||!Number.isInteger(t.fontSize??28)||(t.fontSize??28)<12||(t.fontSize??28)>96)throw new ApiError('文字框内容或位置无效，每框最多 200 字。');
    return {text:t.text,x:t.x,y:t.y,width:t.width,...(t.fontSize&&t.fontSize!==28?{fontSize:t.fontSize}:{})};
  });
}

function validateLayoutImage(value) {
  if(typeof value!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw new ApiError('画板图像无效，请刷新页面后重新识别。');
  if(value.length>MAX_IMAGE_UPLOAD_BYTES*4/3+64)throw new ApiError('画板图像过大，请减少内容后识别。',413);
  const bytes=Buffer.from(value.slice(22),'base64');
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)<1||bytes.readUInt32BE(16)>2400||bytes.readUInt32BE(20)<1||bytes.readUInt32BE(20)>900)throw new ApiError('画板图像尺寸无效，请刷新页面后重新识别。');
  return value;
}

export class InkRecognition {
  constructor({store,client}) { this.store=store; this.client=client; this.jobs=new Map();this.groups=new Map(); }
  file(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new ApiError('无效的手写请求编号。');
    return path.join(this.store.root,'ink-requests',id+'.json');
  }
  async read(id) { try { return JSON.parse(await readFile(this.file(id),'utf8')); } catch(e) { if(e.code==='ENOENT') return null; throw e; } }
  async recognize(body) {
    const file=this.file(body.id), texts=validateTexts(body.texts),strokes=validateStrokes(body,!!texts.length);
    const mixed=!!texts.length&&!!strokes.x.length;
    if(mixed&&!body.layoutImage)throw new ApiError('文字与笔迹需要一起识别，请刷新页面后重新提交画板。',409);
    if(!mixed&&body.layoutImage)throw new ApiError('画板图像应同时包含文字和笔迹。');
    const layoutImage=mixed?validateLayoutImage(body.layoutImage):undefined;
    const hash=createHash('sha256').update(JSON.stringify(layoutImage?{...strokes,texts,layoutImage,layoutVersion:2}:texts.length?{...strokes,texts}:strokes)).digest('hex');
    const pending=this.jobs.get(body.id);
    if(pending) { if(pending.hash!==hash) throw new ApiError('请求编号对应的笔迹已变更。',409); return pending.promise; }
    const promise=this.run(body.id,file,hash,strokes,texts,layoutImage);
    this.jobs.set(body.id,{hash,promise});
    try { return await promise; } finally { this.jobs.delete(body.id); }
  }
  async group(strokes,layoutImage) {
    const hash=createHash('sha256').update(layoutImage||JSON.stringify(strokes)).digest('hex');
    if(this.groups.has(hash))return this.groups.get(hash);
    const promise=(async()=>{
      const file=path.join(this.store.root,layoutImage?'ink-images':'ink-groups',hash+'.json');
      try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      const raw=layoutImage?await this.client.image(layoutImage,{documentLayout:false,autoRotate:false}):await this.client.strokes(strokes);
      if(!raw.text?.trim()&&!raw.latex_styled?.trim())throw new ApiError('未识别到内容，请重新书写后再试。',422);
      await mkdir(path.dirname(file),{recursive:true});await atomicWrite(file,JSON.stringify(raw));return raw;
    })();this.groups.set(hash,promise);
    try{return await promise;}finally{this.groups.delete(hash);}
  }
  async run(id,file,hash,strokes,texts,layoutImage) {
    const previous=await this.read(id);
    if(previous) {
      if(previous.hash!==hash) throw new ApiError('请求编号对应的笔迹已变更。',409);
      if(previous.status==='completed') return previous.result;
      throw new ApiError(previous.error || '上次提交已中断，结果不确定。请先检查控制台；不会自动重复提交。',409);
    }
    const {appId,appKey}=this.client.credentials();
    if(strokes.x.length&&(!appId || !appKey)) throw new ApiError('请先在 API 设置中填写凭据。',428);
    const entry={id,hash,status:'submitting',createdAt:new Date().toISOString()};
    await mkdir(path.dirname(file),{recursive:true}); await atomicWrite(file,JSON.stringify(entry));
    try {
      const mode=layoutImage?'layout-image':strokes.x.length?'strokes':'typed-text';
      const raw=strokes.x.length?await this.group(strokes,layoutImage):{mode:'typed-text',typedTextPreserved:true};
      const latex=typeof raw.latex_styled==='string'?raw.latex_styled:'';
      const mmd=strokes.x.length?(raw.text||'$$\n'+latex+'\n$$'):planInk(strokes,texts).map(row=>row.map(run=>literalMarkdown(run.text)).join(' ')).join('\n\n');
      if(!mmd.trim()) throw new ApiError('未识别到内容，请重新书写后再试。',422);
      const result={id,latex,mmd,confidence:raw.confidence_rate ?? raw.confidence,requestId:raw.request_id,mathGroups:strokes.x.length?1:0,mode};
      await atomicWrite(file,JSON.stringify({...entry,status:'completed',result,strokes,texts,raw,...(layoutImage?{layoutImage}:{})}));
      return result;
    } catch(e) {
      await atomicWrite(file,JSON.stringify({...entry,status:'error',error:e.message})); throw e;
    }
  }
  async save(id) {
    const entry=await this.read(id);
    if(entry?.status!=='completed') throw new ApiError('请先识别公式再保存。');
    const itemId='ink-'+id, existing=await this.store.get(itemId);
    if(existing) return existing;
    return this.store.put({id:itemId,kind:'text',title:'手写公式 '+new Date(entry.createdAt).toLocaleString('zh-CN'),createdAt:entry.createdAt,mmd:entry.result.mmd,confidence:entry.result.confidence,strokes:entry.strokes,inkTexts:entry.texts||[],inkMode:entry.result.mode,raw:entry.raw,status:'completed',demo:false,wordRequested:false});
  }
}
