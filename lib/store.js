import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './files.js';

export class Store {
  constructor(root) { this.root = root; this.itemsDir = path.join(root, 'items'); }
  async init() { await mkdir(this.itemsDir, { recursive: true }); }
  itemPath(id) {
    if (!/^[a-z0-9-]{1,80}$/i.test(id)) throw new Error('无效记录 ID');
    return path.join(this.itemsDir, id + '.json');
  }
  sourcePath(id) { this.itemPath(id); return path.join(this.root,'sources',id+'.pdf'); }
  async put(item) {
    await atomicWrite(this.itemPath(item.id), JSON.stringify(item));
    return item;
  }
  async get(id) { try { return JSON.parse(await readFile(this.itemPath(id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async list() {
    const entries = await readdir(this.itemsDir);
    const items = await Promise.all(entries.filter(n => n.endsWith('.json')).map(async n => {
      try {
        const i = JSON.parse(await readFile(path.join(this.itemsDir, n), 'utf8'));
        return { id: i.id, title: i.title, createdAt: i.createdAt, kind: i.kind, status: i.status, pdfStatus:i.pdfTask?.status, demo: i.demo, excerpt: (i.mmd || '').slice(0, 110) };
      } catch { return null; }
    }));
    return items.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async remove(id) { await rm(this.itemPath(id), { force: true }); await rm(this.sourcePath(id),{force:true}); }
}
