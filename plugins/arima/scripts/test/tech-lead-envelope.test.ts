// WP-212 step 3 (envelope): the tech-lead tool list equals the card's (as narrowed by D-49), per kind, and
// every forbidden action of the card has a test that tries it. Deny rules and the guard are two layers.
import { describe, expect, it } from 'vitest';
import { guardBash, guardTool, isReadOnlyKind } from '../src/hooks.js';
import { ROLES, allowedTools, deniedTools, mayHoldGithubToken } from '../src/roles.js';

const DIR = '/p/scripts/dist';
const review = allowedTools('tech-lead', DIR, 'review');
const ctx = { role: 'tech-lead', kind: 'review', defaultBranch: 'main' };

describe('tech-lead allow-list for a review (card section 6, D-49)', () => {
  it('reads and runs read-only git, and nothing that writes', () => {
    for (const t of [
      'Read',
      'Glob',
      'Grep',
      'Bash(git diff *)',
      'Bash(git log *)',
      'Bash(git show *)',
      'WebFetch',
    ])
      expect(review, t).toContain(t);
    expect(review.some((t) => /^(Write|Edit|MultiEdit)/.test(t))).toBe(false);
    expect(
      review.filter((t) => /git (add|commit|push|checkout|switch|reset|tag|merge)/.test(t)),
    ).toEqual([]);
  });

  it('has no gh, no docker, no npm or npx, no outbox, no host script, no GitHub or Notion credential', () => {
    expect(review.filter((t) => /\bgh\b|docker|podman|kubectl|npm|npx/.test(t))).toEqual([]);
    expect(review.some((t) => t.includes('outbox') || t.includes('.mjs'))).toBe(false);
    expect(mayHoldGithubToken('tech-lead')).toBe(false);
  });

  it('allowedTools(kind) is a parameter: only adr-review and conventions hold a write grant', () => {
    const adr = allowedTools('tech-lead', DIR, 'adr-review');
    expect(adr).toContain('Edit(./docs/architecture/adr/**)');
    expect(adr).not.toContain('Write(./docs/architecture/adr/**)');
    expect(adr).toContain('Bash(git commit *)');
    const conv = allowedTools('tech-lead', DIR, 'conventions');
    expect(conv).toContain('Write(./docs/engineering/**)');
    expect(conv).toContain('Edit(./docs/engineering/**)');
    for (const kind of [undefined, 'review', 'rc-freeze', 'debt-review', 'deprecation-check'])
      expect(
        allowedTools('tech-lead', DIR, kind).some((t) => /^(Write|Edit)\(/.test(t)),
        String(kind),
      ).toBe(false);
    expect(adr.some((t) => t.includes('docs/engineering'))).toBe(false);
    expect(conv.some((t) => t.includes('docs/architecture'))).toBe(false);
  });

  it('the kind parameter changes nothing for another role', () => {
    for (const r of ROLES.filter((x) => x !== 'tech-lead'))
      expect(allowedTools(r, DIR, 'adr-review'), r).toEqual(allowedTools(r, DIR));
  });

  it('every role denies workflows, hooks, config, push and gh (the tech-lead keeps .github denied until WP-219)', () => {
    const d = deniedTools('tech-lead', 'review');
    for (const t of [
      'Write(./.github/**)',
      'Edit(./.claude/**)',
      'Edit(./.githooks/**)',
      'Bash(git push *)',
      'Bash(gh *)',
      'Bash(gh pr merge *)',
      'Edit(./arima.yaml)',
    ])
      expect(d, t).toContain(t);
  });
});

describe('the guard in a tech-lead review: forbidden actions are blocked (card sections 3, 6, 8)', () => {
  const blocked: [string, string][] = [
    // approve, merge, tag, push: no flag order slips through, because no gh exists for a role
    ['gh pr review 3 --approve', 'vcs'],
    ['gh pr review --approve 3', 'vcs'],
    ['gh pr review 3 -a', 'vcs'],
    ['gh pr review 3 --request-changes -b x', 'vcs'],
    ['gh pr review 3 --comment -b "ok"', 'vcs'],
    ['gh pr merge 3 --squash', 'vcs'],
    ['gh release create v1.0.0', 'vcs'],
    ['git tag v1.0.0', 'read-only-kind'],
    ['git push origin feat/x', 'vcs'],
    ['git push origin HEAD:main', 'vcs'],
    // the planted CI-log instruction of the card
    ['bash -c "gh pr review --approve && gh pr merge"', 'vcs'],
    // a review changes nothing
    ['git commit -m x', 'read-only-kind'],
    ['git add -A', 'read-only-kind'],
    ['git checkout main', 'read-only-kind'],
    ['git reset --hard HEAD~1', 'read-only-kind'],
    ['git stash', 'read-only-kind'],
    ['git apply fix.patch', 'read-only-kind'],
    ['echo x > src/a.js', 'read-only-kind'],
    ['sed -i s/a/b/ src/a.js', 'read-only-kind'],
    ['rm -rf src', 'read-only-kind'],
    // developer's and QA's notes, ARIMA state
    ['cat .arima/runs/r-20261121-0900-01.report.json', 'protected-state'],
    ['ls .arima/evidence', 'protected-state'],
    ['grep -r claim .arima', 'protected-state'],
    // secrets and containers
    ['cat .env', 'secret-file'],
    ['cat ~/.config/arima/env', 'secret-file'],
    ['echo $ARIMA_NOTION_TOKEN', 'secret-env'],
    ['docker ps', 'container'],
    ['node /p/scripts/dist/arima-merge.mjs --pr 1', 'host-script'],
    ['node /p/scripts/dist/arima-publish.mjs comment --pr 1', 'host-script'],
  ];
  it.each(blocked)('%s is blocked (%s)', (cmd, rule) => {
    expect(guardBash(cmd, ctx)?.rule).toBe(rule);
  });

  it('what a review is meant to do passes the guard', () => {
    for (const cmd of [
      'git diff main...feat/US-112-x',
      'git diff --stat main...feat/US-112-x',
      'git log --oneline main..feat/US-112-x',
      'git show feat/US-112-x:src/summary.js',
      'git status',
      'git ls-files',
      'git rev-parse HEAD',
    ])
      expect(guardBash(cmd, ctx), cmd).toBeUndefined();
  });

  it.each([
    ['Write', { file_path: 'src/a.js', content: 'x' }],
    ['Edit', { file_path: 'src/a.js', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '.arima/outbox/x.json', content: '{}' }],
    ['Write', { file_path: 'docs/architecture/adr/ADR-0001.md', content: 'Accepted' }],
    ['MultiEdit', { file_path: 'src/a.js', edits: [] }],
  ])('a review cannot write: %s %j', (tool, input) => {
    expect(guardTool(tool, input, ctx)?.rule).toBe('read-only-kind');
  });

  it.each([
    ['Read', { file_path: '.arima/runs/r-1.report.json' }],
    ['Read', { file_path: '/work/app/.arima/mirror/stories.json' }],
    ['Glob', { pattern: '.arima/**' }],
    ['Grep', { pattern: 'x', path: '.arima/runs' }],
    ['Read', { file_path: '.env' }],
    ['Read', { file_path: '~/.config/arima/env' }],
  ])('a review cannot read state or secrets: %s %j', (tool, input) => {
    expect(guardTool(tool, input, ctx)).toBeDefined();
  });

  it('reading the code under review is fine', () => {
    for (const p of [
      'src/summary.js',
      'test/summary.test.js',
      'docs/engineering/conventions.md',
      'api/openapi.yaml',
    ])
      expect(guardTool('Read', { file_path: p }, ctx), p).toBeUndefined();
    expect(guardTool('Grep', { pattern: 'TODO', path: 'src' }, ctx)).toBeUndefined();
  });

  it('only a review (and deploy-staging for devops) is a read-only kind: the other tech-lead kinds may edit their own files', () => {
    expect(isReadOnlyKind(ctx)).toBe(true);
    expect(isReadOnlyKind({ role: 'devops', kind: 'deploy-staging' })).toBe(true);
    for (const kind of ['adr-review', 'conventions', 'rc-freeze'])
      expect(isReadOnlyKind({ role: 'tech-lead', kind }), kind).toBe(false);
    expect(
      guardTool(
        'Edit',
        { file_path: 'docs/architecture/adr/ADR-0001.md', old_string: 'a', new_string: 'b' },
        { role: 'tech-lead', kind: 'adr-review' },
      ),
    ).toBeUndefined();
    expect(
      guardBash('git commit -m "docs(adr): accept ADR-0001"', {
        role: 'tech-lead',
        kind: 'adr-review',
      }),
    ).toBeUndefined();
  });

  it('the state-read rule holds for QA and the developer too, and not for the orchestrator or a human', () => {
    expect(guardTool('Read', { file_path: '.arima/runs/x.json' }, { role: 'qa' })?.rule).toBe(
      'protected-state',
    );
    expect(guardBash('cat .arima/ledger.jsonl', { role: 'developer' })?.rule).toBe(
      'protected-state',
    );
    expect(
      guardTool('Read', { file_path: '.arima/mirror/stories.json' }, { role: 'orchestrator' }),
    ).toBeUndefined();
    expect(guardBash('cat .arima/ledger.jsonl', {})).toBeUndefined();
    expect(
      guardBash('git commit -m "fix: the .arimaconfig typo"', { role: 'developer' }),
    ).toBeUndefined();
  });
});
