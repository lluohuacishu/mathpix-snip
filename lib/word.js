import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, conversionState } from './mathpix.js';
import { atomicWrite } from './files.js';

export const wordHash = mmd => createHash('sha256').update(mmd || '').digest('hex');

// Official conversion only. Download promptly: Mathpix conversion outputs are ephemeral.
export class WordExports {
  constructor({ store, client, update, pollMs = 2000, maxPolls = 150 }) {
    Object.assign(this, { store, client, update, pollMs, maxPolls });
    this.jobs = new Map(); this.abort = new AbortController();
    this.directory = path.join(store.root, 'word');
  }
  cachePath(id, hash) {
    this.store.itemPath(id);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ApiError('Word 缓存版本无效。');
    return path.join(this.directory, id, hash + '.docx');
  }
  async cached(item) {
    const hash = wordHash(item.mmd);
    if (item.word?.status !== 'completed' || item.word.hash !== hash) return null;
    try { return await readFile(this.cachePath(item.id, hash)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  status(item) {
    if (item.word?.hash !== wordHash(item.mmd)) return { status: 'not_started' };
    return { status: item.word.status, error: item.word.error };
  }
  start(id) {
    if (this.abort.signal.aborted) return;
    if (this.jobs.has(id)) {
      // A click after an edit must not return the previous revision's document.
      this.jobs.get(id).again = true; return;
    }
    const job = { again: false };
    this.jobs.set(id, job);
    job.promise = new Promise(resolve => setImmediate(resolve)).then(() => this.run(id, job)).finally(async () => {
      this.jobs.delete(id);
      if (job.again && !this.abort.signal.aborted) {
        const item = await this.store.get(id);
        if (item && job.hash !== wordHash(item.mmd)) this.start(id);
      }
    }).catch(() => {}); // run() persists a user-visible error; no automatic resubmission.
  }
  async run(id, job) {
    let hash;
    try {
      let work;
      await this.update(id, async item => {
        if (!item.mmd?.trim()) return;
        hash = wordHash(item.mmd);
        job.hash = hash;
        if (await this.cached(item)) return;
        // Save the version before submitting, including when a transport error occurs.
        item.word = { status: 'processing', hash }; await this.store.put(item);
        const fromPdf = !!(item.pdfId && item.wordFromPdf && !item.editedAt);
        let jobId = fromPdf ? item.pdfId : item.conversionId;
        if (!jobId) {
          const result = await this.client.convert(item.mmd);
          if (!result.conversion_id) throw new ApiError('未收到 Word 转换任务编号。', 502);
          jobId = item.conversionId = result.conversion_id;
        }
        work = { jobId, fromPdf };
        item.word = { status: 'processing', hash, ...work };
      });
      if (!work) return;
      for (let n = 0; n < this.maxPolls && !this.abort.signal.aborted; n++) {
        const current = await this.store.get(id);
        if (!current || wordHash(current.mmd) !== hash) return;
        const result = await this.client.convertStatus(work.jobId);
        const status = conversionState(result);
        if (status === 'error') throw new ApiError('Mathpix Word 转换失败。识别结果已保留，请校对内容后重试。', 502);
        if (status === 'completed') {
          const buffer = await (work.fromPdf ? this.client.pdfDocx(work.jobId) : this.client.docx(work.jobId));
          if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new ApiError('Mathpix 没有返回有效的 DOCX。', 502);
          await this.update(id, async item => {
            if (wordHash(item.mmd) !== hash) return;
            const dest = this.cachePath(id, hash);
            await mkdir(path.dirname(dest), { recursive: true });
            await atomicWrite(dest, buffer);
            item.word = { status: 'completed', hash, ...work };
          });
          return;
        }
        await delay(this.pollMs, undefined, { signal: this.abort.signal, ref: false });
      }
      if (!this.abort.signal.aborted) throw new ApiError('Word 转换仍未完成。稍后点击“导出 Word”可继续查询已有任务。');
    } catch (e) {
      if (this.abort.signal.aborted) return;
      await this.update(id, item => {
        if (hash && wordHash(item.mmd) === hash) item.word = { ...item.word, hash, status: 'error', error: e.message };
      }).catch(() => {});
    }
  }
  async remove(id) { this.store.itemPath(id); await rm(path.join(this.directory, id), { recursive: true, force: true }); }
  async close() { this.abort.abort(); await Promise.all([...this.jobs.values()].map(j => j.promise)); }
}
