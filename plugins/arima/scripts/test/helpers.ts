import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
export const EXAMPLES = path.join(REPO_ROOT, 'examples');
export const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins/arima');

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

/** Bundles src/bin/<name>.ts into a temp dir (like `npm run build`) and returns the .mjs path. */
export async function buildBin(name: string): Promise<string> {
  const { build } = await import('esbuild');
  const outdir = tempDir('arima-bin-');
  await build({
    entryPoints: [path.join(REPO_ROOT, 'plugins/arima/scripts/src/bin', `${name}.ts`)],
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    logLevel: 'silent',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
  return path.join(outdir, `${name}.mjs`);
}
