// Mathpix's top-level confidence estimates a completely correct result.
// confidence_rate measures output quality and must not stand in for it.
export function overallConfidence(raw) {
  const value = raw?.confidence;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export function confidenceLabel(item) {
  if (item.demo) return '演示内容 · 无真实置信度';
  const value = overallConfidence(item.raw);
  if (value !== undefined) return 'Mathpix 整体置信度 ' + (value * 100).toFixed(1) + '%' + (item.editedAt ? '（原始结果）' : '');
  const recognized = item.status === 'completed' && (item.kind !== 'text' || ['strokes','layout-image'].includes(item.inkMode));
  if (recognized) return 'Mathpix 未提供整体置信度';
  return item.editedAt ? '已人工编辑' : item.status === 'completed' ? '已保存' : '等待识别';
}
