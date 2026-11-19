// Stage 0A: secrets stay out of Notion and agents' environments; dispatch re-checks hard stops;
// a hung run's whole process tree is killed (judge blockers 5, majors 10-14).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentCli } from '../src/cli/run-agent-cli.js';
import { runInitCli } from '../src/cli/project-cli.js';
import { readEvents } from '../src/events.js';
import { findSecrets } from '../src/lib/secrets.js';
import { Throttle } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { enqueue, pushOutbox } from '../src/notion/outbox.js';
import type { PushReport } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import { setKillSwitch } from '../src/pause.js';
import { appendLedgerRow, buildLedgerRow, parseClaudeResult } from '../src/ledger.js';
import { DispatchRefused, childEnv, runAgent } from '../src/run-agent.js';
import { ROLES } from '../src/roles.js';
import type { AgentConfig } from '../src/run-agent.js';
import { FakeNotion } from './fake-notion.js';
import { REPO_ROOT, example, project, tempDir } from './helpers.js';

/** Pushes hand-made entries: no run binding or id issuance (those are WP-104's own tests). */
const pushHandMade = (
  dir: Parameters<typeof pushOutbox>[0],
  port: Parameters<typeof pushOutbox>[1],
  map: Parameters<typeof pushOutbox>[2],
  opts: Parameters<typeof pushOutbox>[3] = {},
): Promise<PushReport> => pushOutbox(dir, port, map, { bindRuns: false, ...opts });

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-claude.mjs');

describe('secret scanner', () => {
  it.each([
    ['slack', 'xoxb-1234567890-abcdefghijkl'],
    ['stripe', 'sk_live_abcdefghijklmnop1234'],
    ['google', `AIza${'a'.repeat(35)}`],
    ['jwt', `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`],
    ['npm', `npm_${'a'.repeat(36)}`],
    ['bearer', 'Authorization: Bearer Zk3pQ9vXw2LmN8aR5tY7uB1cD4eF6gH0'],
    ['assignment', 'DATABASE_API_KEY=abcdefghijklmnopqrstuvwxyz12'],
    ['yaml password', 'password: "correct-horse-battery-staple-1"'],
    ['notion', `ntn_${'a'.repeat(30)}`],
    ['github', `ghp_${'a'.repeat(30)}`],
  ])('finds a %s credential', (_n, text) => {
    expect(findSecrets(`some text ${text} more text`).length).toBeGreaterThan(0);
  });

  it('still finds a secret that follows a newline once the text has been JSON-encoded', () => {
    const tok = `ghp_${'q'.repeat(30)}`;
    for (const text of [
      `# Notes

${tok}`,
      `line one
${tok}`,
      `a	${tok}`,
    ]) {
      expect(findSecrets(JSON.stringify({ c: text })), JSON.stringify(text)).toContain(
        'github token',
      );
      expect(findSecrets(text)).toContain('github token');
    }
  });

  it('does not flag ordinary project text, config or templates', () => {
    for (const text of [
      'token_env: ARIMA_NOTION_TOKEN',
      'The password policy requires 12 characters and a symbol.',
      'US-112 added checkout summary, cost 1.87',
      example('arima.yaml'),
      example('team.yaml'),
      example('brief.md'),
    ]) {
      expect(findSecrets(text), text.slice(0, 40)).toEqual([]);
    }
    const tdir = path.join(REPO_ROOT, 'plugins', 'arima', 'templates');
    for (const f of readdirSync(tdir))
      expect(findSecrets(readFileSync(path.join(tdir, f), 'utf8')), f).toEqual([]);
  });
});

