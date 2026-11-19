import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBrief, describeGaps } from '../src/brief.js';
import { runInitCli, runPauseCli, runStatusCli } from '../src/cli/project-cli.js';
import { readEvents } from '../src/events.js';
import { readLedger } from '../src/ledger.js';
import { Throttle } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { createNotionPort } from '../src/notion/port.js';
import { INIT_EXIT, runInit } from '../src/init.js';
import { setKillSwitch } from '../src/pause.js';
import { runPreflight } from '../src/preflight.js';
import { runLockFile } from '../src/runlock.js';
import { StatusError, buildStatus, formatStatus } from '../src/status.js';
import { pullMirror, readNotionMap } from '../src/notion/mirror.js';
import { EXAMPLES, example, tempDir } from './helpers.js';
import { FakeNotion } from './fake-notion.js';

const ENV = {
  ARIMA_NOTION_TOKEN: 'ntn_not_a_real_token_value',
  ARIMA_GITHUB_TOKEN: 'ghp_placeholder',
};
const NOW = new Date(2026, 10, 18, 2, 0);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function world(over: { profile?: string; gitRepo?: boolean } = {}) {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);

  const dir = tempDir('arima-proj-');
  if (over.gitRepo !== false) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(path.join(dir, 'README.md'), '# app\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  let arima = example('arima.yaml').replace(
    '"<duplicated template root page id>"',
    `"${fake.rootId}"`,
  );
  if (over.profile) arima = arima.replace('profile: client-project', `profile: ${over.profile}`);
  writeFileSync(path.join(dir, 'arima.yaml'), arima);
  copyFileSync(path.join(EXAMPLES, 'team.yaml'), path.join(dir, 'team.yaml'));
  const brief = path.join(dir, 'brief.md');
  copyFileSync(path.join(EXAMPLES, 'brief.md'), brief);
  return { fake, port, dir, brief };
}

const init = (
  w: Awaited<ReturnType<typeof world>>,
  over: Partial<Parameters<typeof runInit>[0]> = {},
) => runInit({ projectDir: w.dir, briefFile: w.brief, port: w.port, env: ENV, now: NOW, ...over });

describe('brief check (spec §8.2)', () => {
  it('accepts the example brief', () => {
    expect(checkBrief(example('brief.md'))).toMatchObject({ ok: true, missing: [], empty: [] });
  });

  it('reports missing and empty sections', () => {
    const c = checkBrief(
      '# B\n## Problem\nText\n## Target users\n<!-- none yet -->\n## Out of scope\nNone\n',
    );
    expect(c.ok).toBe(false);
    expect(c.empty).toEqual(['Target users']);
    expect(c.missing).toEqual([
      'Goals and KPIs',
      'Must-have features',
      'Constraints',
      'Known risks',
    ]);
    expect(describeGaps(c)).toContain(
      'Section "Target users" is empty (write "None" if there is nothing to say)',
    );
  });

  it('treats "None" as content and matches headings loosely', () => {
    const md = [
      '## problem',
      'x',
      '## Target Users',
      'x',
      '## Goals & KPIs',
      'x',
      '## Must have features',
      'x',
      '## Out of scope',
      'None',
      '## Constraints',
      'x',
      '## Known risks',
      'None',
    ].join('\n');
    expect(checkBrief(md).ok).toBe(true);
  });
});

