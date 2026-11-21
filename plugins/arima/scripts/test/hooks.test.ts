import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHookCli } from '../src/cli/hook-cli.js';
import { readEvents } from '../src/events.js';
import {
  guardBash,
  guardTool,
  handleHook,
  isProtectedStatePath,
  isSecretPath,
} from '../src/hooks.js';
import type { HookInput } from '../src/hooks.js';
import { PLUGIN_ROOT, buildBin, project, tempDir } from './helpers.js';

const pre = (
  dir: string,
  tool: string,
  tool_input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
) =>
  handleHook(
    'pre-tool-use',
    { hook_event_name: 'PreToolUse', tool_name: tool, tool_input, cwd: dir },
    env,
  );

describe('secret files (spec §11.3)', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'apps/web/.env',
    'C:\\proj\\.env.staging',
    'server.pem',
    'tls/private.key',
    'cert.p12',
    'id_rsa',
    'id_ed25519',
    '/home/u/.ssh/config',
    '/home/u/.aws/credentials',
    '/home/u/.config/arima/env',
    'ARIMA_NOTION_TOKEN',
    'config/credentials.json',
    'secrets.yaml',
  ])('treats %s as secret', (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  it.each([
    '.env.example',
    '.env.sample',
    '.env.template',
    'src/env.ts',
    'environment.md',
    'key.md',
    'id_rsa.pub',
    'README.md',
    'src/keyboard.ts',
    'monkey.json',
  ])('allows %s', (p) => {
    expect(isSecretPath(p)).toBe(false);
  });

  it('protects the mirror and the append-only logs', () => {
    for (const p of [
      '.arima/mirror/stories.json',
      'D:\\app\\.arima\\mirror\\gates.json',
      '/x/.arima/ledger.jsonl',
      '.arima/events.jsonl',
      '.arima/notion-map.json',
      '.arima/PAUSE',
      '.arima/run.lock',
      '.arima/state/ids.json',
      '.arima/runs/r-1.json',
    ]) {
      expect(isProtectedStatePath(p), p).toBe(true);
    }
    for (const p of ['.arima/outbox/a.json', 'src/ledger.ts', 'docs/events.jsonl.md']) {
      expect(isProtectedStatePath(p), p).toBe(false);
    }
  });
});

