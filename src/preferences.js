const $ = selector => document.querySelector(selector);
const modifiers = ['Ctrl','Alt','Shift','Super'];
const label = value => value.replace('Super','Win').split('+').join(' + ');

export function initPreferences({ api, changed }) {
  let preferences, revision = 0;
  const available = !!window.desktopCapture?.setHotkey;
  const status = (selector, message, error = false) => { const node=$(selector); node.textContent=message; node.classList.toggle('error',error); };
  for (const key of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...Array.from({length:24},(_,i)=>'F'+(i+1))]) $('#shortcut-key').add(new Option(key,key));
  function shortcut(value) {
    const parts=value.split('+'); $('#shortcut-key').value=parts.pop();
    modifiers.forEach(modifier=>{ $('#shortcut-'+modifier.toLowerCase()).checked=parts.includes(modifier); });
  }
  function tab(name) {
    const general=name==='general'; $('#general-settings').hidden=!general; $('#settings-form').hidden=general;
    $('#settings-general-tab').setAttribute('aria-selected',String(general)); $('#settings-api-tab').setAttribute('aria-selected',String(!general));
  }
  $('#settings-general-tab').addEventListener('click',()=>tab('general'));
  $('#settings-api-tab').addEventListener('click',()=>tab('api'));
  $('#shortcut-fields').disabled=!available; $('#shortcut-save').disabled=!available; $('#shortcut-reset').disabled=!available;
  $('#choose-output').hidden=!window.desktopCapture?.chooseDirectory;
  $('#shortcut-reset').addEventListener('click',()=>shortcut('Alt+Shift+Q'));
  $('#shortcut-form').addEventListener('submit',async event=>{
    event.preventDefault(); if(!available)return;
    const value=[...modifiers.filter(modifier=>$('#shortcut-'+modifier.toLowerCase()).checked),$('#shortcut-key').value].join('+');
    $('#shortcut-save').disabled=true; status('#shortcut-status','正在应用快捷键…');
    try { const result=await window.desktopCapture.setHotkey(value); if(result.error)throw new Error(result.error); shortcut(result.hotkey); status('#shortcut-status','已生效：'+label(result.hotkey)+'；重启后仍保留。'); }
    catch(error){ status('#shortcut-status',error.message,true); }
    finally { $('#shortcut-save').disabled=false; }
  });
  $('#output-reset').addEventListener('click',()=>{ if(preferences)$('#output-directory').value=preferences.defaultOutputDirectory; });
  $('#choose-output').addEventListener('click',async()=>{
    try { const directory=await window.desktopCapture.chooseDirectory(); if(directory)$('#output-directory').value=directory; }
    catch { status('#output-status','无法打开文件夹选择器，可直接填写完整路径。',true); }
  });
  $('#output-form').addEventListener('submit',async event=>{
    event.preventDefault(); $('#output-save').disabled=true; status('#output-status','正在检查文件夹并保存…');
    try { preferences=await api('/preferences',{method:'POST',body:{outputDirectory:$('#output-directory').value,autoOpenWord:$('#auto-open-word').checked}}); changed(preferences); $('#output-directory').value=preferences.outputDirectory; status('#output-status','已保存。新导出使用此目录，已有文件和正在转换的 PDF 保留原位置。'); }
    catch(error){ status('#output-status',error.message,true); }
    finally { $('#output-save').disabled=false; }
  });
  return {
    async open(name='api') {
      const current=++revision; tab(name); $('#settings-dialog').showModal(); $('#output-fields').disabled=true; $('#output-save').disabled=true;
      status('#output-status','正在读取设置…');
      status('#shortcut-status',available?'修改后点击“应用快捷键”，立即生效。':'全局快捷键仅在桌面版中可修改。');
      try {
        const [settings,desktop]=await Promise.all([api('/preferences'),available?window.desktopCapture.getState():null]);
        if(current!==revision)return;
        preferences=settings; changed(settings); $('#output-directory').value=settings.outputDirectory; $('#auto-open-word').checked=settings.autoOpenWord;
        shortcut(desktop?.hotkey||'Alt+Shift+Q'); status('#output-status','用于图片识别的 Word 和 PDF 的 DOCX、MD、MMD 文件。');
        $('#output-fields').disabled=false; $('#output-save').disabled=false;
      } catch(error){ if(current===revision)status('#output-status',error.message,true); }
    },
  };
}
