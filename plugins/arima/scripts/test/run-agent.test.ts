import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentCli } from '../src/cli/run-agent-cli.js';
import { validateProject } from '../src/config.js';
import { readEvents } from '../src/events.js';
import { readLedger } from '../src/ledger.js';
import { EXIT, agentConfigFrom, childEnv, runAgent } from '../src/run-agent.js';
import type { AgentConfig, RunAgentOptions } from '../src/run-agent.js';
import { allowedTools, deniedTools } from '../src/roles.js';
import { EXAMPLES, project, tempDir } from './helpers.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-claude.mjs');

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  projectKey: 'TAS',
  perRunCap: 2,
  maxRunMinutes: 1,
  notionTokenEnv: 'ARIMA_NOTION_TOKEN',
  githubTokenEnv: 'ARIMA_GITHUB_TOKEN',
  ...over,
});

interface Setup {
  dir: string;
  record: string;
  prompt: string;
}

function setup(promptText = 'Implement US-112.'): Setup {
  const dir = tempDir();
  const prompt = path.join(dir, 'prompt.md');
  writeFileSync(prompt, promptText);
  return { dir, record: path.join(dir, 'record.json'), prompt };
}

const recorded = (
  s: Setup,
): {
  argv: string[];
  stdin: string;
  cwd: string;
  otel: string | null;
  hasNotionToken: boolean;
  hasGithubToken: boolean;
} => JSON.parse(readFileSync(s.record, 'utf8'));

function go(
  s: Setup,
  mode: string,
  over: Partial<RunAgentOptions> = {},
  extraEnv: Record<string, string> = {},
) {
  return runAgent({
    projectDir: s.dir,
    role: 'developer',
    item: 'US-112',
    budgetUsd: 1,
    maxTurns: 10,
    promptFile: s.prompt,
    phase: 4,
    config: config(),
    claudeBin: STUB,
    env: {
      ...process.env,
      STUB_MODE: mode,
      STUB_RECORD: s.record,
      ARIMA_NOTION_TOKEN: 'placeholder-not-a-real-token',
      ARIMA_GITHUB_TOKEN: 'placeholder-not-a-real-token',
      ...extraEnv,
    },
    now: new Date(2026, 10, 17, 6, 3),
    ...over,
  });
}

describe('runAgent: a normal run', () => {
  it('invokes claude with caps, tools and the prompt, and records ledger + events', async () => {
    const s = setup();
    const worktree = path.join(s.dir, 'wt');
    mkdirSync(worktree);
    const out = await go(s, 'success', {
      cwd: worktree,
      config: config({ model: 'claude-sonnet-5-5', tier: 'standard' }),
    });

    expect(out).toMatchObject({
      result: 'pass',
      subtype: 'success',
      costUsd: 0.25,
      exitCode: EXIT.ok,
      runId: 'r-20261117-0603-01',
    });

    const rec = recorded(s);
    const flag = (name: string): string | undefined => rec.argv[rec.argv.indexOf(name) + 1];
    expect(rec.argv).toContain('-p');
    expect(flag('--output-format')).toBe('json');
    expect(flag('--max-budget-usd')).toBe('1');
    expect(flag('--max-turns')).toBe('10');
    expect(flag('--permission-mode')).toBe('dontAsk');
    expect(flag('--model')).toBe('claude-sonnet-5-5');
    expect(flag('--allowedTools')).toContain('Bash(git push *)');
    expect(flag('--disallowedTools')).toContain('mcp__*notion*');
    expect(rec.stdin).toBe('Implement US-112.');
    expect(path.resolve(rec.cwd).toLowerCase()).toBe(path.resolve(worktree).toLowerCase());
    expect(rec.otel).toBe(
      'arima.project=TAS,arima.phase=4,arima.item=US-112,arima.role=developer,arima.run_id=r-20261117-0603-01',
    );

    const rows = readLedger(s.dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: 'r-20261117-0603-01',
      project: 'TAS',
      phase: 4,
      item: 'US-112',
      role: 'developer',
      model_tier: 'standard',
      attempt: 1,
      is_rework: false,
      budget_usd: 1,
      result: 'pass',
    });
    expect(readEvents(s.dir).map((e) => e.type)).toEqual(['run.start', 'run.end']);
    expect(readdirSync(path.join(s.dir, '.arima', 'runs'))).toEqual(['r-20261117-0603-01.json']);
  });

  it('omits --model for a placeholder and --agent when no agent file exists', async () => {
    const s = setup();
    await go(s, 'success');
    const argv = recorded(s).argv;
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--agent');
  });

  it('passes an explicit --agent and --resume', async () => {
    const s = setup();
    await go(s, 'success', { agent: 'arima:developer', sessionId: 'abc-123' });
    const argv = recorded(s).argv;
    expect(argv[argv.indexOf('--agent') + 1]).toBe('arima:developer');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('abc-123');
  });

  it('marks later attempts as rework', async () => {
    const s = setup();
    await go(s, 'success', { attempt: 2, reworkReason: 'failed_qa', milestone: 'MS-02' });
    expect(readLedger(s.dir)[0]).toMatchObject({
      attempt: 2,
      is_rework: true,
      rework_reason: 'failed_qa',
      milestone: 'MS-02',
    });
  });
});

