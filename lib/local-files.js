import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, link, unlink, rename, rm } from 'node:fs/promises';
import { atomicWrite } from './files.js';
import { ApiError } from './mathpix.js';
import { openFolderPath } from './word-save.js';

const extensions = ['.docx', '.md', '.mmd'];
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (a, b) => !!a && !!b && key(a) === key(b);
const within = (file, folder) => { if (!file || !folder) return false; const relative=path.relative(folder,file); return !!relative && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative); };
const fileId = file => createHash('sha256').update(key(file)).digest('hex');
async function stat(file) { try { return await lstat(file, { bigint:true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
const identity = s => s && s.dev.toString() + ':' + s.ino.toString();
const active = item => ['submitting','processing','saving'].includes(item?.pdfTask?.status);

export function renameStem(value, ext = '') {
  if (typeof value !== 'string') throw new ApiError('请输入新名称。');
  let name = value.trim();
  if (ext && name.toLowerCase().endsWith(ext)) name = name.slice(0, -ext.length);
  if (!name || name.length > 90 || /^[. ]|[. ]$/.test(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name))
    throw new ApiError('名称须为 1–90 个字符，不能包含路径、特殊符号、首尾句点或 Windows 保留名称。');
  return name;
}

// Publish a new file name exclusively: an existing destination is never replaced.
// A short-lived hard link also makes an interrupted rename recoverable without
// copying or altering the user's document. Directories move only within a parent.
async function move(step, reverse = false) {
  const from = reverse ? step.to : step.from, to = reverse ? step.from : step.to;
  const source = await stat(from), target = await stat(to);
  if (reverse && target && identity(target) === step.identity && identity(source) !== step.identity) return;
  if (source?.isSymbolicLink() || target?.isSymbolicLink()) throw new ApiError('不能重命名链接文件。');
  if (target && identity(target) !== step.identity) throw new ApiError('同名文件或文件夹已存在，请换一个名称。',409);
  if (!source) {
    if (target && identity(target) === step.identity) return;
    throw new ApiError('文件已被移动或删除，请刷新列表。',409);
  }
  if (identity(source) !== step.identity) throw new ApiError('文件已发生变化，请刷新后重试。',409);
  if (step.directory) {
    if (target) throw new ApiError('同名文件夹已存在。',409);
    if (path.dirname(from) !== path.dirname(to)) throw new Error('Folder rename must remain in the same parent');
    await rename(from, to);
  } else {
    if (!target) await link(from, to);
    await unlink(from);
  }
}

export class LocalFiles {
  constructor({store, directory, getDirectory, lock, isBusy = () => false, openFolder = openFolderPath}) {
    Object.assign(this, {store, directory, getDirectory, lock, isBusy, openFolder});
    this.journal = path.join(store.root, 'file-rename.json'); this.warning = '';
  }
  async records() { return (await Promise.all((await this.store.list()).map(i => this.store.get(i.id)))).filter(Boolean); }
  async list() {
    const records = await this.records(), roots = new Map(), bundles = new Map(), rows = new Map(), warnings = [];
    const addRoot = folder => { if (folder) roots.set(key(folder), path.resolve(folder)); };
    addRoot(this.directory); addRoot(this.getDirectory());
    for (const item of records) {
      for (const file of item.localExports || []) addRoot(path.dirname(file.path));
      const task = item.pdfTask;
      if (task?.folder && same(path.dirname(task.folder), task.outputDirectory || this.directory)) {
        addRoot(path.dirname(task.folder)); bundles.set(key(task.folder), {folder:task.folder, stem:task.stem});
      }
    }
    for (const folder of roots.values()) {
      let entries;
      try { entries = await readdir(folder, {withFileTypes:true}); }
      catch (error) { if (error.code !== 'ENOENT') warnings.push('无法读取：' + folder); continue; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name), ext = path.extname(entry.name).toLowerCase();
        if (entry.isFile() && extensions.includes(ext)) {
          rows.set(key(file), {id:fileId(file), path:file, name:entry.name, stem:entry.name.slice(0,-ext.length), extension:ext, kind:'file'});
        } else if (entry.isDirectory() && !bundles.has(key(file))) {
          // Also find bundles whose history record has been deleted. Do not walk
          // unrelated directories or follow links outside the selected roots.
          try {
            const names = await readdir(file, {withFileTypes:true}), files = new Set(names.filter(n=>n.isFile()).map(n=>n.name));
            const docx = [...files].find(n => n.endsWith('.docx') && files.has(n.slice(0,-5)+'.md') && files.has(n.slice(0,-5)+'.mmd'));
            if (docx) bundles.set(key(file), {folder:file, stem:docx.slice(0,-5)});
          } catch {}
        }
      }
    }
    for (const bundle of bundles.values()) {
      const s = await stat(bundle.folder).catch(()=>null);
      if (!s?.isDirectory() || s.isSymbolicLink()) continue;
      rows.set(key(bundle.folder), {id:fileId(bundle.folder), path:bundle.folder, name:path.basename(bundle.folder), stem:bundle.stem, kind:'bundle'});
    }
    // A selected export root can itself be a PDF bundle. Its three component
    // files must still be renamed together, even when also visible in that root.
    for (const bundle of bundles.values()) for (const ext of extensions) rows.delete(key(path.join(bundle.folder,bundle.stem+ext)));
    for (const row of rows.values()) {
      const related = records.filter(i => row.kind === 'bundle' ? same(i.pdfTask?.folder,row.path) || within(i.pdfTask?.folder,row.path) || (i.localExports || []).some(f=>within(f.path,row.path)) : (i.localExports || []).some(f=>same(f.path,row.path)));
      row.recordIds = related.map(i=>i.id); row.busy = related.some(i=>active(i)||this.isBusy(i.id));
    }
    return {files:[...rows.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')), warning:[this.warning,...warnings].filter(Boolean).join('；')};
  }
  async find(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new ApiError('无效文件编号。');
    const file = (await this.list()).files.find(f=>f.id===id);
    if (!file) throw new ApiError('文件已移动、改名或删除，请刷新列表。',404);
    return file;
  }
  async open(id) {
    const file = await this.find(id), folder = file.kind === 'bundle' ? file.path : path.dirname(file.path);
    try { await this.openFolder(folder); } catch { throw new ApiError('无法打开文件夹，请在资源管理器中访问：' + folder); }
    return {path:folder};
  }
  async updateReferences(job, reverse = false) {
    const from = reverse ? job.to : job.from, to = reverse ? job.from : job.to;
    for (const id of job.recordIds) {
      const item = await this.store.get(id); if (!item) continue;
      let changed = false;
      const translate = file => {
        const pairs = job.paths.map(p=>reverse ? [p.to,p.from] : [p.from,p.to]);
        const pair = pairs.find(([old])=>same(file,old));
        if (pair) { changed = true; return pair[1]; }
        if (job.kind === 'bundle' && (same(file,from) || within(file,from))) { changed=true; return path.join(to,path.relative(from,file)); }
        return file;
      };
      for (const file of item.localExports || []) file.path = translate(file.path);
      if (job.kind === 'bundle' && (same(item.pdfTask?.folder,from) || within(item.pdfTask?.folder,from))) {
        if (same(item.pdfTask.folder,from)) item.pdfTask.stem = reverse ? job.oldStem : job.stem;
        item.pdfTask.folder = translate(item.pdfTask.folder); changed = true;
        if (item.pdfTask.outputDirectory) item.pdfTask.outputDirectory = translate(item.pdfTask.outputDirectory);
        for (const artifact of Object.values(item.pdfTask.artifacts || {})) if (artifact.path) artifact.path = translate(artifact.path);
      }
      if (changed) await this.store.put(item);
    }
  }
  async finish(job) {
    if (job.rollback) {
      for (const step of [...job.steps].reverse()) {
        if (!step.started) continue;
        await move(step,true); step.started = false; step.done = false;
        await atomicWrite(this.journal,JSON.stringify(job));
      }
      await this.updateReferences(job,true);
    } else {
      for (const step of job.steps) {
        if (step.done) continue;
        step.started = true; await atomicWrite(this.journal,JSON.stringify(job));
        await move(step); step.done = true; await atomicWrite(this.journal,JSON.stringify(job));
      }
      await this.updateReferences(job);
    }
    await rm(this.journal,{force:true}); this.warning = '';
  }
  async init() {
    let job;
    try { job = JSON.parse(await readFile(this.journal,'utf8')); } catch (error) { if(error.code==='ENOENT') return; this.warning='上次文件改名记录无法读取，请保留数据目录并检查文件。'; return; }
    try { await this.finish(job); }
    catch {
      try { job.rollback = true; await atomicWrite(this.journal,JSON.stringify(job)); await this.finish(job); }
      catch { this.warning = '上次文件改名尚未恢复，请关闭占用文件的程序并重启。恢复前暂不能继续改名。'; }
    }
  }
  async rename(id, value) {
    if (this.warning) throw new ApiError(this.warning,409);
    const row = await this.find(id);
    const withLocks = (ids, fn) => ids.length ? this.lock(ids[0],()=>withLocks(ids.slice(1),fn)) : fn();
    return withLocks([...row.recordIds].sort(), async () => {
      const current = await this.find(id);
      if (current.busy) throw new ApiError('PDF 正在转换或保存，请完成后再改名。',409);
      if (current.kind==='bundle' && (same(this.getDirectory(),current.path) || within(this.getDirectory(),current.path)))
        throw new ApiError('此文件夹包含当前的导出目录。请先在设置中选择其他导出目录，再为它改名。',409);
      const stem = renameStem(value,current.extension), destination = path.join(path.dirname(current.path),stem+(current.extension||''));
      if (destination === current.path && (current.kind === 'file' || stem === current.stem)) return current;
      if (!same(destination,current.path) && await stat(destination)) throw new ApiError('同名文件或文件夹已存在，请换一个名称。',409);
      const job = {from:current.path,to:destination,kind:current.kind,oldStem:current.stem,stem,recordIds:current.recordIds,steps:[],paths:[]};
      const add = async (from,to,directory=false) => {
        if (from === to) return;
        const s = await stat(from);
        if (!s || s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw new ApiError('文件已被移动、删除或替换，请刷新后重试。',409);
        if (!same(from,to) && await stat(to)) throw new ApiError('同名文件或文件夹已存在，请换一个名称。',409);
        const step = {from,to,directory,identity:identity(s)};
        if (same(from,to)) {
          const temporary = path.join(path.dirname(from),'.mathsnip-rename-'+randomUUID());
          job.steps.push({...step,to:temporary},{...step,from:temporary});
        } else job.steps.push(step);
      };
      if (current.kind === 'file') {
        await add(current.path,destination); job.paths.push({from:current.path,to:destination});
      } else {
        // Rename the three documents while retaining every image and its relative path.
        for (const ext of extensions) {
          const oldFile = path.join(current.path,current.stem+ext), newFile = path.join(current.path,stem+ext);
          const exists = await stat(oldFile);
          if (exists) await add(oldFile,newFile);
          job.paths.push({from:oldFile,to:path.join(destination,stem+ext)});
        }
        await add(current.path,destination,true);
      }
      await atomicWrite(this.journal,JSON.stringify(job));
      try { await this.finish(job); }
      catch (error) {
        job.rollback = true;
        try { await atomicWrite(this.journal,JSON.stringify(job)); await this.finish(job); }
        catch { this.warning='文件改名未完全恢复，请关闭占用文件的程序后重启。恢复前暂不能继续改名。'; }
        if (this.warning) throw new ApiError(this.warning,409);
        throw new ApiError(error instanceof ApiError ? error.message : '改名失败，原文件已保留。请关闭 Word / WPS，检查目录权限及磁盘是否支持硬链接后重试。',409);
      }
      return {id:fileId(destination),path:destination,name:path.basename(destination),kind:current.kind};
    });
  }
}