describe('runInit end to end (mocked Notion, real git)', () => {
  it('maps the workspace, writes brief, charter, budget plan and G0-G4, leaves a ledger row and events on the state branch', async () => {
    const w = await world();
    const r = await init(w);
    expect(r).toMatchObject({ ok: true, exitCode: 0, gaps: [], problems: [] });
    expect(r.created).toEqual([
      'Project brief',
      'Charter',
      'Budget plan',
      'G0 gate page',
      'G1 gate page',
      'G2 gate page',
      'G3 gate page',
      'G4 gate page',
    ]);

    // Notion
    for (const title of ['Project brief', 'Charter', 'Budget plan']) {
      const row = w.fake.rowByTitle('Documents', title)!;
      expect(row, title).toBeDefined();
      expect(w.fake.text(row, 'Last written by run')).toBe(r.runId);
      expect((w.fake.pages.get(row.id) ?? []).length).toBeGreaterThan(0);
    }
    expect(w.fake.rowByTitle('Documents', 'Charter')!.properties['Type']).toMatchObject({
      select: { name: 'Charter' },
    });
    const charter = JSON.stringify(w.fake.pages.get(w.fake.rowByTitle('Documents', 'Charter')!.id));
    expect(charter).toContain('Roles and responsibilities');
    expect(charter).toContain('Client Contact'); // RACI from team.yaml

    const g0 = w.fake.rowByTitle('Gates', 'G0')!;
    expect(g0.properties['Status']).toMatchObject({ select: { name: 'Not ready' } });
    expect(g0.properties['Approvers']).toBeUndefined(); // human-only: never written by init
    const blocks = w.fake.pages.get(g0.id)!;
    const todos = blocks
      .filter((b) => b.type === 'to_do')
      .map((b) => b['to_do'] as { rich_text: { plain_text: string }[]; checked: boolean });
    expect(todos).toHaveLength(5);
    expect(todos[0]).toMatchObject({ checked: true });
    expect(todos[0]?.rich_text[0]?.plain_text).toMatch(/Brief complete/);
    expect(todos[1]?.checked).toBe(false);

    // Local state
    expect(readNotionMap(w.dir).databases).toHaveProperty('gates');
    const ledger = readLedger(w.dir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      run_id: r.runId,
      project: 'TAS',
      phase: 0,
      item: 'none',
      role: 'orchestrator',
      subtype: 'interactive',
      result: 'pass',
      cost_usd: 0,
    });
    const types = readEvents(w.dir).map((e) => e.type);
    expect(types).toContain('run.start');
    expect(types).toContain('run.end');
    expect(types.filter((t) => t === 'notion.push')).toHaveLength(8);
    expect(existsSync(runLockFile(w.dir))).toBe(false);
    expect(
      readdirSync(path.join(w.dir, '.arima', 'outbox')).filter((f) => f.endsWith('.json')),
    ).toEqual([]);

    // State branch holds the ledger and events
    expect(git(w.dir, 'show', 'arima-state:ledger.jsonl')).toContain(r.runId as string);
    expect(git(w.dir, 'show', 'arima-state:events.jsonl')).toContain('"run.end"');
    expect(git(w.dir, 'show', 'arima-state:notion-map.json')).toContain('"gates"');
    expect(git(w.dir, 'log', '-1', '--format=%s', 'arima-state')).toBe(
      `chore(state): run ${r.runId}`,
    );
    expect(git(w.dir, 'status', '--porcelain')).not.toContain('.arima');
  });

  it('is safe to run again: nothing is duplicated and a second ledger row is written', async () => {
    const w = await world();
    await init(w);
    const rows = w.fake.rows.size;
    const r2 = await init(w, { now: new Date(2026, 10, 18, 3, 0) });
    expect(r2.ok).toBe(true);
    expect(r2.created).toEqual([]);
    expect(r2.existed).toHaveLength(8);
    expect(w.fake.rows.size).toBe(rows);
    expect(readLedger(w.dir)).toHaveLength(2);
  });

  it('solo-lite opens only the G1 and G3 gate pages', async () => {
    const w = await world({ profile: 'solo-lite' });
    const r = await init(w);
    expect(r.created.filter((c) => c.endsWith('gate page'))).toEqual([
      'G1 gate page',
      'G3 gate page',
    ]);
    expect(w.fake.rowByTitle('Gates', 'G0')).toBeUndefined();
  });

  it('stops before doing anything when the brief has gaps', async () => {
    const w = await world();
    writeFileSync(w.brief, '# Brief\n## Problem\nSomething\n');
    const calls = w.fake.calls.length;
    const r = await init(w);
    expect(r.exitCode).toBe(INIT_EXIT.briefGaps);
    expect(r.gaps.length).toBe(6);
    expect(w.fake.calls.length).toBe(calls);
    expect(existsSync(path.join(w.dir, '.arima'))).toBe(false);
  });

  it('stops on an invalid config (exit 10)', async () => {
    const w = await world();
    writeFileSync(
      path.join(w.dir, 'team.yaml'),
      example('team.yaml').replace('count: 3', 'count: 9'),
    );
    const r = await init(w);
    expect(r.exitCode).toBe(10);
    expect(r.problems[0]).toMatch(/team\.yaml:\d+: developer\.count/);
  });

  it('refuses to run while the kill switch is on (exit 12) and leaves no ledger row', async () => {
    const w = await world();
    await setKillSwitch({ projectDir: w.dir, on: true, notion: null });
    const r = await init(w);
    expect(r.exitCode).toBe(12);
    expect(readLedger(w.dir)).toEqual([]);
  });

  it('fails with exit 4 and an error ledger row when the workspace does not match the template', async () => {
    const w = await world();
    w.fake.humanDeleteProperty('Stories', 'Attempt');
    const r = await init(w);
    expect(r.exitCode).toBe(INIT_EXIT.mapFailed);
    expect(r.problems.join('\n')).toContain('Stories.Attempt');
    expect(readLedger(w.dir)[0]).toMatchObject({ result: 'error', subtype: 'interactive' });
    expect(existsSync(runLockFile(w.dir))).toBe(false);
  });

  it('fails with exit 5 when Notion cannot take the writes, and a re-run completes them', async () => {
    const w = await world();
    w.fake.failNext = { op: 'pages.create', status: 503, message: 'service unavailable' };
    const r = await init(w);
    expect(r.exitCode).toBe(INIT_EXIT.pushFailed);
    expect(r.problems.join('\n')).toMatch(/deferred/);
    expect(readLedger(w.dir)[0]?.result).toBe('error');
    expect(existsSync(runLockFile(w.dir))).toBe(false);

    const again = await init(w, { now: new Date(2026, 10, 18, 3, 0) });
    expect(again.ok).toBe(true);
    expect(w.fake.rowByTitle('Documents', 'Charter')).toBeDefined();
  });

  it('works without a git repo when state is skipped, and warns when it is not', async () => {
    const w = await world({ gitRepo: false });
    const skipped = await init(w, { skipState: true });
    expect(skipped.ok).toBe(true);
    const w2 = await world({ gitRepo: false });
    const warned = await init(w2);
    expect(warned.ok).toBe(true);
    expect(warned.exitCode).toBe(INIT_EXIT.stateNotSaved);
    expect(warned.warnings.join('\n')).toContain('state not saved');
  });
});