describe('runAgent: stops and failures all leave a ledger row', () => {
  it.each([
    ['max_turns', 'error_max_turns', 'blocked', EXIT.blocked],
    ['max_budget', 'error_max_budget_usd', 'blocked', EXIT.blocked],
  ] as const)('%s -> %s is a block, not a crash', async (mode, subtype, result, exitCode) => {
    const s = setup();
    const out = await go(s, mode);
    expect(out).toMatchObject({ subtype, result, exitCode });
    expect(readLedger(s.dir)).toHaveLength(1);
    expect(readEvents(s.dir).map((e) => e.type)).toEqual(['run.start', 'run.end']);
  });

  it('records a usage-limit stop (JSON result) as a pause, not a failure (§4.4)', async () => {
    const s = setup();
    const out = await go(s, 'usage_limit');
    expect(out).toMatchObject({
      result: 'paused',
      subtype: 'usage_limit_pause',
      exitCode: EXIT.paused,
    });
    expect(readLedger(s.dir)[0]).toMatchObject({ result: 'paused', subtype: 'usage_limit_pause' });
    const types = readEvents(s.dir).map((e) => e.type);
    expect(types).toEqual(['run.start', 'run.paused']);
    expect(types).not.toContain('run.end');
  });

  it('records a usage-limit stop that only shows on stderr as a pause', async () => {
    const s = setup();
    const out = await go(s, 'usage_limit_text');
    expect(out).toMatchObject({ result: 'paused', exitCode: EXIT.paused });
  });

  it.each([
    ['garbage', 'unparseable_output'],
    ['crash', 'unparseable_output'],
  ])('%s output -> error row (%s)', async (mode, subtype) => {
    const s = setup();
    const out = await go(s, mode);
    expect(out).toMatchObject({ result: 'error', subtype, exitCode: EXIT.failed });
    expect(readLedger(s.dir)).toHaveLength(1);
  });

  it('records a spawn failure', async () => {
    const s = setup();
    const out = await go(s, 'success', { claudeBin: path.join(s.dir, 'no-such-claude.exe') });
    expect(out).toMatchObject({ result: 'error', subtype: 'spawn_error' });
    expect(readLedger(s.dir)).toHaveLength(1);
  });

  it('kills a hung run at max_run_minutes and records a timeout', async () => {
    const s = setup();
    const out = await go(s, 'hang', { config: config({ maxRunMinutes: 0.03 }) });
    expect(out).toMatchObject({ result: 'error', subtype: 'timeout' });
  }, 20_000);

  it('never writes a result that looks like a secret into the run report', async () => {
    const s = setup();
    await go(s, 'secret');
    const report = readFileSync(
      path.join(s.dir, '.arima', 'runs', 'r-20261117-0603-01.json'),
      'utf8',
    );
    expect(report).not.toMatch(/ntn_/);
    expect(report).toMatch(/withheld/);
  });

  it('stores only the cost difference when a session is resumed', async () => {
    const s = setup();
    const costFile = path.join(s.dir, 'cost.txt');
    writeFileSync(costFile, '0.5');
    await go(s, 'echo_resume', {}, { STUB_COST_FILE: costFile });
    writeFileSync(costFile, '1.25');
    const second = await go(
      s,
      'echo_resume',
      { sessionId: '55555555-5555-4555-8555-555555555555', now: new Date(2026, 10, 17, 6, 9) },
      { STUB_COST_FILE: costFile },
    );
    expect(second.costUsd).toBe(0.75);
  });
});