describe('secrets never reach Notion', () => {
  async function world() {
    const fake = new FakeNotion();
    const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
    await bootstrapTemplate(port, fake.rootId);
    const map = (await mapWorkspace(port, fake.rootId)).map!;
    return { fake, port, map, dir: tempDir() };
  }
  const entry = (extra: object) => ({
    id: 'ob-1',
    created_at: '2026-11-18T00:00:01.000Z',
    run_id: 'r-20261118-0200-01',
    role: 'orchestrator',
    op: 'create' as const,
    database: 'documents' as const,
    ...extra,
  });

  it('enqueue refuses an entry whose properties or content look like a secret', () => {
    const dir = tempDir();
    const tok = `ghp_${'q'.repeat(30)}`;
    expect(() => enqueue(dir, entry({ properties: { Title: `key ${tok}` } }))).toThrow(/secret/);
    expect(() =>
      enqueue(
        dir,
        entry({ id: 'ob-2', properties: { Title: 'x' }, content_markdown: `# Notes\n\n${tok}` }),
      ),
    ).toThrow(/secret/);
    expect(existsSync(path.join(dir, '.arima', 'outbox'))).toBe(false);
  });

  it('push rejects a hand-written entry carrying a secret, and writes nothing', async () => {
    const { fake, port, map, dir } = await world();
    const outbox = path.join(dir, '.arima', 'outbox');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(outbox, { recursive: true });
    writeFileSync(
      path.join(outbox, 'ob-1.json'),
      JSON.stringify(
        entry({ properties: { Title: 'Leaky' }, content_markdown: `ntn_${'z'.repeat(30)}` }),
      ),
    );
    const r = await pushHandMade(dir, port, map);
    expect(r.applied).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/contains a secret/);
    expect(fake.rows.size).toBe(0);
    expect(readFileSync(path.join(dir, '.arima', 'events.jsonl'), 'utf8')).not.toContain('ntn_');
  });

  it('init stops, with exit 6, when the brief contains a credential, before touching Notion', async () => {
    const { fake, port } = await world();
    const proj = project({ arima: [['"<duplicated template root page id>"', `"${fake.rootId}"`]] });
    writeFileSync(
      path.join(proj, 'brief.md'),
      `${example('brief.md')}\n\nOur key is ${`ghp_${'k'.repeat(30)}`}\n`,
    );
    const calls = fake.calls.length;
    let out = '';
    const code = await runInitCli(
      ['--brief', 'brief.md'],
      { out: (s) => (out += s), err: () => undefined, cwd: proj },
      { portFactory: () => port, env: { ARIMA_NOTION_TOKEN: 'x', ARIMA_GITHUB_TOKEN: 'y' } },
    );
    expect(code).toBe(6);
    expect(out).toContain('contains a secret');
    expect(out).not.toContain('kkkkkkkk');
    expect(fake.calls.length).toBe(calls);
    expect(existsSync(path.join(proj, '.arima'))).toBe(false);
  });
});

describe('an agent cannot hide a human edit by choosing its own baseline', () => {
  it('a base_last_edited far in the future is ignored in favour of the mirror', async () => {
    const fake = new FakeNotion();
    const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
    await bootstrapTemplate(port, fake.rootId);
    const map = (await mapWorkspace(port, fake.rootId)).map!;
    const dir = tempDir();
    const mk = (id: string, op: 'create' | 'update', extra: object) => ({
      id,
      created_at: `2026-11-18T00:00:0${id.endsWith('1') ? 1 : 2}.000Z`,
      run_id: 'r-20261118-0200-01',
      role: 'orchestrator',
      op,
      database: 'stories' as const,
      ...extra,
    });
    enqueue(dir, mk('e-1', 'create', { properties: { ID: 'US-001', Title: 'orig' } }));
    await pushHandMade(dir, port, map);
    const row = fake.rowByTitle('Stories', 'US-001')!;
    fake.humanEdit(row.id, {
      Title: { rich_text: [{ type: 'text', text: { content: 'human' } }] },
    });
    enqueue(
      dir,
      mk('e-2', 'update', {
        item_id: 'US-001',
        base_last_edited: '2099-01-01T00:00:00.000Z',
        properties: { Title: 'agent' },
      }),
    );
    const r = await pushHandMade(dir, port, map);
    expect(r.conflicts).toEqual(['e-2']);
    expect(fake.text(row, 'Title')).toBe('human');
  });
});

