// Shared setup for the v0.1 eval: a temp app repo, a bootstrapped fake Notion, example config.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInit } from '../../plugins/arima/scripts/src/init.js';
import { Throttle } from '../../plugins/arima/scripts/src/lib/throttle.js';
import { bootstrapTemplate } from '../../plugins/arima/scripts/src/notion/build.js';
import { createNotionPort } from '../../plugins/arima/scripts/src/notion/port.js';
import { FakeNotion } from '../../plugins/arima/scripts/test/fake-notion.js';

const EXAMPLES = path.resolve(import.meta.dirname, '../../examples');

export interface EvalWorld {
  fake: FakeNotion;
  port: ReturnType<typeof createNotionPort>;
  dir: string;
  brief: string;
  env: NodeJS.ProcessEnv;
}

export async function setup(briefFile: string): Promise<EvalWorld> {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);

  const dir = mkdtempSync(path.join(tmpdir(), 'arima-eval-'));
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Eval');
  git('config', 'user.email', 'eval@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# sample app\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  writeFileSync(
    path.join(dir, 'arima.yaml'),
    readFileSync(path.join(EXAMPLES, 'arima.yaml'), 'utf8').replace('"<duplicated template root page id>"', `"${fake.rootId}"`),
  );
  copyFileSync(path.join(EXAMPLES, 'team.yaml'), path.join(dir, 'team.yaml'));
  const brief = path.join(dir, 'brief.md');
  copyFileSync(briefFile, brief);
  return { fake, port, dir, brief, env: { ARIMA_NOTION_TOKEN: 'eval-not-a-token', ARIMA_GITHUB_TOKEN: 'eval-not-a-token' } };
}

export function init(w: EvalWorld) {
  return runInit({ projectDir: w.dir, briefFile: w.brief, port: w.port, env: w.env, now: new Date(2026, 10, 18, 2, 0) });
}
