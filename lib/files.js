import { writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Windows readers and antivirus scanners can briefly hold the destination open.
// Only retry the local rename, never a network submission.
export async function atomicWrite(dest, content) {
  const temp = dest + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, content, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, dest); return; }
      catch (e) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 7) throw e;
        await delay(Math.min(20 * 2 ** attempt, 300));
      }
    }
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}