describe('buildStatus / arima-status', () => {
  it('reports phase 0, gate pages, an empty board and the budget after init', async () => {
    const w = await world();
    await init(w);
    const s = buildStatus(w.dir, NOW);
    expect(s.project).toEqual({ key: 'TAS', name: 'Tasty App', profile: 'client-project' });
    expect(s.phase).toBe('0 Initiation');
    expect(s.gates).toEqual(
      ['G0', 'G1', 'G2', 'G3', 'G4'].map((gate) => ({ gate, status: 'Not ready' })),
    );
    expect(s.board['Backlog']).toBe(0);
    expect(s.budget).toMatchObject({ projectSpent: 0, projectCap: 500, dailyCap: 15, ok: true });
    expect(s.runs).toMatchObject({ total: 1, failed: 0, paused: 0 });
    expect(s.paused).toBe(false);
    const text = formatStatus(s);
    expect(text).toContain('Tasty App (TAS)');
    expect(text).toContain('G0  Not ready');
  });

  it('advances the phase when gates are approved in Notion, and lists blocking questions first', async () => {
    const w = await world();
    await init(w);
    const map = readNotionMap(w.dir);
    w.fake.humanEdit(w.fake.rowByTitle('Gates', 'G0')!.id, {
      Status: { select: { name: 'Approved' } },
    });
    const qs = map.databases['questions']!.data_source_id;
    const mk = (id: string, blocking: boolean) =>
      w.fake.client.pages.create({
        parent: { type: 'data_source_id', data_source_id: qs },
        properties: {
          ID: { title: [{ type: 'text', text: { content: id } }] },
          Question: { rich_text: [{ type: 'text', text: { content: `What about ${id}?` } }] },
          Blocking: { checkbox: blocking },
          Status: { select: { name: 'Open' } },
        },
      });
    await mk('Q-001', false);
    await mk('Q-002', true);
    await pullMirror(w.dir, w.port, map, { now: NOW });
    const s = buildStatus(w.dir, NOW);
    expect(s.phase).toBe('1 Discovery and requirements');
    expect(s.gates[0]).toEqual({ gate: 'G0', status: 'Approved' });
    expect(s.questions).toMatchObject({ open: 2, blocking: 1 });
    expect(s.questions.top.map((q) => q.id)).toEqual(['Q-002', 'Q-001']);
  });

  it('says so when there is no mirror, shows the PAUSE flag, and rejects an invalid config', async () => {
    const w = await world();
    const s = buildStatus(w.dir, NOW);
    expect(s.phase).toMatch(/unknown/);
    expect(s.warnings.join()).toMatch(/no Notion mirror/);
    await setKillSwitch({ projectDir: w.dir, on: true, notion: null });
    expect(buildStatus(w.dir, NOW).paused).toBe(true);
    expect(formatStatus(buildStatus(w.dir, NOW))).toContain('[PAUSED]');
    writeFileSync(path.join(w.dir, 'arima.yaml'), 'schema_version: 1\n');
    expect(() => buildStatus(w.dir, NOW)).toThrow(StatusError);
  });

  it('the CLI prints text or JSON and exits 10 on invalid config', async () => {
    const w = await world();
    await init(w);
    const run = (argv: string[]) => {
      let out = '';
      let err = '';
      const code = runStatusCli(
        argv,
        { out: (s) => (out += s), err: (s) => (err += s), cwd: w.dir },
        { now: NOW },
      );
      return { code, out, err };
    };
    expect(run([]).out).toContain('Phase: 0 Initiation');
    expect((JSON.parse(run(['--json']).out) as { phase: string }).phase).toBe('0 Initiation');
    writeFileSync(path.join(w.dir, 'team.yaml'), 'nope: [');
    expect(run([]).code).toBe(10);
  });
});

