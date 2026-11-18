import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './lib/atomic-file.js';
import { withFileLock } from './lib/filelock.js';

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `r-YYYYMMDD-HHMM-NN` (spec §2). NN counts runs within the day and never repeats on that day. */
export async function issueRunId(projectDir: string, now: Date = new Date()): Promise<string> {
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const hhmm = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const file = path.join(projectDir, '.arima', 'state', 'run-seq.json');
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    let state: { day: string; last: number } = { day, last: 0 };
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { day?: string; last?: number };
      if (parsed.day === day && Number.isInteger(parsed.last))
        state = { day, last: parsed.last as number };
    }
    state.last += 1;
    writeFileAtomic(file, `${JSON.stringify(state)}\n`);
    return `r-${day}-${hhmm}-${pad(state.last)}`;
  });
}
