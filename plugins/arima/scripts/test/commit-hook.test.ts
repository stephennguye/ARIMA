// WP-113: commit-msg rules (S9, D-48), the PR body and its DoD check, the shipped templates.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { branchKind, checkCommitMessage } from '../src/commit-message.js';
import { DOD_ITEMS, PR_SECTIONS, renderPrBody, validatePrBody } from '../src/pr-body.js';
import type { PrBodyInput } from '../src/pr-body.js';
import { PublishError, publishBranch } from '../src/publish.js';
import { PLUGIN_ROOT, tempDir } from './helpers.js';

const TEMPLATES = path.join(PLUGIN_ROOT, 'templates', 'git');
const HOOK = path.join(TEMPLATES, 'commit-msg').replaceAll('\\', '/');

/** A POSIX sh: on PATH, or the one that ships with Git for Windows. */
function findSh(): string {
  const probe = (cmd: string): boolean => spawnSync(cmd, ['-c', 'exit 0']).status === 0;
  if (probe('sh')) return 'sh';
  const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (const rel of [
    '../../../usr/bin/sh.exe',
    '../../usr/bin/sh.exe',
    '../../../bin/sh.exe',
  ] as const) {
    const p = path.resolve(exec, rel);
    if (existsSync(p) && probe(p)) return p;
  }
  throw new Error('no POSIX sh found: the commit-msg hook cannot be tested');
}
const SH = findSh();

/** Runs the shipped hook on a message, on a real repository checked out on `branch`. */
const repos = new Map<string, string>();
afterAll(() => {
  for (const r of repos.values()) rmSync(r, { recursive: true, force: true });
});
function hook(message: string, branch: string): { code: number; stderr: string } {
  let repo = repos.get(branch);
  if (repo === undefined) {
    repo = mkdtempSync(path.join(tmpdir(), 'arima-hook-'));
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: repo });
    repos.set(branch, repo);
  }
  const file = path.join(repo, 'MSG').replaceAll('\\', '/');
  writeFileSync(file, message);
  const r = spawnSync(SH, [HOOK, file], { cwd: repo, encoding: 'utf8' });
  return { code: r.status ?? -1, stderr: r.stderr };
}

const RUN = 'r-20261119-1600-01';
const AI = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/** [message, branch, ok]: one corpus, run through the TypeScript rules and the shipped sh hook. */
const CORPUS: [string, string, boolean][] = [
  // item branches
  ['feat(US-112): add cart summary', 'feat/US-112-cart', true],
  ['fix(BUG-45): round the total', 'fix/BUG-45', true],
  ['hotfix(INC-3): restore login', 'hotfix/INC-3', true],
  ['feat(CR-2)!: change the tax rule', 'feat/CR-2-tax', true],
  ['test(US-9): cover the empty cart', 'qa/US-9-tests', true],
  [
    'feat(US-112): add cart summary\n\nLonger body\n# a comment git keeps out',
    'feat/US-112-cart',
    true,
  ],
  ['feat: add cart summary', 'feat/US-112-cart', false],
  ['feat(WP-113): add cart summary', 'feat/US-112-cart', false],
  ['feat(US-112) add cart summary', 'feat/US-112-cart', false],
  ['feat(US-x): add cart summary', 'feat/US-112-cart', false],
  ['Add cart summary', 'fix/BUG-45', false],
  ['feat(US-112):', 'feat/US-112-cart', false],
  ['# only a comment', 'feat/US-112-cart', false],
  // exempt branches: conventional, with a run, ADR, task or WP id
  [`chore(state): run ${RUN}`, 'arima-state', true],
  ['docs(adr): ADR-0007 accepted', 'docs/adr-7', true],
  ['chore: tidy the lockfile\n\nRefs T-12', 'chore/tidy', true],
  ['chore(release): v0.2.0 WP-12', 'release/v0.2.0', true],
  ['chore: tidy the lockfile', 'chore/tidy', false],
  ['tidy the lockfile WP-9', 'chore/tidy', false],
  ['docs: update the readme', 'docs/readme', false],
  // bots
  ['Bump lodash from 4.17.20 to 4.17.21', 'dependabot/npm_and_yarn/lodash-4.17.21', true],
  ['Update dependency x to v2', 'renovate/x-2.x', true],
  // other branches: conventional only
  ['feat: add a thing', 'main', true],
  ['add a thing', 'main', false],
  // merges
  ['Merge branch main into feat/US-1-x', 'feat/US-1-x', true],
  // D-48: attribution on every branch
  [`feat(US-1): add x\n\n${AI}`, 'feat/US-1-x', false],
  [`chore: tidy ${RUN}\n\n${AI}`, 'chore/tidy', false],
  [`Bump lodash\n\n${AI}`, 'dependabot/npm/x', false],
  [`feat: add\n\n${AI}`, 'main', false],
  [
    'feat(US-1): add x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    'feat/US-1-x',
    false,
  ],
  ['feat(US-1): add x\n\nGenerated with Claude', 'feat/US-1-x', false],
  ['feat(US-1): add x\n\nCo-Authored-By: Claude <c@example.com>', 'feat/US-1-x', false],
  ['feat(US-1): add x\n\nCo-authored-by: GitHub Copilot <c@example.com>', 'feat/US-1-x', false],
  ['feat(US-1): add x\n\nCo-authored-by: Pair AI <c@example.com>', 'feat/US-1-x', false],
  ['feat(US-1): add x\n\nwritten with Claude', 'feat/US-1-x', false],
  ['feat(US-1): add x\n\nCo-authored-by: Dana Smith <dana@example.com>', 'feat/US-1-x', true],
  ['feat(US-1): handle claude.md files and AI-assisted search', 'feat/US-1-x', true],
  ['feat(US-1): add generated types to the build', 'feat/US-1-x', true],
];