describe('kill switch end to end (spec §11.3)', () => {
  it('pause sets the Notion switch and the PAUSE file, saves state, and preflight then refuses to run', async () => {
    const w = await world();
    await init(w);
    const r = await setKillSwitch({
      projectDir: w.dir,
      on: true,
      reason: 'client call',
      notion: { port: w.port, rootPageId: w.fake.rootId },
      saveState: true,
      now: NOW,
    });
    expect(r).toMatchObject({ paused: true, file: true, notion: 'set' });
    expect(git(w.dir, 'show', 'arima-state:PAUSE')).toContain('client call');
    const pre = await runPreflight({ projectDir: w.dir, env: ENV, notion: w.port, now: NOW });
    expect(pre.exitCode).toBe(12);
    expect(readEvents(w.dir).map((e) => e.type)).toContain('killswitch.on');
  });

  it('resume clears both and preflight passes again', async () => {
    const w = await world();
    await init(w);
    await setKillSwitch({
      projectDir: w.dir,
      on: true,
      notion: { port: w.port, rootPageId: w.fake.rootId },
      saveState: true,
      now: NOW,
    });
    const r = await setKillSwitch({
      projectDir: w.dir,
      on: false,
      notion: { port: w.port, rootPageId: w.fake.rootId },
      saveState: true,
      now: new Date(2026, 10, 18, 4, 0),
    });
    expect(r).toMatchObject({
      paused: false,
      file: false,
      notion: 'set',
      stillPausedInNotion: false,
    });
    expect(git(w.dir, 'ls-tree', '--name-only', 'arima-state')).not.toContain('PAUSE');
    expect((await runPreflight({ projectDir: w.dir, env: ENV, notion: w.port, now: NOW })).ok).toBe(
      true,
    );
    expect(readEvents(w.dir).map((e) => e.type)).toContain('killswitch.off');
  });

  it('pausing still works when Notion is down: the PAUSE file alone stops runs', async () => {
    const w = await world();
    await init(w);
    w.fake.down = true;
    const r = await setKillSwitch({
      projectDir: w.dir,
      on: true,
      notion: { port: w.port, rootPageId: w.fake.rootId },
      saveState: false,
    });
    expect(r).toMatchObject({ paused: true, file: true, notion: 'unreachable' });
    expect(
      (await runPreflight({ projectDir: w.dir, env: ENV, notion: w.port, now: NOW })).exitCode,
    ).toBe(12);
  });

  it('resume tells you when Notion could not be cleared', async () => {
    const w = await world();
    await init(w);
    await setKillSwitch({
      projectDir: w.dir,
      on: true,
      notion: { port: w.port, rootPageId: w.fake.rootId },
      saveState: false,
    });
    w.fake.down = true;
    const r = await setKillSwitch({
      projectDir: w.dir,
      on: false,
      notion: { port: w.port, rootPageId: w.fake.rootId },
      saveState: false,
    });
    expect(r.stillPausedInNotion).toBe(true);
    expect(r.paused).toBe(true);
    expect(existsSync(path.join(w.dir, '.arima', 'PAUSE'))).toBe(false);
  });
});

