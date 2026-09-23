import { ApiError } from './mathpix.js';
export const PDF_MAX_BYTES = 100 * 1024 * 1024;
export const PDF_RATES = { files:0.0015, fast:0.005 };
export function selectedPages(input, total) {
  const value = String(input || '').trim();
  if (!value) return { ranges:'', count:total || null };
  if (!/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(value)) throw new ApiError('页码格式应为 1-3,5；留空识别全文。');
  const pairs = value.split(',').map(part => {
    const [start, end = start] = part.split('-').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > (total || 1_000_000)) throw new ApiError('页码超出文档范围，或起止顺序不正确。');
    return [start,end];
  }).sort((a,b) => a[0]-b[0]);
  const merged = [];
  for (const pair of pairs) {
    const last = merged.at(-1);
    if (last && pair[0] <= last[1]+1) last[1] = Math.max(last[1],pair[1]); else merged.push(pair);
  }
  return { ranges:merged.map(([a,b]) => a===b ? String(a) : a+'-'+b).join(','), count:merged.reduce((n,[a,b]) => n+b-a+1,0) };
}
