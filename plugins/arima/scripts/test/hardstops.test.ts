// Stage 0A: the hard stops the judge found missing (merge/push, kill switch, config files, fail-closed).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHookCli } from '../src/cli/hook-cli.js';
import { readEvents } from '../src/events.js';
import { guardBash, guardTool, handleHook } from '../src/hooks.js';
import { ROLES, allowedTools, deniedTools } from '../src/roles.js';
import { project, tempDir } from './helpers.js';

const DIST = '/p/scripts/dist';
const allowedOf = (role: (typeof ROLES)[number]): string[] => allowedTools(role, DIST);
const hasPattern = (role: (typeof ROLES)[number], needle: string): boolean =>
  allowedOf(role).some((t) => t.includes(needle));

describe('role tool lists: no role can merge, push blindly, publish or change settings', () => {
  it.each(ROLES)('%s has none of the dangerous patterns', (role) => {
    const list = allowedOf(role);
    for (const bad of [
      'gh pr merge',
      'gh api',
      'gh workflow run',
      'gh release',
      'gh secret',
      'gh repo',
      'gh auth',
      'npx *',
      'Bash(git *)',
      'Bash(gh *)',
      'Bash(npm *)',
      'Bash(node *)',
      'dist/*',
    ]) {
      expect(
        list.some((t) => t.includes(bad)),
        `${role} allows ${bad}`,
      ).toBe(false);
    }
    expect(list).not.toContain('Bash');
  });

  it('no role pushes, runs gh, opens pull requests or comments on them (D-49, G-05)', () => {
    for (const role of ROLES) {
      for (const p of [
        'git push',
        'gh pr create',
        'gh pr view',
        'gh pr review',
        'gh pr comment',
        'gh pr diff',
        'gh workflow list',
      ])
        expect(hasPattern(role, p), `${role}: ${p}`).toBe(false);
      expect(
        allowedTools(role, '/p/scripts/dist').some((t) => /\bgh\b/.test(t)),
        role,
      ).toBe(false);
      expect(deniedTools(role)).toContain('Bash(gh *)');
      expect(deniedTools(role)).toContain('Bash(git push *)');
    }
  });

  it('only the orchestrator runs ARIMA scripts, and never the kill switch or init', () => {
    for (const role of ROLES) {
      const scripts = allowedOf(role).filter((t) => t.includes('arima-'));
      if (role !== 'orchestrator') expect(scripts, role).toEqual([]);
    }
    const orch = allowedOf('orchestrator').join(' ');
    for (const ok of [
      'arima-config',
      'arima-preflight',
      'arima-ids',
      'arima-notion',
      'arima-state',
      'arima-status',
    ])
      expect(orch).toContain(ok);
    for (const never of ['arima-pause', 'arima-init', 'arima-run-agent', 'arima-hook'])
      expect(orch, never).not.toContain(never);
  });

  it('every role is denied merge, API writes, workflow runs and the config files that govern approvals', () => {
    for (const role of ROLES) {
      const denied = deniedTools(role);
      for (const must of [
        'Bash(gh pr merge *)',
        'Bash(gh api *)',
        'Bash(gh workflow run *)',
        'Edit(./arima.yaml)',
        'Write(./team.yaml)',
        'Write(./.claude/**)',
        'Write(./.arima/PAUSE)',
        'mcp__*notion*',
      ]) {
        expect(denied, `${role}: ${must}`).toContain(must);
      }
    }
  });

  it('only devops may write .github/', () => {
    for (const role of ROLES) {
      expect(deniedTools(role).includes('Write(./.github/**)'), role).toBe(role !== 'devops');
    }
  });
});

