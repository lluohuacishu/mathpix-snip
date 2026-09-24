export function initLocalFiles({api, saveCurrent, changed, toast, refreshIcons}) {
  const $ = selector => document.querySelector(selector);
  let files = [], selection = null, saving = false;
  const status = (message, error = false) => { $('#local-files-status').textContent = message; $('#local-files-status').classList.toggle('error',error); };
  const handle = fn => async () => { try { await fn(); } catch(error) { status(error.message,true); } };
  function draw() {
    const query = $('#local-files-search').value.trim().toLowerCase();
    const matches = files.filter(f=>(f.name+' '+f.path).toLowerCase().includes(query));
    const list = $('#local-files-list'); list.replaceChildren();
    for (const file of matches) {
      const row = document.createElement('div'); row.className = 'local-file-row';
      const symbol = document.createElement('i'); symbol.dataset.lucide = file.kind==='bundle' ? 'folder' : 'file-text';
      const info = document.createElement('div'); info.className = 'local-file-info';
      const name = document.createElement('strong'); name.textContent = file.name;
      const detail = document.createElement('small'); detail.textContent = (file.kind==='bundle' ? 'PDF 文档组' : file.extension.slice(1).toUpperCase()) + (file.busy ? ' · 正在转换，完成后可改名' : '');
      const location = document.createElement('span'); location.textContent = file.path;
      info.append(name,detail,location);
      const actions = document.createElement('div'); actions.className='local-file-actions';
      const open = document.createElement('button'); open.className='outline'; open.textContent='打开文件夹'; open.addEventListener('click',handle(async()=>{await api('/local-files/'+file.id+'/open',{method:'POST',body:{}});status('已请求打开文件夹。');}));
      const rename = document.createElement('button'); rename.className='outline'; rename.textContent='改名'; rename.dataset.renameId=file.id; rename.disabled=file.busy;
      rename.addEventListener('click',()=>prompt(file)); actions.append(open,rename); row.append(symbol,info,actions); list.append(row);
    }
    if (!matches.length) { const empty = document.createElement('p'); empty.className='local-files-empty'; empty.textContent=query ? '没有匹配的文件。' : '尚未找到本地文档。导出 Word 或完成 PDF 转换后，可在这里管理。'; list.append(empty); }
    $('#local-files-count').textContent=matches.length+' 项'; refreshIcons();
  }
  async function refresh() {
    $('#local-files-refresh').disabled=true; status('正在读取本地文件…');
    try { const result=await api('/local-files'); files=result.files; draw(); status(result.warning || '改名不会重新调用 Mathpix，也不会产生转换费用。',!!result.warning); }
    finally { $('#local-files-refresh').disabled=false; }
  }
  function prompt(file, record = false) {
    selection={...file,record};
    $('#rename-heading').textContent=record ? '修改记录名称' : file.kind==='bundle' ? '重命名 PDF 文档组' : '重命名本地文件';
    $('#rename-name').maxLength=record ? 120 : 90;
    $('#rename-name').value=record ? file.title : file.kind==='bundle' ? file.name : file.stem;
    $('#rename-detail').textContent=record ? '只修改历史记录标题。已导出的文件可在“本地文件”中单独改名。' : file.kind==='bundle' ? '同时修改文件夹及其中 DOCX、MD、MMD 的名称，配图保持原位。' : '文件扩展名 '+file.extension+' 保持不变，文件内容不会修改。';
    $('#rename-error').hidden=true; $('#rename-dialog').showModal(); $('#rename-name').focus(); $('#rename-name').select();
  }
  $('#rename-dialog').addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  $('#rename-form').addEventListener('submit',async event=>{
    event.preventDefault(); if(saving || !selection)return;
    const chosen=selection, name=$('#rename-name').value.trim();
    if(!name){$('#rename-error').textContent='请输入新名称。';$('#rename-error').hidden=false;return;}
    saving=true; $('#rename-submit').disabled=true; $('#rename-cancel').disabled=true; $('#rename-name').disabled=true; $('#rename-error').hidden=true;
    try {
      if(chosen.record) await api('/items/'+chosen.id,{method:'PATCH',body:{title:name}});
      else await api('/local-files/'+chosen.id+'/rename',{method:'POST',body:{name}});
      $('#rename-dialog').close(); toast(chosen.record ? '记录名称已修改' : '本地文件已改名');
      await changed(); if($('#local-files-dialog').open) await refresh();
    } catch(error) {
      if($('#rename-dialog').open){$('#rename-error').textContent=error.message;$('#rename-error').hidden=false;}
      else status(error.message,true);
    } finally { saving=false; $('#rename-submit').disabled=false; $('#rename-cancel').disabled=false; $('#rename-name').disabled=false; }
  });
  $('#local-files-search').addEventListener('input',draw);
  $('#local-files-refresh').addEventListener('click',handle(refresh));
  return {
    async open(){ await saveCurrent(); $('#local-files-dialog').showModal(); await handle(refresh)(); },
    async renameRecord(item){ if(!item)return; await saveCurrent(); prompt({id:item.id,title:$('#title').value},true); },
  };
}
