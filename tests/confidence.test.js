import test from 'node:test';
import assert from 'node:assert/strict';
import { overallConfidence, confidenceLabel } from '../lib/confidence.js';

test('overall confidence uses only the top-level official score, including zero, never the rate or line scores',()=>{
  assert.equal(overallConfidence({confidence:0.41,confidence_rate:0.999}),0.41);
  assert.equal(overallConfidence({confidence:0,confidence_rate:1}),0);
  assert.equal(overallConfidence({confidence:1}),1);
  for(const confidence of [undefined,null,NaN,Infinity,-0.1,1.01,'0.8'])assert.equal(overallConfidence({confidence,confidence_rate:0.99}),undefined);
  assert.equal(overallConfidence({line_data:[{confidence:0.99}],confidence_rate:1}),undefined);
});

test('legacy history reads its raw response; missing confidence is not fabricated and edited results retain context',()=>{
  const old={kind:'image',status:'completed',confidence:0.999,raw:{confidence:0.41,confidence_rate:0.999}};
  assert.equal(confidenceLabel(old),'Mathpix 整体置信度 41.0%');
  assert.equal(confidenceLabel({...old,raw:{confidence:0,confidence_rate:1}}),'Mathpix 整体置信度 0.0%');
  assert.equal(confidenceLabel({...old,raw:{confidence_rate:0.999}}),'Mathpix 未提供整体置信度');
  assert.equal(confidenceLabel({...old,editedAt:'now'}),'Mathpix 整体置信度 41.0%（原始结果）');
  assert.equal(confidenceLabel({...old,demo:true}),'演示内容 · 无真实置信度');
  assert.equal(confidenceLabel({kind:'text',status:'completed'}),'已保存');
  assert.equal(confidenceLabel({kind:'text',status:'completed',inkMode:'strokes',raw:{confidence_rate:1}}),'Mathpix 未提供整体置信度');
  assert.equal(confidenceLabel({kind:'pdf',status:'completed',raw:{status:'completed'}}),'Mathpix 未提供整体置信度');
});