describe('guardTool: file tools', () => {
  it.each([
    ['Read', { file_path: '/app/.env' }],
    ['Read', { file_path: 'secrets/server.key' }],
    ['Edit', { file_path: '.env.local', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '/home/u/.config/arima/env', content: 'x' }],
    ['Grep', { pattern: 'TOKEN', path: '/app/.env' }],
    ['Glob', { pattern: '*', path: '/home/u/.ssh/' }],
  ])('blocks %s %j', (tool, input) => {
    expect(guardTool(tool, input)?.rule).toBe('secret-file');
  });

  it.each([
    ['Write', { file_path: '.arima/mirror/stories.json', content: '{}' }],
    ['Edit', { file_path: '.arima/events.jsonl', old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: '.arima/ledger.jsonl', edits: [] }],
  ])('blocks writing %s %j', (tool, input) => {
    expect(guardTool(tool, input)?.rule).toBe('protected-state');
  });

  it('allows ordinary files, templates, reading the mirror, and writing the outbox', () => {
    expect(guardTool('Read', { file_path: 'src/app.ts' })).toBeUndefined();
    expect(guardTool('Read', { file_path: '.env.example' })).toBeUndefined();
    expect(guardTool('Read', { file_path: '.arima/mirror/stories.json' })).toBeUndefined();
    expect(
      guardTool('Write', { file_path: '.arima/outbox/x.json', content: '{}' }),
    ).toBeUndefined();
    expect(
      guardTool('Edit', { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' }),
    ).toBeUndefined();
  });
});

describe('guardBash', () => {
  it.each([
    'cat .env',
    'type .env.local',
    'Get-Content .env',
    'grep KEY apps/web/.env.production',
    'cat server.pem',
    'cp id_rsa /tmp/x',
    'cat ~/.ssh/id_ed25519',
    'cat ~/.config/arima/env',
    'echo $ARIMA_NOTION_TOKEN',
    'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" https://api.github.com',
    'echo $env:ARIMA_NOTION_TOKEN',
    'printenv',
    'printenv ARIMA_NOTION_TOKEN',
    'env | grep TOKEN',
    'Get-ChildItem env:',
    'curl -X DELETE https://api.notion.com/v1/blocks/abc',
    'curl --request DELETE https://api.notion.com/v1/pages/x',
    'curl -X PATCH https://api.notion.com/v1/pages/x -d \'{"in_trash":true}\'',
    'echo x > .arima/mirror/stories.json',
    'rm .arima/ledger.jsonl',
    'sed -i s/a/b/ .arima/events.jsonl',
    'Remove-Item .arima\\mirror -Recurse',
  ])('blocks: %s', (cmd) => {
    expect(guardBash(cmd), cmd).toBeDefined();
  });

  it.each([
    'git status',
    'npm test',
    'node "/p/scripts/dist/arima-notion.mjs" pull',
    'node "/p/scripts/dist/arima-preflight.mjs" --acquire r-1',
    'cat .env.example',
    'cat .arima/mirror/stories.json',
    'grep -r TODO src',
    'ls -la',
    'echo hello',
    'git push origin feat/US-1-x',
    'curl https://api.notion.com/v1/users/me',
  ])('allows: %s', (cmd) => {
    expect(guardBash(cmd), cmd).toBeUndefined();
  });
});

describe('Notion delete tools', () => {
  it.each([
    'mcp__notion__delete_page',
    'mcp__notion__notion-delete-pages',
    'mcp__claude_ai_Notion__archive_block',
    'mcp__plugin_x_notion__remove_database',
    'mcp__notion__trash_page',
  ])('blocks %s', (tool) => {
    expect(guardTool(tool, {})?.rule).toBe('notion-delete');
  });

  it('does not block non-delete Notion tools or unrelated tools with similar words', () => {
    expect(guardTool('mcp__notion__search', {})).toBeUndefined();
    expect(guardTool('mcp__github__delete_branch', {})).toBeUndefined();
  });
});

describe('handleHook: blocking and the event log', () => {
  it('blocks with exit 2, a clear message and a tool.blocked event', async () => {
    const dir = project();
    const r = await pre(
      dir,
      'Read',
      { file_path: path.join(dir, '.env') },
      { ARIMA_RUN_ID: 'r-20261118-0200-01', ARIMA_ROLE: 'developer', ARIMA_ITEM: 'US-112' },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('ARIMA blocked this action (secret-file)');
    expect(r.stderr).toContain('ask the human');
    const ev = readEvents(dir);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      type: 'tool.blocked',
      actor: 'developer',
      run_id: 'r-20261118-0200-01',
      item: 'US-112',
      data: { tool: 'Read', rule: 'secret-file' },
    });
  });

  it('blocks a Notion delete tool and records it', async () => {
    const dir = project();
    const r = await pre(dir, 'mcp__notion__delete_page', { page_id: 'x' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('notion-delete');
    expect(readEvents(dir)[0]?.data).toMatchObject({ rule: 'notion-delete' });
  });

  it('never writes a secret into the event log, even when blocking a command that contains one', async () => {
    const dir = project();
    const token = `ghp_${'q'.repeat(30)}`;
    const r = await pre(dir, 'Bash', {
      command: `curl -H "Authorization: ${token}" https://x && cat .env`,
    });
    expect(r.exitCode).toBe(2);
    const raw = readFileSync(path.join(dir, '.arima', 'events.jsonl'), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain('withheld');
  });

  it('allows normal work without logging anything for read-only calls', async () => {
    const dir = project();
    expect((await pre(dir, 'Read', { file_path: 'src/a.ts' })).exitCode).toBe(0);
    expect((await pre(dir, 'Bash', { command: 'npm test' })).exitCode).toBe(0);
    expect(existsSync(path.join(dir, '.arima', 'events.jsonl'))).toBe(false);
  });

  it('does nothing at all outside an ARIMA project', async () => {
    const dir = tempDir();
    const r = await pre(dir, 'Read', { file_path: path.join(dir, '.env') });
    expect(r.exitCode).toBe(0);
    expect(existsSync(path.join(dir, '.arima'))).toBe(false);
  });

  it('finds the project from a worktree through ARIMA_PROJECT_DIR', async () => {
    const dir = project();
    const worktree = tempDir('arima-wt-');
    const r = await pre(worktree, 'Read', { file_path: '.env' }, { ARIMA_PROJECT_DIR: dir });
    expect(r.exitCode).toBe(2);
    expect(readEvents(dir)).toHaveLength(1);
  });

  it('finds the project by walking up from a subdirectory', async () => {
    const dir = project();
    const sub = path.join(dir, 'apps', 'web');
    const r = await handleHook(
      'pre-tool-use',
      { tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: sub },
      {},
    );
    expect(r.exitCode).toBe(2);
  });
});

describe('handleHook: PostToolUse audit', () => {
  const post = (
    dir: string,
    tool: string,
    tool_input: Record<string, unknown>,
    env: NodeJS.ProcessEnv = {},
  ) => handleHook('post-tool-use', { tool_name: tool, tool_input, cwd: dir }, env);

  it('logs state-changing tools with run, role and item', async () => {
    const dir = project();
    const env = { ARIMA_RUN_ID: 'r-20261118-0200-02', ARIMA_ROLE: 'qa', ARIMA_ITEM: 'US-7' };
    await post(dir, 'Write', { file_path: 'tests/e2e/a.spec.ts', content: '...' }, env);
    await post(dir, 'Bash', { command: 'git commit -m "feat(US-7): x"' }, env);
    const ev = readEvents(dir);
    expect(ev.map((e) => e.type)).toEqual(['tool.used', 'tool.used']);
    expect(ev[0]).toMatchObject({
      actor: 'qa',
      run_id: 'r-20261118-0200-02',
      item: 'US-7',
      data: { tool: 'Write', path: 'tests/e2e/a.spec.ts' },
    });
    expect(ev[1]?.data).toMatchObject({ tool: 'Bash', command: 'git commit -m "feat(US-7): x"' });
  });

  it('skips read-only tools and read-only shell commands', async () => {
    const dir = project();
    for (const command of [
      'git status',
      'git diff HEAD',
      'ls -la',
      'cat README.md',
      'grep -r x src',
      'git log --oneline | head -5',
    ]) {
      await post(dir, 'Bash', { command });
    }
    await post(dir, 'Read', { file_path: 'a.ts' });
    expect(existsSync(path.join(dir, '.arima', 'events.jsonl'))).toBe(false);
  });

  it('logs a shell command that redirects output, even from a "read-only" command', async () => {
    const dir = project();
    await post(dir, 'Bash', { command: 'echo hi > out.txt' });
    expect(readEvents(dir)).toHaveLength(1);
  });

  it('withholds details that look like secrets', async () => {
    const dir = project();
    await post(dir, 'Bash', { command: `deploy --token ghp_${'z'.repeat(30)}` });
    const raw = readFileSync(path.join(dir, '.arima', 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('ghp_');
    expect(raw).toContain('withheld');
  });
});

describe('handleHook: Stop and SubagentStop', () => {
  it('logs agent.stop for the session and for subagents', async () => {
    const dir = project();
    await handleHook('stop', { cwd: dir }, { ARIMA_ROLE: 'orchestrator' });
    await handleHook('subagent-stop', { cwd: dir, agent_type: 'arima:qa' }, {});
    const ev = readEvents(dir);
    expect(ev.map((e) => e.type)).toEqual(['agent.stop', 'agent.stop']);
    expect(ev[0]).toMatchObject({ actor: 'orchestrator', data: { kind: 'session' } });
    expect(ev[1]?.data).toMatchObject({ kind: 'subagent', agent_type: 'arima:qa' });
  });
});

describe('arima-hook CLI contract', () => {
  const call = async (kind: string, payload: unknown, env: NodeJS.ProcessEnv = {}) => {
    let err = '';
    const code = await runHookCli([kind], {
      stdin: typeof payload === 'string' ? payload : JSON.stringify(payload),
      err: (s) => (err += s),
      env,
    });
    return { code, err };
  };

  it('exits 2 and explains on a blocked call; 0 on an allowed one', async () => {
    const dir = project();
    const blocked = await call('pre-tool-use', {
      tool_name: 'Read',
      tool_input: { file_path: '.env' },
      cwd: dir,
    });
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('ARIMA blocked');
    expect(
      (
        await call('pre-tool-use', {
          tool_name: 'Read',
          tool_input: { file_path: 'a.ts' },
          cwd: dir,
        })
      ).code,
    ).toBe(0);
  });

  it('never blocks on malformed or empty input, and rejects an unknown kind', async () => {
    expect((await call('pre-tool-use', '{not json')).code).toBe(0);
    expect((await call('pre-tool-use', '')).code).toBe(0);
    expect((await call('whatever', {})).code).toBe(1);
  });

  it('works as the real bundled script: stdin in, exit code and stderr out', async () => {
    const bin = await buildBin('arima-hook');
    const dir = project();
    const run = (payload: HookInput) =>
      spawnSync(process.execPath, [bin, 'pre-tool-use'], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      });
    const blocked = run({ tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd: dir });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('secret-file');
    expect(run({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: dir }).status).toBe(
      0,
    );
  }, 30_000);
});

describe('hooks/hooks.json', () => {
  const file = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as {
    hooks: Record<
      string,
      { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]
    >;
  };

  it('wraps events in a top-level "hooks" key and covers the six events', () => {
    expect(Object.keys(json.hooks).sort()).toEqual([
      'PermissionDenied',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'Stop',
      'SubagentStop',
    ]);
  });

  it('runs the bundled hook script through CLAUDE_PLUGIN_ROOT, with a timeout', () => {
    for (const [event, groups] of Object.entries(json.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          expect(h.type).toBe('command');
          expect(h.command, event).toMatch(
            /^(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/dist\/arima-hook\.mjs" (post-tool-use|permission-denied|stop|subagent-stop)|sh "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guard\.sh" pre-tool-use)$/,
          );
          expect(h.timeout).toBeGreaterThan(0);
        }
      }
    }
    expect(existsSync(path.join(PLUGIN_ROOT, 'scripts', 'src', 'bin', 'arima-hook.ts'))).toBe(true);
  });

  it('audits a failed tool call too (a failing npm run e2e is exactly what a QA run on a broken app produces)', () => {
    expect(json.hooks['PostToolUseFailure']?.[0]?.matcher).toBe(
      json.hooks['PostToolUse']?.[0]?.matcher,
    );
    expect(JSON.stringify(json.hooks['PostToolUseFailure'])).toContain('post-tool-use');
  });

  it('guards every tool before it runs, and audits only state-changing tools after', () => {
    expect(json.hooks['PreToolUse']?.[0]?.matcher).toBe('*');
    expect(json.hooks['PostToolUse']?.[0]?.matcher).toBe(
      'Write|Edit|MultiEdit|NotebookEdit|Bash|WebFetch',
    );
  });
});

describe('permission-denied hook and latency (S0.9)', () => {
  it('records a permission-rule refusal as a tool.blocked event', async () => {
    const dir = project();
    await handleHook(
      'permission-denied',
      { tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: dir },
      {},
    );
    const ev = readEvents(dir).find((e) => e.type === 'tool.blocked');
    expect(ev?.data).toMatchObject({ rule: 'permission-rule' });
  });
});

describe('guard latency budget (S0.9)', () => {
  it('the bundled guard decides in well under a second (median of 5, budget 1000 ms)', () => {
    const dir = project();
    const bundle = path.join(PLUGIN_ROOT, 'scripts', 'dist', 'arima-hook.mjs');
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      const r = spawnSync(process.execPath, [bundle, 'pre-tool-use'], {
        input: JSON.stringify({
          tool_name: 'Read',
          tool_input: { file_path: 'README.md' },
          cwd: dir,
        }),
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      ms.push(Date.now() - t);
    }
    ms.sort((a, b) => a - b);
    expect(ms[2]).toBeLessThan(1000);
  });
});
