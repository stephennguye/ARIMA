// WP-191: hermetic runs. The flag set a role run gets, the guard hook's failure mode, the scrub script.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISOLATION_FLAGS, agentConfigFrom, buildClaudeArgs } from '../src/run-agent.js';
import type { AgentConfig, RunAgentOptions } from '../src/run-agent.js';
import { PLUGIN_ROOT, REPO_ROOT, project } from './helpers.js';
import { validateProject } from '../src/config.js';
// @ts-expect-error plain ES module without types
import { scrub, scrubString } from '../../../../scripts/scrub-fixture.mjs';

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  projectKey: 'TAS',
  perRunCap: 2,
  maxRunMinutes: 1,
  notionTokenEnv: 'ARIMA_NOTION_TOKEN',
  projectCap: 100,
  dailyCap: 20,
  ...over,
});
const opts = (config: AgentConfig): RunAgentOptions => ({
  projectDir: '/p',
  role: 'developer',
  item: 'US-1',
  budgetUsd: 1,
  maxTurns: 5,
  promptFile: '/p/prompt.md',
  phase: 4,
  config,
  killSwitch: { notion: null },
});
const args = (config: AgentConfig): string[] =>
  buildClaudeArgs(opts(config), undefined, '/p/scripts/dist');

describe('the flag set of a role run (WP-191 decision)', () => {
  it('isolates user settings by default, and the set is exactly these flags', () => {
    expect([...ISOLATION_FLAGS]).toEqual([
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--disable-slash-commands',
    ]);
    const a = args(cfg());
    for (const f of ISOLATION_FLAGS) expect(a).toContain(f);
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('project');
  });
  it('still loads the ARIMA plugin explicitly, and never uses --bare (which would skip the guard hook)', () => {
    const a = args(cfg());
    expect(a).toContain('--plugin-dir');
    expect(a).not.toContain('--bare');
    expect(a).not.toContain('--safe-mode');
    expect(a).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'json',
        '--max-budget-usd',
        '1',
        '--max-turns',
        '5',
        '--permission-mode',
        'dontAsk',
      ]),
    );
  });
  it('isolation can be switched off only by an explicit false', () => {
    for (const c of [cfg({ isolateUserSettings: false })])
      for (const f of ISOLATION_FLAGS) expect(args(c)).not.toContain(f);
    expect(args(cfg({ isolateUserSettings: undefined }))).toContain('--setting-sources');
  });
  it('runtime.isolate_user_settings in arima.yaml feeds the config, and defaults to true', () => {
    const on = validateProject(project());
    expect(
      agentConfigFrom(on.arima as unknown as Record<string, unknown>, 'developer')
        .isolateUserSettings,
    ).toBe(true);
    const off = validateProject(
      project({
        arima: [
          [
            '  allow_usage_credits: false',
            '  allow_usage_credits: false\n  isolate_user_settings: false',
          ],
        ],
      }),
    );
    expect(off.ok, JSON.stringify(off.errors)).toBe(true);
    expect(
      agentConfigFrom(off.arima as unknown as Record<string, unknown>, 'developer')
        .isolateUserSettings,
    ).toBe(false);
  });
});

describe('the guard hook fails closed (WP-191, RD-F09-3)', () => {
  const hooks = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, { hooks: { type: string; timeout?: number; onFailure?: string }[] }[]>;
  };
  it('every PreToolUse command hook has onFailure "block" and a timeout, so a hang or crash blocks the tool call', () => {
    const pre = hooks.hooks['PreToolUse']!.flatMap((g) => g.hooks);
    expect(pre.length).toBeGreaterThan(0);
    for (const h of pre)
      expect(h).toMatchObject({ type: 'command', onFailure: 'block', timeout: expect.any(Number) });
  });
  it('the audit hooks stay fail-open (they must never stop work)', () => {
    for (const ev of ['PostToolUse', 'Stop', 'SubagentStop', 'PermissionDenied'])
      for (const h of hooks.hooks[ev]!.flatMap((g) => g.hooks))
        expect(h.onFailure, ev).toBeUndefined();
  });
});

describe('scripts/scrub-fixture.mjs', () => {
  const names = ['alice', 'devbox'];
  const BS = String.fromCharCode(92);
  it('keeps numbers and shape, removes ids, paths, names, e-mail addresses and tokens', () => {
    const raw = {
      type: 'result',
      subtype: 'success',
      session_id: '55555555-5555-4555-8555-555555555555',
      total_cost_usd: 0.18,
      num_turns: 2,
      usage: { input_tokens: 4, cache_read_input_tokens: 68602 },
      result: `Wrote C:${BS}Users${BS}alice${BS}proj${BS}note.txt and /home/alice/proj/x for alice@example.com on devbox. key ntn_aB3xQ9zLm2Kp7Vd4Ts8Wy1Nc6Hf0Jg id 123e4567-e89b-42d3-a456-426614174000`,
      list: ['/tmp/alice-run/a.log', { uuid: 'abc' }],
    };
    const out = scrub(raw, names);
    expect(out).toMatchObject({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.18,
      num_turns: 2,
      usage: { input_tokens: 4, cache_read_input_tokens: 68602 },
      session_id: '00000000-0000-4000-8000-000000000000',
    });
    const text = JSON.stringify(out);
    for (const leak of [
      'alice',
      'devbox',
      'example.com',
      'ntn_',
      'Users',
      '/home/',
      '/tmp/',
      '123e4567',
    ])
      expect(text, leak).not.toContain(leak);
    expect(out.list[1].uuid).toBe('00000000-0000-4000-8000-000000000000');
  });
  it('is idempotent and leaves ordinary text alone', () => {
    expect(scrubString('Created note.txt with hello', names)).toBe('Created note.txt with hello');
    const once = scrub({ r: '/Users/bob/x' }, names);
    expect(scrub(once, names)).toEqual(once);
  });
  it('lives in scripts/ of the repository', () => {
    expect(readFileSync(path.join(REPO_ROOT, 'scripts', 'scrub-fixture.mjs'), 'utf8')).toContain(
      'export function scrub',
    );
  });
});
