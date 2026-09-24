import path from 'node:path';
import { mkdir, readFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from './mathpix.js';
import { PDF_RATES, selectedPages } from './pdf-options.js';
import { unpackMarkdown, reserveBundle, writeBundleFile } from './pdf-bundle.js';
import { openWordFile, openFolderPath } from './word-save.js';
import { atomicWrite } from './files.js';
import { wordHash } from './word.js';

const outputs = { mmd:'mmd', docx:'docx', md:'md.zip' };
export class PdfJobs {
  constructor({store,client,update,word,directory,getDirectory,autoOpenWord=()=>true,openWord = openWordFile,openFolder = openFolderPath,pollMs = 3000,maxPolls = 28800}) {
    Object.assign(this,{store,client,update,word,directory:path.resolve(directory),openWord,openFolder,pollMs,maxPolls});
    this.jobs = new Map(); this.abort = new AbortController();
    this.getDirectory = getDirectory || (() => this.directory); this.autoOpenWord = autoOpenWord;
  }
  async submit(item,{mode='files',pages=''}) {
    if (!Object.hasOwn(PDF_RATES,mode)) throw new ApiError('请选择经济模式或快速模式。');
    if (item.kind !== 'pdf') throw new ApiError('请选择 PDF 文件。');
    if (item.pdfTask) {
      if (!item.pdfTask.remoteId) throw new ApiError('上次提交未取得任务编号，结果不确定。请先检查 Mathpix 控制台；本次不会重复提交。');
      return item;
    }
    if (item.pdfId || item.status === 'completed') throw new ApiError('这份 PDF 已有旧版识别任务。需要生成三份文件时请重新导入，并确认新的 API 用量。');
    const selection = selectedPages(pages,item.numPages);
    const bytes = item.sourceFile ? await readFile(this.store.sourcePath(item.id)) : Buffer.from(item.source.split(',')[1],'base64');
    item.pdfTask = { mode, outputDirectory:path.resolve(this.getDirectory()), pages:selection.ranges, selectedPages:selection.count, estimatedCost:selection.count ? selection.count*PDF_RATES[mode] : null, status:'submitting', artifacts:{}, createdAt:new Date().toISOString() };
    item.status = 'processing'; delete item.error; await this.store.put(item);
    try {
      const result = await this.client.document(bytes,item.title,selection.ranges,mode,this.abort.signal);
      const remoteId = mode === 'files' ? result.file_id : result.pdf_id;
      if (!remoteId || typeof remoteId !== 'string') throw new ApiError('Mathpix 未返回任务编号，提交结果不确定。');
      item.pdfTask.remoteId = remoteId; item.pdfTask.status = 'processing'; item.raw = result;
      await this.store.put(item); this.start(item.id); return item;
    } catch (error) {
      item.status = 'error'; item.error = error.message;
      item.pdfTask.status = error.uncertain || !error.status || /未返回任务编号/.test(error.message) ? 'uncertain' : 'error';
      item.pdfTask.error = error.message; await this.store.put(item); throw error;
    }
  }
  start(id) {
    if (this.abort.signal.aborted || this.jobs.has(id)) return;
    const promise = new Promise(resolve => setImmediate(resolve)).then(() => this.run(id)).finally(() => this.jobs.delete(id));
    this.jobs.set(id,promise); promise.catch(() => {});
  }
  async resume() {
    for (const entry of await this.store.list()) {
      const item = await this.store.get(entry.id), task = item?.pdfTask;
      if (!task) continue;
      if (task.remoteId && ['processing','saving'].includes(task.status)) this.start(item.id);
      else if (task.status === 'submitting') await this.update(item.id,current => {
        current.pdfTask.status = 'uncertain'; current.status = 'error';
        current.error = current.pdfTask.error = '提交中断且未收到任务编号，请检查 Mathpix 控制台。本工具不会自动重新上传。';
      });
    }
  }
  async retry(id) {
    await this.update(id,item => {
      if (!item.pdfTask?.remoteId) throw new ApiError('没有可继续查询的云端任务，请先检查原提交结果。');
      if (item.pdfTask.status === 'completed') return;
      item.pdfTask.status = 'processing'; item.status = 'processing'; delete item.error; delete item.pdfTask.error;
      for (const artifact of Object.values(item.pdfTask.artifacts)) if (artifact.status === 'error') { artifact.status = 'pending'; delete artifact.error; }
    });
    const item = await this.store.get(id);
    if (item.pdfTask.status !== 'completed') { const previous = this.jobs.get(id); if (previous) await previous; this.start(id); }
  }
  cache(id,ext) { this.store.itemPath(id); return path.join(this.store.root,'pdf-results',id,'result.'+ext); }
  checkFolder(task) {
    if (path.dirname(path.resolve(task.folder)) !== path.resolve(task.outputDirectory || this.directory)) throw new Error('PDF 输出文件夹不在指定目录中。');
  }
  async publish(id,key,bytes) {
    const markdown = key === 'md' ? await unpackMarkdown(bytes) : null;
    if (key === 'docx' && (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)) throw new Error('官方 Word 文件不是有效的 DOCX。');
    await this.update(id,async item => {
      const task = item.pdfTask;
      if (!task.folder) Object.assign(task,await reserveBundle(task.outputDirectory || this.directory,item.title));
      this.checkFolder(task);
      // Persist the reserved directory before writing; restart uses the same directory.
      await this.store.put(item);
      if (markdown) {
        for (const [name,content] of markdown.images) await writeBundleFile(task.folder,name,content);
        await writeBundleFile(task.folder,task.stem+'.md',Buffer.from(markdown.text));
      } else await writeBundleFile(task.folder,task.stem+'.'+key,bytes);
      task.artifacts[key] = { status:'completed', path:path.join(task.folder,task.stem+'.'+key) };
      if (key === 'mmd' && !item.editedAt) item.mmd = bytes.toString('utf8');
      if (key === 'docx') {
        const raw = await readFile(this.cache(id,'mmd')).catch(() => null);
        if (raw && !item.editedAt) {
          const hash = wordHash(raw.toString('utf8')), target = this.word.cachePath(id,hash);
          await mkdir(path.dirname(target),{recursive:true}); await atomicWrite(target,bytes);
          item.word = { status:'completed', hash }; item.wordRequested = true;
        }
      }
    });
  }
  async collect(id,key) {
    let item = await this.store.get(id);
    if (!item || item.pdfTask.artifacts[key]?.status === 'completed' || this.abort.signal.aborted) return;
    const ext = outputs[key], cache = this.cache(id,ext);
    let bytes;
    try { bytes = await readFile(cache); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes) {
      bytes = await this.client.documentOutput(item.pdfTask.remoteId,item.pdfTask.mode,ext,this.abort.signal);
      if (this.abort.signal.aborted || !(await this.store.get(id))) return;
      await mkdir(path.dirname(cache),{recursive:true}); await atomicWrite(cache,bytes);
    }
    await this.publish(id,key,bytes);
  }
  async run(id) {
    let transientFailures = 0;
    try {
      for (let n=0;n<this.maxPolls && !this.abort.signal.aborted;n++) {
        const item = await this.store.get(id), task = item?.pdfTask;
        if (!task?.remoteId || task.status === 'completed') return;
        let result;
        try { result = await this.client.documentStatus(task.remoteId,task.mode,this.abort.signal); transientFailures = 0; }
        catch (error) {
          if (!error.transient || ++transientFailures > 10) throw error;
          await delay(Math.min(this.pollMs*2**transientFailures,60000),undefined,{signal:this.abort.signal}); continue;
        }
        await this.update(id,current => {
          current.raw = result; current.progress = result.percent_done || 0;
          current.pdfTask.phase = result.status === 'pending' || result.status === 'received' ? 'queued' : 'recognizing';
          current.pdfTask.cloudPages = result.num_pages;
        });
        if (result.status === 'error') throw new ApiError(result.error_info?.message || result.error || 'PDF 识别失败。');
        if (result.status === 'completed') {
          let formats = result.formats;
          if (task.mode === 'fast') formats = (await this.client.documentFormats(task.remoteId,this.abort.signal)).conversion_status;
          await this.update(id,current => { current.pdfTask.phase = 'converting'; });
          for (const [key,ext] of Object.entries(outputs)) {
            const current = await this.store.get(id);
            if (!current || this.abort.signal.aborted) return;
            if (['completed','error'].includes(current.pdfTask.artifacts[key]?.status)) continue;
            const rawStatus = formats?.[ext], status = typeof rawStatus === 'string' ? rawStatus : rawStatus?.status;
            if (status === 'error') {
              await this.update(id,i => { i.pdfTask.artifacts[key] = { status:'error', error:key.toUpperCase()+' 官方格式转换失败。' }; }); continue;
            }
            if (key !== 'mmd' && status !== 'completed') continue;
            try { await this.collect(id,key); }
            catch (error) {
              if (error.pending || error.transient) continue;
              await this.update(id,i => { i.pdfTask.artifacts[key] = { status:'error', error:error.message }; });
            }
          }
          const current = await this.store.get(id);
          if (!current) return;
          const artifacts = current.pdfTask.artifacts;
          if (Object.keys(outputs).every(key => ['completed','error'].includes(artifacts[key]?.status))) {
            const failures = Object.values(artifacts).filter(a => a.status === 'error');
            await this.update(id,i => {
              i.pdfTask.status = failures.length ? 'partial' : 'completed'; i.pdfTask.phase = 'saved';
              i.status = i.mmd ? 'completed' : 'error';
              if (failures.length) i.pdfTask.error = failures.map(f => f.error).join(' ');
              else { delete i.pdfTask.error; i.pdfTask.completedAt = new Date().toISOString(); }
            });
            if (!failures.length) await this.autoOpen(id);
            return;
          }
        }
        await delay(this.pollMs,undefined,{signal:this.abort.signal});
      }
      if (!this.abort.signal.aborted) throw new Error('任务仍未完成。稍后点“继续任务”查询原任务，不会重新上传。');
    } catch (error) {
      if (!this.abort.signal.aborted) await this.update(id,i => { i.pdfTask.status = 'error'; i.pdfTask.error = error.message; if (!i.mmd) i.status = 'error'; }).catch(() => {});
    }
  }
  async autoOpen(id) {
    if (!this.autoOpenWord()) return;
    let file;
    await this.update(id,item => {
      if (item.pdfTask.openAttemptedAt) return;
      item.pdfTask.openAttemptedAt = new Date().toISOString(); file = item.pdfTask.artifacts.docx.path;
    });
    if (!file) return;
    try { await this.openWord(file); }
    catch (error) { await this.update(id,item => { item.pdfTask.openError = '文件已保存，自动打开失败：'+error.message; }); }
  }
  async open(id,kind) {
    const item = await this.store.get(id), task = item?.pdfTask;
    if (!task?.folder) throw new ApiError('文件尚未保存。');
    this.checkFolder(task);
    const file = kind === 'folder' ? task.folder : task.artifacts.docx?.path;
    if (!file || (kind !== 'folder' && path.dirname(file) !== task.folder)) throw new ApiError('Word 尚未保存。');
    await access(file).catch(() => { throw new ApiError('本机文件已移动或删除：'+file); });
    try { await (kind === 'folder' ? this.openFolder(file) : this.openWord(file)); }
    catch (error) { throw new ApiError((kind === 'folder' ? '打开文件夹失败：' : '打开 Word 失败：') + error.message + '。文件仍保存在：' + file,500); }
    return { path:file };
  }
  async close() { this.abort.abort(); await Promise.allSettled([...this.jobs.values()]); }
}