describe('the child environment is an allow-list (spec §11.3)', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/bin',
    HOME: '/home/u',
    LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'sk-ant-not-real',
    AWS_SECRET_ACCESS_KEY: 'aws-not-real',
    DATABASE_URL: 'postgres://u:p@h/db',
    STRIPE_SECRET_KEY: 'sk_live_not_real',
    NPM_TOKEN: 'npm-not-real',
    SOME_RANDOM_VAR: 'x',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-seat-credential',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    ARIMA_NOTION_TOKEN: 'notion-not-real',
    ARIMA_GITHUB_TOKEN: 'github-not-real',
  };
  const cfg: AgentConfig = {
    projectKey: 'TAS',
    perRunCap: 2,
    maxRunMinutes: 1,
    notionTokenEnv: 'ARIMA_NOTION_TOKEN',
    projectCap: 100,
    dailyCap: 20,
    githubTokenEnv: 'ARIMA_GITHUB_TOKEN',
    auth: 'seat',
  };
  const env = (role: Parameters<typeof childEnv>[1]['role'], config: AgentConfig = cfg) =>
    childEnv(base, {
      role,
      item: 'US-1',
      phase: 4,
      runId: 'r-1',
      projectKey: 'TAS',
      config,
      projectDir: '/proj',
    });

  it('passes the basics and nothing else to a role that needs no tokens', () => {
    const e = env('qa');
    expect(e['PATH']).toBe('/bin');
    expect(e['HOME']).toBe('/home/u');
    expect(e['LANG']).toBe('en_US.UTF-8');
    for (const secret of [
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'DATABASE_URL',
      'STRIPE_SECRET_KEY',
      'NPM_TOKEN',
      'SOME_RANDOM_VAR',
      'ARIMA_NOTION_TOKEN',
      'ARIMA_GITHUB_TOKEN',
      'GH_TOKEN',
    ]) {
      expect(e[secret], secret).toBeUndefined();
    }
  });

  it('keeps what claude itself needs (CLAUDE_*, OTEL_*) and sets ARIMA control variables', () => {
    const e = env('qa');
    expect(e['CLAUDE_CODE_OAUTH_TOKEN']).toBe('claude-seat-credential');
    expect(e['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://localhost:4318');
    expect(e).toMatchObject({
      ARIMA_ROLE: 'qa',
      ARIMA_RUN_ID: 'r-1',
      ARIMA_ITEM: 'US-1',
      ARIMA_PROJECT_DIR: '/proj',
    });
  });

  it('gives the orchestrator the Notion token and no role a GitHub token (D-49)', () => {
    expect(env('orchestrator')['ARIMA_NOTION_TOKEN']).toBe('notion-not-real');
    expect(env('orchestrator')['ARIMA_GITHUB_TOKEN']).toBeUndefined();
    for (const role of ROLES) {
      expect(env(role)['ARIMA_GITHUB_TOKEN'], role).toBeUndefined();
      expect(env(role)['GH_TOKEN'], role).toBeUndefined();
      expect(env(role)['GITHUB_TOKEN'], role).toBeUndefined();
      if (role !== 'orchestrator') expect(env(role)['ARIMA_NOTION_TOKEN'], role).toBeUndefined();
    }
  });

  it('passes ANTHROPIC_* only when the project authenticates with an API key', () => {
    expect(env('qa', { ...cfg, auth: 'api_key' })['ANTHROPIC_API_KEY']).toBe('sk-ant-not-real');
    expect(env('qa', { ...cfg, auth: 'seat' })['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('is case-insensitive about names, as Windows environments are', () => {
    const e = childEnv(
      { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', Random: 'x' },
      { role: 'qa', item: 'none', phase: 0, runId: 'r', projectKey: 'T', config: cfg },
    );
    expect(e['Path']).toBe('C:\\bin');
    expect(e['SystemRoot']).toBe('C:\\Windows');
    expect(e['Random']).toBeUndefined();
  });
});

describe('dispatch re-checks the hard stops itself', () => {
  const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
    projectKey: 'TAS',
    perRunCap: 2,
    maxRunMinutes: 1,
    notionTokenEnv: 'ARIMA_NOTION_TOKEN',
    projectCap: 100,
    dailyCap: 15,
    ...over,
  });
  const go = (dir: string, over: Partial<Parameters<typeof runAgent>[0]> = {}) => {
    const prompt = path.join(dir, 'p.md');
    writeFileSync(prompt, 'hello');
    return runAgent({
      projectDir: dir,
      role: 'qa',
      item: 'US-1',
      budgetUsd: 1,
      maxTurns: 3,
      promptFile: prompt,
      phase: 4,
      killSwitch: { notion: null },
      config: config(),
      claudeBin: STUB,
      env: process.env,
      now: new Date(2026, 10, 18, 2, 0),
      ...over,
    });
  };

  it('refuses to start while the PAUSE file exists, spawning nothing and recording a hard stop', async () => {
    const dir = project();
    await setKillSwitch({ projectDir: dir, on: true, notion: null });
    await expect(
      go(dir, { extraEnv: { STUB_RECORD: path.join(dir, 'rec.json') } }),
    ).rejects.toMatchObject({ exitCode: 12 });
    expect(existsSync(path.join(dir, 'rec.json'))).toBe(false);
    expect(readEvents(dir).find((e) => e.type === 'hardstop.hit')?.data).toMatchObject({
      stop: 'kill_switch',
    });
  });

  it('refuses when the daily or project budget is used up', async () => {
    const dir = project();
    const row = buildLedgerRow(
      parseClaudeResult(
        readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude', 'success.json'), 'utf8'),
      ),
      {
        run_id: 'r-20261118-0100-01',
        date: '2026-11-18',
        project: 'TAS',
        phase: 4,
        item: 'US-1',
        role: 'qa',
        attempt: 1,
        is_rework: false,
        budget_usd: 2,
      },
    );
    await appendLedgerRow(dir, { ...row, cost_usd: 15 });
    const refused = go(dir);
    await expect(refused).rejects.toBeInstanceOf(DispatchRefused);
    await expect(go(dir)).rejects.toMatchObject({ exitCode: 13 });
    expect(readEvents(dir).find((e) => e.type === 'hardstop.hit')?.data).toMatchObject({
      stop: 'budget_exceeded',
    });
    // a different day is fine
    await expect(go(dir, { now: new Date(2026, 10, 19, 2, 0) })).resolves.toMatchObject({
      result: 'pass',
    });
  });

  it('the CLI maps refusals to the same exit codes as preflight', async () => {
    const dir = project();
    writeFileSync(path.join(dir, 'p.md'), 'hello');
    await setKillSwitch({ projectDir: dir, on: true, notion: null });
    process.env['ARIMA_CLAUDE_BIN'] = STUB;
    try {
      const code = await runAgentCli(
        [
          '--role',
          'qa',
          '--item',
          'US-1',
          '--budget',
          '1',
          '--max-turns',
          '3',
          '--prompt-file',
          'p.md',
        ],
        { out: () => undefined, err: () => undefined, cwd: dir },
      );
      expect(code).toBe(12);
    } finally {
      delete process.env['ARIMA_CLAUDE_BIN'];
    }
  });
});

describe('a timed-out run takes its whole process tree with it', () => {
  it('kills the grandchild too (Windows taskkill /T, POSIX process group)', async () => {
    const dir = tempDir();
    const prompt = path.join(dir, 'p.md');
    writeFileSync(prompt, 'x');
    const pidFile = path.join(dir, 'grandchild.pid');
    const out = await runAgent({
      projectDir: project(),
      role: 'qa',
      item: 'US-1',
      budgetUsd: 1,
      maxTurns: 3,
      promptFile: prompt,
      phase: 4,
      killSwitch: { notion: null },
      config: {
        projectKey: 'TAS',
        perRunCap: 2,
        maxRunMinutes: 0.06,
        notionTokenEnv: 'ARIMA_NOTION_TOKEN',
        projectCap: 100,
        dailyCap: 20,
      },
      claudeBin: STUB,
      env: process.env,
      extraEnv: { STUB_MODE: 'hang_tree', STUB_PIDFILE: pidFile },
    });
    expect(out.subtype).toBe('timeout');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 30_000);
});