describe('guard: git and GitHub CLI', () => {
  it.each([
    'git push origin main',
    'git push origin master',
    'git push origin HEAD:main',
    'git push origin feat/US-1-x:main',
    'git push origin refs/heads/main',
    'git push -f origin feat/US-1-x',
    'git push --force origin feat/US-1-x',
    'git push --force-with-lease origin feat/US-1-x',
    'git push origin :feat/US-1-x',
    'git push origin +feat/US-1-x',
    'git push --delete origin feat/US-1-x',
    'git push --all origin',
    'git push --mirror origin',
    'git push',
    'git push origin',
    'git push --no-verify origin feat/US-1-x',
    'git commit --no-verify -m "x"',
    'git commit -n -m "x"',
    'git -C . push origin main',
    'git add . && git commit -m "x" && git push origin main',
    'git config core.hooksPath /dev/null',
    'gh pr merge 5 --squash',
    'gh pr merge',
    'gh api -X DELETE repos/o/r/git/refs/heads/x',
    'gh api --method PUT repos/o/r/pulls/5/merge',
    'gh api repos/o/r/issues -f title=x',
    'gh workflow run deploy.yml',
    'gh release create v1.0.0',
    'gh secret set TOKEN',
    'gh repo delete o/r --yes',
    'gh auth login',
  ])('blocks: %s', (cmd) => {
    expect(guardBash(cmd)?.rule, cmd).toBeDefined();
  });

  it.each([
    'git push -u origin feat/US-1-x',
    'git push origin feat/US-1-x',
    'git push origin HEAD:feat/US-1-x',
    'git status',
    'git diff HEAD~1',
    'git commit -m "feat(US-1): x"',
    'git checkout -b feat/US-1-x',
    'gh pr create --title "US-1: x" --body y',
    'gh pr view 3',
    'gh pr list',
    'gh api repos/o/r/pulls',
    'gh run view 12',
  ])('allows: %s', (cmd) => {
    expect(guardBash(cmd), cmd).toBeUndefined();
  });

  it('also protects the configured default branch, whatever it is called', () => {
    expect(guardBash('git push origin develop', { defaultBranch: 'develop' })?.rule).toBe('vcs');
    expect(guardBash('git push origin develop')).toBeUndefined();
  });
});

