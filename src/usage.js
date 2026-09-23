export function initUsage({api}) {
  const $=s=>document.querySelector(s),dialog=$('#usage-dialog');let sequence=0;
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function preset(kind) {
    const now=new Date(),end=now.toISOString().slice(0,10),start=new Date(end+'T00:00:00Z');
    if(kind==='month') start.setUTCDate(1);if(kind==='week') start.setUTCDate(start.getUTCDate()-6);
    $('#usage-from').value=start.toISOString().slice(0,10);$('#usage-to').value=end;
  }
  async function load(refresh=false) {
    const seq=++sequence;$('#usage-load').disabled=true;$('#usage-status').textContent='正在查询官方用量…';$('#usage-status').classList.remove('error');$('#usage-content').hidden=true;
    try {
      const query=new URLSearchParams({from:$('#usage-from').value,to:$('#usage-to').value,...(refresh?{refresh:'1'}:{})});
      const result=await api('/usage?'+query);if(seq!==sequence) return;
      const rows=result.breakdown;
      const cards=[['图片 / 单次笔迹',rows.find(r=>r.type==='image')?.count||0,'次'],['快速文档',rows.find(r=>r.type==='pdf-page')?.count||0,'页'],['Files 文档',rows.find(r=>r.type==='scs-page')?.count||0,'页'],['格式转换记录',rows.filter(r=>r.type.startsWith('c-')).reduce((n,r)=>n+r.count,0),'条']];
      $('#usage-summary').innerHTML=cards.map(([label,count,unit])=>'<div><span>'+label+'</span><strong>'+count.toLocaleString()+'<small>'+unit+'</small></strong></div>').join('');
      $('#usage-cost').textContent='已知识别类型的参考费用：$'+result.estimatedKnownCost.toFixed(4)+' 美元';
      $('#usage-unpriced').textContent=result.unpricedTypes.length?'以下类别未估价：'+result.unpricedTypes.join('、')+'。未估价不代表免费。':'按公开起始单价估算，未计入折扣、余额抵扣或税费。';
      $('#usage-types').innerHTML=rows.map(r=>'<tr><td>'+escape(r.label)+'<small>'+escape(r.type)+'</small></td><td>'+r.count.toLocaleString()+' '+escape(r.unit)+'</td><td>'+(r.estimate===null?'未估价':'$'+r.estimate.toFixed(4))+'</td></tr>').join('') || '<tr><td colspan="3">这个日期范围暂无官方用量记录。</td></tr>';
      $('#usage-daily').innerHTML=result.daily.map(r=>'<tr><td>'+escape(r.date)+'</td><td>'+escape(r.type)+'</td><td>'+r.count.toLocaleString()+'</td></tr>').join('') || '<tr><td colspan="3">暂无记录</td></tr>';
      $('#usage-status').textContent=result.from+' 至 '+result.to+' · 查询于 '+new Date(result.fetchedAt).toLocaleString('zh-CN');$('#usage-content').hidden=false;
    } catch(e) {if(seq===sequence){$('#usage-status').textContent=e.message;$('#usage-status').classList.add('error');}}
    finally {if(seq===sequence) $('#usage-load').disabled=false;}
  }
  preset('month');
  $('#open-usage').addEventListener('click',()=>{dialog.showModal();load();});
  $('#usage-load').addEventListener('click',()=>load(true));
  for(const kind of ['today','week','month']) $('#usage-'+kind).addEventListener('click',()=>{preset(kind);load();});
  for(const id of ['usage-from','usage-to']) $('#'+id).addEventListener('change',()=>{++sequence;$('#usage-content').hidden=true;$('#usage-load').disabled=false;$('#usage-status').textContent='日期已更改，点击查询。';});
  dialog.addEventListener('close',()=>{++sequence;$('#usage-load').disabled=false;});
}