describe('the commit-msg rules agree between TypeScript and the shipped sh hook', () => {
  it.each(CORPUS)('%j on %s -> %s', (message, branch, ok) => {
    expect(checkCommitMessage(message, branch).ok, `ts: ${message}`).toBe(ok);
    const h = hook(message, branch);
    expect(h.code === 0, `sh: ${message} (${h.stderr.trim()})`).toBe(ok);
    if (!ok) expect(h.stderr).toMatch(/^commit-msg: /m);
  });

  it('the problems are named, and an attribution is reported on its own', () => {
    expect(checkCommitMessage(`feat(US-1): x\n\n${AI}`, 'feat/US-1-x').problems).toEqual([
      expect.stringMatching(/Co-Authored-By trailer.*D-48/),
    ]);
    const both = checkCommitMessage(`bad subject\n\n${AI}`, 'feat/US-1-x');
    expect(both.problems).toHaveLength(2);
    expect(checkCommitMessage('feat: x', 'feat/US-1-x').problems[0]).toMatch(
      /item id \(US, BUG, INC or CR\)/,
    );
    expect(checkCommitMessage('chore: x', 'chore/y').problems[0]).toMatch(/run id/);
  });

  it('branches are classified: item, exempt, bot, other', () => {
    expect(['feat/a', 'fix/a', 'hotfix/a', 'qa/a'].map(branchKind)).toEqual(Array(4).fill('item'));
    expect(['chore/a', 'docs/a', 'release/a', 'arima-state'].map(branchKind)).toEqual(
      Array(4).fill('exempt'),
    );
    expect(['dependabot/a', 'renovate/a', 'deps/a'].map(branchKind)).toEqual(Array(3).fill('bot'));
    expect(['main', 'master', '', 'wip'].map(branchKind)).toEqual(Array(4).fill('other'));
  });

  it('state commits made by ARIMA itself comply (state.ts writes "chore(state): run <id>")', () => {
    expect(checkCommitMessage('chore(state): run r-20261117-0200-01', 'arima-state').ok).toBe(true);
  });

  it('the hook is LF-only POSIX sh with no bash-isms, and the gitattributes snippet keeps it that way', () => {
    const text = readFileSync(path.join(TEMPLATES, 'commit-msg'), 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/\[\[ |\bfunction\b|<<<|\bsource\b|\$\{[A-Za-z_]+[,^/]/);
    expect(readFileSync(path.join(TEMPLATES, 'gitattributes'), 'utf8')).toContain(
      '.githooks/* text eol=lf',
    );
  });
});

const body = (over: Partial<PrBodyInput> = {}): string =>
  renderPrBody({
    items: ['US-112'],
    summary: 'Adds the cart summary.',
    criteria: [
      { criterion: 'AC-1', status: 'met', evidence: ['src/cart/summary.ts:41', 'TC-0231'] },
      { criterion: 'AC-2', status: 'met', evidence: ['src/cart/empty.ts:9'] },
    ],
    ui: false,
    risk: 'Low: new code path behind the cart page.',
    rollback: 'Revert the merge commit.',
    dodDone: [0, 1, 2, 3, 4],
    ...over,
  });

describe('the PR body and its DoD check', () => {
  it('a rendered body has every section and passes, ready and not', () => {
    const b = body();
    for (const s of PR_SECTIONS) expect(b).toContain(`## ${s}\n`);
    expect(validatePrBody(b, { criteria: ['AC-1', 'AC-2'], ready: true })).toEqual({
      ok: true,
      problems: [],
    });
    const draft = body({ dodDone: [0] });
    expect(validatePrBody(draft, { criteria: ['AC-1', 'AC-2'] }).ok).toBe(true);
    const notReady = validatePrBody(draft, { criteria: ['AC-1', 'AC-2'], ready: true });
    expect(notReady.ok).toBe(false);
    expect(notReady.problems[0]).toMatch(
      /not ready: unticked Definition of Done items: Every acceptance criterion/,
    );
  });

  it('a missing section, an empty section and a missing item id are named', () => {
    expect(
      validatePrBody(body().replace('## Risk and rollback', '## Risks'), {}).problems.join(),
    ).toMatch(/missing section "## Risk and rollback"/);
    expect(validatePrBody(body({ items: ['the cart'] }), {}).problems.join()).toMatch(
      /names no item id/,
    );
    const empty = body().replace(
      /## Linked items\n[\s\S]*?\n## Acceptance/,
      '## Linked items\n\n## Acceptance',
    );
    expect(validatePrBody(empty, {}).problems.join()).toMatch(/section "Linked items" is empty/);
  });

  it('every criterion of the report must be mapped with evidence', () => {
    expect(validatePrBody(body(), { criteria: ['AC-1', 'AC-3'] }).problems).toEqual([
      'criterion AC-3 is not in the acceptance criteria mapping',
    ]);
    const noEvidence = body({ criteria: [{ criterion: 'AC-1', status: 'unclear', evidence: [] }] });
    expect(validatePrBody(noEvidence, { criteria: ['AC-1'] }).problems).toEqual([
      'criterion AC-1 cites no evidence (file:line or a test case id)',
    ]);
    // AC-1 must not be satisfied by AC-10
    const ten = body({ criteria: [{ criterion: 'AC-10', status: 'met', evidence: ['a.ts:1'] }] });
    expect(validatePrBody(ten, { criteria: ['AC-1'] }).problems[0]).toMatch(/AC-1 is not in/);
  });

  it('a UI story needs a screenshot; a non-UI story says n/a', () => {
    expect(validatePrBody(body({ ui: true }), { ui: true }).problems.join()).toMatch(
      /needs screenshots/,
    );
    expect(
      validatePrBody(body({ ui: true, screenshots: ['design/screens/US-112/success.png'] }), {
        ui: true,
      }).ok,
    ).toBe(true);
    expect(body()).toContain('n/a (no UI)');
  });

  it('AI attribution and secrets in the body are refused (D-48)', () => {
    expect(
      validatePrBody(
        `${body()}\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`,
        {},
      ).problems.join(),
    ).toMatch(/D-48/);
    expect(validatePrBody(`${body()}\n${AI}\n`, {}).ok).toBe(false);
    expect(
      validatePrBody(
        `${body()}\ntoken ntn_${'aB3xQ9zLm2Kp7Vd4Ts8Wy1Nc6Hf0JgReUo5Xi'}\n`,
        {},
      ).problems.join(),
    ).toMatch(/secret/);
  });

  it('the template file has the same sections and DoD items as the renderer', () => {
    const t = readFileSync(path.join(TEMPLATES, 'pull_request_template.md'), 'utf8');
    expect([...t.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([...PR_SECTIONS]);
    expect([...t.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1])).toEqual([...DOD_ITEMS]);
    expect(findAttributionIn(t)).toBe(false);
  });

  it('publish refuses a body that fails the DoD check, before touching git (exit 31)', async () => {
    const dir = tempDir('arima-pubdod-');
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    const base = {
      projectDir: dir,
      runId: RUN,
      branch: 'feat/US-1-x',
      item: 'US-1',
      role: 'developer' as const,
      title: 'x',
      repo: 'a/b',
      defaultBranch: 'main',
      isPaused: () => Promise.resolve(false),
    };
    const e = await publishBranch({
      ...base,
      body: '## Linked items\nUS-1\n',
      criteria: ['AC-1'],
    }).then(
      () => undefined,
      (x: unknown) => x as PublishError,
    );
    expect(e).toBeInstanceOf(PublishError);
    expect(e?.exitCode).toBe(31);
    expect(e?.message).toMatch(/fails the DoD check.*missing section/);
  });
});

function findAttributionIn(text: string): boolean {
  return checkCommitMessage(text, 'main').problems.some((p) => /D-48/.test(p));
}

describe('the shipped policy workflow and gitattributes', () => {
  const yml = readFileSync(path.join(TEMPLATES, 'arima-policy.yml'), 'utf8');
  const wf = parse(yml) as {
    on: { pull_request: { types: string[] } };
    permissions: Record<string, string>;
    jobs: { policy: { steps: { name: string; run?: string }[] } };
  };

  it('runs on pull requests with read-only permissions and has the three checks', () => {
    expect(wf.on.pull_request.types).toContain('edited');
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.policy.steps.map((s) => s.name).filter(Boolean)).toEqual([
      'No AI attribution in the pull request or its commits (D-48)',
      'The title carries the item id',
      'Every commit follows the commit-msg rules',
    ]);
    // untrusted text reaches the shell only through env, never through ${{ }} in a run script
    for (const s of wf.jobs.policy.steps) expect(s.run ?? '', s.name).not.toMatch(/\$\{\{/);
  });

  it('its attribution pattern catches what the hook catches', () => {
    const pat = /pat='([^']+)'/.exec(yml)?.[1] as string;
    const hits = (text: string): boolean =>
      spawnSync(SH, ['-c', 'printf "%s\\n" "$1" | grep -Eiq "$2"', 'x', text, pat]).status === 0;
    for (const bad of [
      AI,
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'Generated with Claude',
      'written with Claude',
      'claude.ai/code/x',
    ])
      expect(hits(bad), bad).toBe(true);
    for (const ok of ['Co-authored-by: Dana <d@e.c>', 'handle claude.md files', 'generated types'])
      expect(hits(ok), ok).toBe(false);
  });
});