describe('guard: kill switch and config files belong to humans', () => {
  it('inside an agent run, pausing, resuming and re-initialising are blocked; a human may', () => {
    const cmd = 'node "/p/scripts/dist/arima-pause.mjs" --resume';
    expect(guardBash(cmd, { role: 'orchestrator' })?.rule).toBe('kill-switch');
    expect(
      guardBash('node /p/scripts/dist/arima-init.mjs --brief b.md', { role: 'qa' })?.rule,
    ).toBe('kill-switch');
    expect(guardBash(cmd)).toBeUndefined();
  });

  it('nobody writes the PAUSE file or the lock with file tools or shell redirects', () => {
    expect(guardTool('Write', { file_path: '.arima/PAUSE', content: '' })?.rule).toBe(
      'protected-state',
    );
    expect(
      guardTool('Edit', {
        file_path: 'C:\\app\\.arima\\run.lock',
        old_string: 'a',
        new_string: 'b',
      })?.rule,
    ).toBe('protected-state');
    expect(guardBash('rm .arima/PAUSE')?.rule).toBe('protected-state');
    expect(guardBash('del .arima\\run.lock')?.rule).toBe('protected-state');
  });

  it('agents may not edit approvers, hooks, settings or CI (devops may edit CI); a human may edit all', () => {
    for (const file of [
      'arima.yaml',
      'team.yaml',
      '.claude/settings.json',
      '.githooks/pre-push',
      '.github/workflows/ci.yml',
    ]) {
      expect(
        guardTool('Write', { file_path: file, content: 'x' }, { role: 'developer' })?.rule,
        `developer ${file}`,
      ).toBe('protected-config');
      expect(
        guardTool('Write', { file_path: file, content: 'x' })?.rule,
        `human ${file}`,
      ).toBeUndefined();
    }
    expect(
      guardTool(
        'Write',
        { file_path: '.github/workflows/ci.yml', content: 'x' },
        { role: 'devops' },
      ),
    ).toBeUndefined();
    expect(
      guardTool('Write', { file_path: 'team.yaml', content: 'x' }, { role: 'devops' })?.rule,
    ).toBe('protected-config');
    expect(
      guardTool('Write', { file_path: 'src/app.ts', content: 'x' }, { role: 'developer' }),
    ).toBeUndefined();
  });

  it('reads of config are fine', () => {
    expect(guardTool('Read', { file_path: 'team.yaml' }, { role: 'developer' })).toBeUndefined();
  });

  it('the role comes from ARIMA_ROLE, so a headless run is held to the agent rules end to end', async () => {
    const dir = project();
    const r = await handleHook(
      'pre-tool-use',
      {
        tool_name: 'Write',
        tool_input: { file_path: path.join(dir, 'team.yaml'), content: 'x' },
        cwd: dir,
      },
      { ARIMA_ROLE: 'qa', ARIMA_RUN_ID: 'r-20261118-0200-01' },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('protected-config');
    const human = await handleHook(
      'pre-tool-use',
      {
        tool_name: 'Write',
        tool_input: { file_path: path.join(dir, 'team.yaml'), content: 'x' },
        cwd: dir,
      },
      {},
    );
    expect(human.exitCode).toBe(0);
  });

  it('the configured default branch is read from arima.yaml', async () => {
    const dir = project({ arima: [['default_branch: main', 'default_branch: develop']] });
    const r = await handleHook(
      'pre-tool-use',
      { tool_name: 'Bash', tool_input: { command: 'git push origin develop' }, cwd: dir },
      { ARIMA_ROLE: 'developer' },
    );
    expect(r.exitCode).toBe(2);
  });
});

describe('the PreToolUse guard fails closed inside an ARIMA project (spec principle 10)', () => {
  const run = (kind: string, stdin: string, cwd: string) => {
    let err = '';
    return runHookCli([kind], { stdin, err: (s) => (err += s), env: {}, cwd }).then((code) => ({
      code,
      err,
    }));
  };

  it('blocks a payload it cannot read, inside a project', async () => {
    const dir = project();
    const r = await run('pre-tool-use', '{not json', dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('could not decide');
    expect((await run('pre-tool-use', '[1,2]', dir)).code).toBe(2);
  });

  it('blocks on an internal error, inside a project', async () => {
    const dir = project();
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get(_t, key) {
        if (key === 'ARIMA_ROLE') throw new Error('boom');
        return undefined;
      },
    });
    const r = await handleHook(
      'pre-tool-use',
      { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, cwd: dir },
      env,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('guard error');
  });

  it('does nothing outside an ARIMA project, and audit hooks stay fail-open', async () => {
    const outside = tempDir();
    expect((await run('pre-tool-use', '{not json', outside)).code).toBe(0);
    const dir = project();
    expect((await run('post-tool-use', '{not json', dir)).code).toBe(0);
    expect((await run('stop', '', dir)).code).toBe(0);
    expect((await run('subagent-stop', '[]', dir)).code).toBe(0);
  });
});

describe('audit actor', () => {
  it('records "human" for an interactive session and "unknown" for a headless run that lost its role', async () => {
    const dir = project();
    await handleHook(
      'post-tool-use',
      { tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'x' }, cwd: dir },
      {},
    );
    await handleHook(
      'post-tool-use',
      { tool_name: 'Write', tool_input: { file_path: 'b.txt', content: 'x' }, cwd: dir },
      { ARIMA_RUN_ID: 'r-20261118-0200-01' },
    );
    await handleHook(
      'post-tool-use',
      { tool_name: 'Write', tool_input: { file_path: 'c.txt', content: 'x' }, cwd: dir },
      { ARIMA_RUN_ID: 'r-20261118-0200-01', ARIMA_ROLE: 'qa' },
    );
    expect(readEvents(dir).map((e) => e.actor)).toEqual(['human', 'unknown', 'qa']);
  });
});

describe('hooks.json launcher', () => {
  const json = JSON.parse(
    readFileSync(path.join(import.meta.dirname, '../../hooks/hooks.json'), 'utf8'),
  ) as {
    description?: string;
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };

  it('the guard runs through the launcher script (behaviour is tested in guard-hardening.test.ts)', () => {
    const cmd = json.hooks['PreToolUse']?.[0]?.hooks[0]?.command ?? '';
    expect(cmd).toBe('sh "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" pre-tool-use');
  });

  it('has a description', () => {
    expect(String(json.description).length).toBeGreaterThan(20);
  });
});
