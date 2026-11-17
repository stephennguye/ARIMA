import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Writes via a temp file and rename so readers never see a half-written file. */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const c = (e as { code?: string }).code;
      // Windows can briefly refuse to replace a file another process just closed.
      if ((c === 'EPERM' || c === 'EACCES' || c === 'EBUSY') && attempt < 20) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}
