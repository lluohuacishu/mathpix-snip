import { ApiError } from './mathpix.js';
import { createHash } from 'node:crypto';

export function usageRange(from,to) {
  const date=value=>{
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError('请选择开始和结束日期。');
    const parsed=new Date(value+'T00:00:00.000Z');
    if(!Number.isFinite(+parsed) || parsed.toISOString().slice(0,10)!==value) throw new ApiError('日期无效。');
    return parsed;
  };
  const start=date(from), end=date(to);
  if(end<start || +end-+start>365*86400000) throw new ApiError('结束日期不能早于开始日期，一次最多查询 366 天。');
  return {from_date:start.toISOString(),to_date:new Date(+end+86400000).toISOString()};
}
const types={image:['图片 / 单次笔迹','次',0.002],'pdf-page':['快速文档','页',0.005],'scs-page':['Files 文档','页',0.0015]};
export function summarizeUsage(data) {
  if(!Array.isArray(data?.ocr_usage)) throw new ApiError('官方未返回有效的用量数据。',502);
  const records=data.ocr_usage.map(row=>{
    if(!row || typeof row.usage_type!=='string' || !Number.isFinite(row.count) || row.count<0 || !Number.isFinite(Date.parse(row.from_date))) throw new ApiError('官方用量数据格式异常，请稍后重试。',502);
    return {date:new Date(row.from_date).toISOString().slice(0,10),type:row.usage_type,count:row.count};
  });
  const totals=new Map(), daily=new Map();
  for(const row of records) { totals.set(row.type,(totals.get(row.type)||0)+row.count); const key=row.date+'|'+row.type; daily.set(key,{...row,count:(daily.get(key)?.count||0)+row.count}); }
  const breakdown=[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([type,count])=>{
    const [label,unit,rate]=types[type] || [type.startsWith('c-')?'格式转换 '+type.slice(2):type,'记录',null];
    return {type,label,unit,count,rate,estimate:rate===null?null:count*rate};
  });
  return {breakdown,daily:[...daily.values()].sort((a,b)=>b.date.localeCompare(a.date)||a.type.localeCompare(b.type)),estimatedKnownCost:breakdown.reduce((sum,r)=>sum+(r.estimate||0),0),unpricedTypes:breakdown.filter(r=>r.rate===null).map(r=>r.type)};
}
export class UsageStats {
  constructor(client) { this.client=client;this.cache=new Map(); }
  async get(from,to,refresh=false) {
    const range=usageRange(from,to),{appId,appKey}=this.client.credentials();
    if(!appId || !appKey) throw new ApiError('请先在 API 设置中填写凭据。',428);
    const key=createHash('sha256').update(JSON.stringify([appId,appKey,from,to])).digest('hex');
    const previous=this.cache.get(key);
    if(previous && (!previous.data || (!refresh && Date.now()-previous.time<60000))) return previous.promise;
    const entry={time:Date.now()};
    entry.promise=this.client.usage(range).then(raw=>{
      const data={...summarizeUsage(raw),from,to,timezone:'UTC',fetchedAt:new Date().toISOString()};entry.data=data;return data;
    }).catch(e=>{this.cache.delete(key);throw e;});
    if(this.cache.size>50) this.cache.clear();this.cache.set(key,entry);return entry.promise;
  }
}