describe('runAgent: guards', () => {
  it('rejects a run budget above budget.per_run_cap before spawning anything', async () => {
    const s = setup();
    await expect(go(s, 'success', { budgetUsd: 2.5 })).rejects.toThrow(/per_run_cap/);
    expect(existsSync(s.record)).toBe(false);
    expect(readLedger(s.dir)).toEqual([]);
  });

  it('rejects a missing prompt file', async () => {
    const s = setup();
    await expect(go(s, 'success', { promptFile: path.join(s.dir, 'nope.md') })).rejects.toThrow(
      /prompt file not found/,
    );
  });
});

describe('least privilege', () => {
  it('only the orchestrator receives the Notion token', async () => {
    for (const role of ['orchestrator', 'developer', 'qa', 'ba'] as const) {
      const s = setup();
      await go(s, 'success', { role });
      expect(recorded(s).hasNotionToken).toBe(role === 'orchestrator');
    }
  });

  it('only developer, tech-lead and devops receive the GitHub machine token', async () => {
    for (const role of [
      'developer',
      'tech-lead',
      'devops',
      'qa',
      'orchestrator',
      'security',
    ] as const) {
      const s = setup();
      await go(s, 'success', { role });
      expect(recorded(s).hasGithubToken).toBe(['developer', 'tech-lead', 'devops'].includes(role));
    }
  });

  it('appends to an existing OTEL_RESOURCE_ATTRIBUTES instead of replacing it', () => {
    const env = childEnv(
      { OTEL_RESOURCE_ATTRIBUTES: 'team=x' },
      { role: 'qa', item: 'US-1', phase: 4, runId: 'r-1', projectKey: 'TAS', config: config() },
    );
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe(
      'team=x,arima.project=TAS,arima.phase=4,arima.item=US-1,arima.role=qa,arima.run_id=r-1',
    );
  });

  it('no role may use a Notion MCP tool, and none gets blanket Bash', () => {
    expect(deniedTools()).toContain('mcp__*notion*');
    for (const role of [
      'orchestrator',
      'ba',
      'ux',
      'architect',
      'tech-lead',
      'developer',
      'qa',
      'security',
      'devops',
    ] as const) {
      const allowed = allowedTools(role, '/x/scripts/dist');
      expect(allowed).not.toContain('Bash');
      expect(allowed.some((t) => /mcp__.*notion/i.test(t))).toBe(false);
    }
  });

  it('only the developer can write product code anywhere; only qa and devops get their own areas', () => {
    expect(allowedTools('developer', '/x')).toContain('Write');
    for (const role of [
      'ba',
      'ux',
      'architect',
      'tech-lead',
      'qa',
      'security',
      'devops',
      'orchestrator',
    ] as const) {
      expect(allowedTools(role, '/x')).not.toContain('Write');
      expect(allowedTools(role, '/x')).not.toContain('Edit');
    }
    expect(allowedTools('qa', '/x')).toContain('Write(./tests/**)');
    expect(allowedTools('devops', '/x')).toContain('Write(./infra/**)');
  });
});

