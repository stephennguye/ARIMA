import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
export const EXAMPLES = path.join(REPO_ROOT, 'examples');

const made: string[] = [];

afterEach(() => {
  while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true });
});

/** Creates a temp dir that is removed after the test. */
export function tempDir(prefix = 'arima-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function example(name: 'arima.yaml' | 'team.yaml' | 'brief.md'): string {
  return readFileSync(path.join(EXAMPLES, name), 'utf8');
}

/** Writes arima.yaml/team.yaml (examples with optional text replacements) into a temp project. */
export function project(
  edits: { arima?: [string | RegExp, string][]; team?: [string | RegExp, string][] } = {},
  overrides: { arima?: string; team?: string } = {},
): string {
  const dir = tempDir();
  const apply = (text: string, list: [string | RegExp, string][] = []): string => {
    let out = text;
    for (const [from, to] of list) {
      const next = out.replace(from, to);
      if (next === out) throw new Error(`test edit did not match: ${String(from)}`);
      out = next;
    }
    return out;
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'arima.yaml'),
    overrides.arima ?? apply(example('arima.yaml'), edits.arima),
  );
  writeFileSync(
    path.join(dir, 'team.yaml'),
    overrides.team ?? apply(example('team.yaml'), edits.team),
  );
  return dir;
}
