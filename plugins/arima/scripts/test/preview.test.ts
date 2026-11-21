// WP-218: previews for stories In Review. The host runs arima-env up preview-<pr>; a preview that does not
// answer is recorded with its error and diagnosed; a merged or closed one is removed. Docker is a fake
// that records every call (git is real, on a real temp repository).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEnvState, settingsFrom } from '../src/env.js';
import type { EnvDeps } from '../src/env.js';
import { readEvents } from '../src/events.js';
import {
  branchSha,
  ensurePreviews,
  failedPreviews,
  previewHealthy,
  previewOf,
  previewUrl,
  previewsPossible,
  removePreview,
  sweepPreviews,
} from '../src/preview.js';
import { planDay } from '../src/queue.js';
import type { StoryFacts } from '../src/queue.js';
import { realExec } from '../src/sandbox.js';
import type { Exec, ExecResult } from '../src/sandbox.js';
import { project, tempDir } from './helpers.js';

const COMPOSE = `services:
  web:
    build: ..
    image: arima-local/\${ARIMA_PROJECT}-web:\${ARIMA_TAG}
    ports: ["127.0.0.1:\${ARIMA_PORT}:8080"]
    healthcheck: { test: ["CMD", "true"] }
    mem_limit: 256m
`;

/** An app repo on main with a compose file and a story branch `feat/US-12-x` carrying one commit. */
function app(withCompose = true): { dir: string; git: (...a: string[]) => string } {
  const dir = project({ arima: [['https://staging.example.com', 'http://localhost:3099']] });
  const git = (...a: string[]): string =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
  if (withCompose) {
    mkdirSync(path.join(dir, 'infra'), { recursive: true });
    writeFileSync(path.join(dir, 'infra', 'compose.yaml'), COMPOSE);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'feat/US-12-x');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat(US-12): a');
  git('checkout', '-q', 'main');
  return { dir, git };
}

function fake(opts: { bad?: () => boolean } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const state = { up: false };
  const exec: Exec = async (file, args, o) => {
    calls.push({ file, args });
    if (file === 'git') return realExec(file, args, o);
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'info') return ok('27.0.1');
    if (args[0] === 'compose') {
      if (args.includes('ps'))
        return ok(
          state.up
            ? `${JSON.stringify({ ID: 'a', Service: 'web', State: 'running', Health: 'healthy' })}\n`
            : '',
        );
      if (args.includes('down')) state.up = false;
      if (args.includes('up')) state.up = true;
    }
    return ok();
  };
  const fetchFn = (async () => ({ status: opts.bad?.() ? 500 : 200 })) as unknown as typeof fetch;
  return { calls, state, exec, fetchFn };
}

const deps = (f: ReturnType<typeof fake>, extra: Partial<EnvDeps> = {}): EnvDeps => ({
  exec: f.exec,
  fetch: f.fetchFn,
  sleep: () => Promise.resolve(),
  portFree: () => Promise.resolve(true),
  home: tempDir('arima-home-'),
  ...extra,
});

const item = { item: 'US-12', pr: 7, branch: 'feat/US-12-x' };
const settings = (dir: string) =>
  settingsFrom(dir, { github: { default_branch: 'main' }, project: { key: 'TAS' } });