describe('agentConfigFrom', () => {
  it('reads the example config and treats placeholder model ids as unset', () => {
    const r = validateProject(EXAMPLES);
    const cfg = agentConfigFrom(r.arima as unknown as Record<string, unknown>, 'tech-lead');
    expect(cfg).toMatchObject({
      projectKey: 'TAS',
      perRunCap: 2,
      maxRunMinutes: 240,
      tier: 'strong',
      notionTokenEnv: 'ARIMA_NOTION_TOKEN',
      githubTokenEnv: 'ARIMA_GITHUB_TOKEN',
    });
    expect(cfg.model).toBeUndefined();
  });

  it('uses a real model id when configured', () => {
    const dir = project({ arima: [['strong: "<model id>"', 'strong: "claude-opus-5-5"']] });
    const r = validateProject(dir);
    expect(agentConfigFrom(r.arima as unknown as Record<string, unknown>, 'architect').model).toBe(
      'claude-opus-5-5',
    );
  });
});

describe('arima-run-agent CLI', () => {
  const cli = async (argv: string[], cwd: string) => {
    let out = '';
    let err = '';
    const code = await runAgentCli(argv, { out: (s) => (out += s), err: (s) => (err += s), cwd });
    return { code, out, err };
  };

  afterEach(() => {
    delete process.env['ARIMA_CLAUDE_BIN'];
    delete process.env['STUB_MODE'];
  });

  it('runs end to end against the stub and prints a JSON summary', async () => {
    const dir = project();
    writeFileSync(path.join(dir, 'p.md'), 'hello');
    process.env['ARIMA_CLAUDE_BIN'] = STUB;
    process.env['STUB_MODE'] = 'success';
    const r = await cli(
      [
        '--role',
        'qa',
        '--item',
        'US-112',
        '--budget',
        '1',
        '--max-turns',
        '5',
        '--prompt-file',
        'p.md',
      ],
      dir,
    );
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.out) as { result: string; cost_usd: number; run_id: string };
    expect(summary).toMatchObject({ result: 'pass', cost_usd: 0.25 });
    expect(readLedger(dir)).toHaveLength(1);
  });

  it('exits 75 on a usage-limit pause and 3 on a cap', async () => {
    const dir = project();
    writeFileSync(path.join(dir, 'p.md'), 'hello');
    process.env['ARIMA_CLAUDE_BIN'] = STUB;
    const args = [
      '--role',
      'qa',
      '--item',
      'US-112',
      '--budget',
      '1',
      '--max-turns',
      '5',
      '--prompt-file',
      'p.md',
    ];
    process.env['STUB_MODE'] = 'usage_limit';
    expect((await cli(args, dir)).code).toBe(75);
    process.env['STUB_MODE'] = 'max_turns';
    expect((await cli(args, dir)).code).toBe(3);
  });

  it('exits 2 for bad arguments, listing every problem', async () => {
    const r = await cli(['--role', 'wizard', '--item', 'x', '--budget', '0'], tempDir());
    expect(r.code).toBe(2);
    expect(r.err).toContain('--role must be one of');
    expect(r.err).toContain('--item must be');
    expect(r.err).toContain('--budget must be');
    expect(r.err).toContain('--max-turns must be');
    expect(r.err).toContain('--prompt-file is required');
  });

  it('exits 2 and runs nothing when the config is invalid', async () => {
    const dir = project({ team: [['count: 3', 'count: 9']] });
    writeFileSync(path.join(dir, 'p.md'), 'hello');
    process.env['ARIMA_CLAUDE_BIN'] = STUB;
    const r = await cli(
      [
        '--role',
        'qa',
        '--item',
        'US-112',
        '--budget',
        '1',
        '--max-turns',
        '5',
        '--prompt-file',
        'p.md',
      ],
      dir,
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('invalid config');
    expect(existsSync(path.join(dir, '.arima'))).toBe(false);
  });

  it('exits 2 when the budget exceeds the per-run cap', async () => {
    const dir = project();
    writeFileSync(path.join(dir, 'p.md'), 'hello');
    process.env['ARIMA_CLAUDE_BIN'] = STUB;
    const r = await cli(
      [
        '--role',
        'qa',
        '--item',
        'US-112',
        '--budget',
        '5',
        '--max-turns',
        '5',
        '--prompt-file',
        'p.md',
      ],
      dir,
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('per_run_cap');
  });
});