describe('arima-init / arima-pause CLIs', () => {
  const cli = async <
    T extends (
      argv: string[],
      io: { out: (s: string) => void; err: (s: string) => void; cwd: string },
      deps: never,
    ) => unknown,
  >(
    fn: T,
    argv: string[],
    cwd: string,
    w: Awaited<ReturnType<typeof world>>,
  ) => {
    let out = '';
    let err = '';
    const code = await (fn as unknown as (a: string[], io: object, d: object) => Promise<number>)(
      argv,
      { out: (s: string) => (out += s), err: (s: string) => (err += s), cwd },
      { portFactory: () => w.port, env: ENV, now: NOW },
    );
    return { code, out, err };
  };

  it('init prints what was created and what a human must do next; the token never appears', async () => {
    const w = await world();
    const r = await cli(runInitCli, ['--brief', 'brief.md'], w.dir, w);
    expect(r.code).toBe(0);
    expect(r.out).toContain('init ok');
    expect(r.out).toContain('+ Charter');
    expect(r.out).toContain('set Approvers');
    expect(r.out + r.err).not.toContain(ENV.ARIMA_NOTION_TOKEN);
  });

  it('init lists brief gaps and exits 3; missing args exit 2', async () => {
    const w = await world();
    writeFileSync(w.brief, '## Problem\nx\n');
    const gaps = await cli(runInitCli, ['--brief', 'brief.md'], w.dir, w);
    expect(gaps.code).toBe(3);
    expect(gaps.out).toContain('Section "Known risks" is missing');
    expect((await cli(runInitCli, [], w.dir, w)).code).toBe(2);
    expect((await cli(runInitCli, ['--brief', 'nope.md'], w.dir, w)).code).toBe(2);
  });

  it('pause then resume through the CLI', async () => {
    const w = await world();
    await runInit({ projectDir: w.dir, briefFile: w.brief, port: w.port, env: ENV, now: NOW });
    const on = await cli(runPauseCli, ['--reason', 'freeze'], w.dir, w);
    expect(on.code).toBe(0);
    expect(on.out).toContain('ARIMA is paused');
    expect(existsSync(path.join(w.dir, '.arima', 'PAUSE'))).toBe(true);
    const off = await cli(runPauseCli, ['--resume'], w.dir, w);
    expect(off.code).toBe(0);
    expect(off.out).toContain('ARIMA is resumed');
    expect(existsSync(path.join(w.dir, '.arima', 'PAUSE'))).toBe(false);
  });
});
