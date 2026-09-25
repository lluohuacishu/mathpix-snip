import { MaskEditor, paintMasks } from '../public/mask-editor.js';

export function initMasking({saveCurrent,importFile,toast}) {
  const $=selector=>document.querySelector(selector),dialog=$('#mask-dialog'),image=$('#mask-image'),stage=$('#mask-stage');
  let originalTitle='',saving=false;
  const editor=new MaskEditor({surface:stage,layer:$('#image-masks'),enabled:()=>dialog.open&&!saving,changed:update});
  function update(){
    dialog.querySelector('.close').disabled=saving;
    $('#image-mask-undo').disabled=!editor.history.length||!!editor.drag||saving;
    $('#image-mask-delete').disabled=editor.selected<0||!!editor.drag||saving;
    $('#image-mask-clear').disabled=!editor.masks.length||!!editor.drag||saving;
    $('#mask-save').disabled=!editor.masks.length||!!editor.drag||saving;
    $('#mask-count').textContent=editor.masks.length+' 个遮罩';
    for(const color of ['white','black'])$('#image-mask-'+color).setAttribute('aria-pressed',String(editor.tool===color));
  }
  for(const color of ['white','black'])$('#image-mask-'+color).addEventListener('click',()=>{if(!saving)editor.setTool(color);});
  $('#image-mask-undo').addEventListener('click',()=>editor.undo());
  $('#image-mask-delete').addEventListener('click',()=>editor.remove());
  $('#image-mask-clear').addEventListener('click',()=>editor.clear());
  $('#mask-save').addEventListener('click',async()=>{
    if(saving||editor.drag||!editor.masks.length)return;
    saving=true;update();$('#mask-error').hidden=true;
    try{
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d');if(!context)throw new Error('无法创建图片，请重试。');
      context.drawImage(image,0,0);paintMasks(context,editor.masks,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('图片生成失败，请重试。');
      await importFile(new File([blob],originalTitle.replace(/\.(png|jpe?g|webp|bmp)$/i,'').slice(0,90)+'-遮罩.png',{type:'image/png'}));
      dialog.close();toast('遮罩图片已另存为新记录，点击“开始识别”提交');
    }catch(error){$('#mask-error').textContent=error.message;$('#mask-error').hidden=false;}
    finally{saving=false;update();}
  });
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  dialog.addEventListener('close',()=>{if(!dialog.open&&!saving)editor.reset();});
  return {
    async open(item){
      if(!item||item.kind!=='image'||item.demo)return;
      await saveCurrent();originalTitle=item.title;image.src=item.source;await image.decode();
      const scale=Math.min(1,880/image.naturalWidth,Math.max(160,Math.min(540,innerHeight-350))/image.naturalHeight);
      stage.style.width=Math.round(image.naturalWidth*scale)+'px';stage.style.aspectRatio=image.naturalWidth+'/'+image.naturalHeight;
      $('#mask-error').hidden=true;dialog.showModal();editor.reset();editor.setTool('white');
    },
  };
}