describe('ensurePreviews', () => {
  it('brings up preview-<pr> from the story branch and records a healthy preview with its port', async () => {
    const a = app();
    const f = fake();
    const [r] = await ensurePreviews(settings(a.dir), [item], deps(f));
    expect(r).toMatchObject({ pr: 7, item: 'US-12', result: 'up' });
    expect(r?.url).toMatch(/^http:\/\/localhost:41\d\d$/);
    const rec = previewOf(a.dir, 7);
    expect(rec).toMatchObject({ ok: true, project: 'tas-preview-7' });
    expect(rec?.ref).toBe(branchSha(a.dir, 'feat/US-12-x'));
    expect(previewHealthy(a.dir, 7, branchSha(a.dir, 'feat/US-12-x'))).toBe(true);
    expect(previewUrl(rec?.port ?? 0)).toBe(r?.url);
    expect(
      readEvents(a.dir).some((e) => e.type === 'deploy.preview' && e.data?.['ok'] === true),
    ).toBe(true);
  });

  it('leaves a preview that is healthy at the current commit alone, and rebuilds after a new commit', async () => {
    const a = app();
    const f = fake();
    await ensurePreviews(settings(a.dir), [item], deps(f));
    const ups = () => f.calls.filter((c) => c.args.includes('up')).length;
    const before = ups();
    expect((await ensurePreviews(settings(a.dir), [item], deps(f)))[0]?.result).toBe('unchanged');
    expect(ups()).toBe(before);
    a.git('checkout', '-q', 'feat/US-12-x');
    writeFileSync(path.join(a.dir, 'b.txt'), 'b\n');
    a.git('add', '-A');
    a.git('commit', '-q', '-m', 'feat(US-12): b');
    a.git('checkout', '-q', 'main');
    expect((await ensurePreviews(settings(a.dir), [item], deps(f)))[0]?.result).toBe('up');
    expect(ups()).toBeGreaterThan(before);
  });

  it('a preview that does not answer is recorded as failed with its error, and listed for diagnosis', async () => {
    const a = app();
    const f = fake({ bad: () => true });
    const [r] = await ensurePreviews(settings(a.dir), [item], deps(f));
    expect(r?.result).toBe('failed');
    expect(r?.error).toMatch(/smoke test failed/);
    expect(previewOf(a.dir, 7)).toMatchObject({ ok: false });
    expect(previewHealthy(a.dir, 7)).toBe(false);
    expect(failedPreviews(a.dir)).toEqual([
      {
        pr: 7,
        ref: branchSha(a.dir, 'feat/US-12-x'),
        error: expect.stringMatching(/smoke test failed/),
      },
    ]);
    expect(readEnvState(a.dir).previews['7']?.error).toMatch(/smoke test failed/);
    expect(
      readEvents(a.dir).some((e) => e.type === 'deploy.preview' && e.data?.['ok'] === false),
    ).toBe(true);
  });

  it('a later good deploy replaces the failed record', async () => {
    const a = app();
    let bad = true;
    const f = fake({ bad: () => bad });
    await ensurePreviews(settings(a.dir), [item], deps(f));
    expect(failedPreviews(a.dir)).toHaveLength(1);
    bad = false;
    expect((await ensurePreviews(settings(a.dir), [item], deps(f)))[0]?.result).toBe('up');
    expect(failedPreviews(a.dir)).toEqual([]);
    expect(previewOf(a.dir, 7)?.error).toBeUndefined();
  });

  it('skips quietly with no compose file, with the kill switch on, and for a branch that does not exist', async () => {
    const none = app(false);
    expect(previewsPossible(settings(none.dir))).toBe(false);
    expect((await ensurePreviews(settings(none.dir), [item], deps(fake())))[0]?.result).toBe(
      'skipped',
    );
    const a = app();
    const f = fake();
    expect(
      (
        await ensurePreviews(
          settings(a.dir),
          [item],
          deps(f, { isPaused: () => Promise.resolve(true) }),
        )
      )[0]?.result,
    ).toBe('skipped');
    expect(f.calls.filter((c) => c.args.includes('up'))).toEqual([]);
    expect(
      (await ensurePreviews(settings(a.dir), [{ ...item, branch: 'feat/nope' }], deps(f)))[0]
        ?.result,
    ).toBe('skipped');
  });

  it('respects max_previews: the oldest is removed when a fourth arrives', async () => {
    const a = app();
    const f = fake();
    for (const pr of [1, 2, 3, 4]) {
      await ensurePreviews(
        settings(a.dir),
        [{ item: 'US-12', pr, branch: 'feat/US-12-x' }],
        deps(f),
      );
    }
    expect(Object.keys(readEnvState(a.dir).previews).sort()).toEqual(['2', '3', '4']);
  });
});

describe('removePreview', () => {
  it('takes the containers and volumes down and forgets the preview; nothing to do for an unknown PR', async () => {
    const a = app();
    const f = fake();
    await ensurePreviews(settings(a.dir), [item], deps(f));
    expect(await removePreview(settings(a.dir), 7, deps(f))).toBe(true);
    expect(previewOf(a.dir, 7)).toBeUndefined();
    const down = f.calls.find((c) => c.args.includes('down'));
    expect(down?.args).toContain('--volumes');
    expect(await removePreview(settings(a.dir), 99, deps(f))).toBe(false);
  });
});

describe('the queue plans a diagnosis for a failed preview', () => {
  const story = (id: string): StoryFacts => ({
    id,
    status: 'In Review',
    attempt: 1,
    testCases: 1,
    openBugs: 0,
    budgetOk: true,
    size: 'S',
  });
  it('one preview-diagnose unit for devops per failing story, ahead of new stories, none otherwise', () => {
    const limits = {
      maxDevelopers: 1,
      maxPrsAwaitingHuman: 5,
      prsAwaitingHuman: 0,
      reviewers: 1 as const,
    };
    const plan = planDay(
      { stories: [story('US-12'), story('US-13')], previewsFailing: [{ item: 'US-12', pr: 7 }] },
      limits,
    );
    const diag = plan.units.filter((u) => u.kind === 'preview-diagnose');
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({ role: 'devops', item: 'US-12' });
    expect(diag[0]?.why).toContain('PR #7');
    expect(
      planDay({ stories: [story('US-12')] }, limits).units.some(
        (u) => u.kind === 'preview-diagnose',
      ),
    ).toBe(false);
  });
});

describe('sweepPreviews: a merged, accepted, released or cancelled story keeps no preview', () => {
  it('removes exactly the previews whose story is over, and leaves the others', async () => {
    const a = app();
    const f = fake();
    for (const pr of [1, 2, 3])
      await ensurePreviews(
        settings(a.dir),
        [{ item: 'US-12', pr, branch: 'feat/US-12-x' }],
        deps(f),
      );
    const status: Record<string, string> = {
      'US-1': 'PO Acceptance',
      'US-2': 'In QA',
      'US-3': 'Cancelled',
    };
    const removed = await sweepPreviews(
      settings(a.dir),
      { 1: 'US-1', 2: 'US-2', 3: 'US-3' },
      (i) => status[i],
      deps(f),
    );
    expect(removed.sort()).toEqual([1, 3]);
    expect(Object.keys(readEnvState(a.dir).previews)).toEqual(['2']);
  });
  it('a preview whose PR is unknown is left alone', async () => {
    const a = app();
    const f = fake();
    await ensurePreviews(settings(a.dir), [item], deps(f));
    expect(await sweepPreviews(settings(a.dir), {}, () => 'Done', deps(f))).toEqual([]);
    expect(previewOf(a.dir, 7)).toBeDefined();
  });
});
