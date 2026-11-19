// WP-150: the judge automation (F10 5.5). A stub `claude` stands in for the model: what is under test is
// the envelope (a copy, read-only tools, a hard cap, no tokens), the brief check, the report check, the saved
// file with its response table, and the exit codes. No network, no cost.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runJudgeCli } from '../src/cli/judge-cli.js';
import {
  JUDGE_EXIT,
  JUDGE_MAX_BUDGET_USD,
  checkQuestions,
  copyAt,
  findingsOf,
  judgeArgs,
  renderReview,
  runJudge,
  validateJudgeReport,
} from '../src/judge.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-claude.mjs');

const REPORT = (verdict: string, extra = ''): string =>
  [
    `VERDICT: ${verdict}`,
    'Confidence: medium (read the code, ran two tests)',
    '',
    'BLOCKERS (must fix before continuing)',
    ...(verdict === 'stop'
      ? ['1. src/x.ts - the guard is not wired - a push is possible']
      : ['none']),
    '',
    'MAJOR (fix in this stage)',
    '1. test/y.test.ts - no test tries the refusal - it could regress',
    '2. docs/z.md - the status says verified but only a mock ran - the claim is false',
    '',
    'MINOR / NOTES',
    'none',
    '',
    'GAPS IN THE PLAN (things nobody has planned)',
    'none',
    '',
    'CLAIMS I COULD NOT CONFIRM',
    'none',
    '',
    'WHAT I CHECKED (so the builder knows what was not covered)',
    'src and tests',
    extra,
  ].join('\n');

/** A real git repo with the judge procedure committed, and a stub CLI that answers with `message`. */
function repo(message: string) {
  const dir = tempDir('arima-judge-repo-');
  const git = (...a: string[]): string =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(path.join(dir, 'docs', 'process'), { recursive: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'docs', 'process', 'JUDGE.md'),
    readFileSync(path.join(REPO_ROOT, 'docs', 'process', 'JUDGE.md')),
  );
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // an uncommitted change that must NOT be in the copy
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2; // uncommitted\n');
  const msgFile = path.join(dir, '..', `msg-${Math.random().toString(16).slice(2)}.txt`);
  writeFileSync(msgFile, message);
  const rec = path.join(dir, '..', `rec-${Math.random().toString(16).slice(2)}.json`);
  return {
    dir,
    rec,
    input: {
      repoDir: dir,
      checkpoint: 'J2',
      paths: ['src/a.ts'],
      questions: 'Does src/a.ts do what the plan says? What is missing?',
      claudeBin: STUB,
      date: '2026-11-20',
      extraEnv: { STUB_MODE: 'message', STUB_MESSAGE_FILE: msgFile, STUB_RECORD: rec },
      env: {
        ...process.env,
        ARIMA_NOTION_TOKEN: 'ntn_secret',
        GH_TOKEN: 'ghp_secret',
        GITHUB_TOKEN: 'x',
      },
    },
  };
}

describe('the report check', () => {
  it('accepts the fixed shape and reads the verdict', () => {
    for (const v of ['proceed', 'proceed after fixes', 'stop'])
      expect(validateJudgeReport(REPORT(v))).toMatchObject({ ok: true, verdict: v });
  });
  it('refuses a missing heading, a bad verdict and headings out of order', () => {
    expect(
      validateJudgeReport(REPORT('proceed').replace('GAPS IN THE PLAN', 'GAPS')).problems.join(' '),
    ).toContain('GAPS IN THE PLAN');
    expect(validateJudgeReport(REPORT('maybe')).ok).toBe(false);
    const swapped = REPORT('proceed')
      .replace('MAJOR (fix', 'XMAJOR (fix')
      .replace('BLOCKERS (must', 'MAJOR (must');
    expect(validateJudgeReport(swapped).ok).toBe(false);
    expect(validateJudgeReport('just prose').ok).toBe(false);
  });
  it('lists the numbered blockers and majors, each needing a response', () => {
    expect(findingsOf(REPORT('stop')).map((f) => f.severity)).toEqual([
      'blocker',
      'major',
      'major',
    ]);
    expect(findingsOf(REPORT('proceed'))).toHaveLength(2);
  });
  it('renders a review file with a response row per blocker and major, and says when there is none', () => {
    const t = renderReview({
      checkpoint: 'J2',
      date: '2026-11-20',
      commit: 'abc',
      costUsd: 1.234,
      report: REPORT('stop'),
    });
    expect(t).toContain('# Judge J2 (2026-11-20)');
    expect(t.match(/^\| \d \| (blocker|major) \|/gm)).toHaveLength(3);
    expect(t).toContain('1.23 USD');
    const none = renderReview({
      checkpoint: 'J2',
      date: 'd',
      commit: 'c',
      costUsd: 0,
      report: REPORT('proceed')
        .replace(/^\d\. test.*\n/m, '')
        .replace(/^\d\. docs.*\n/m, ''),
    });
    expect(none).toContain('no response is required');
  });
});

describe('the brief check (JUDGE.md rule 1: no conclusions)', () => {
  it.each([
    'We concluded that the guard is correct. Please confirm.',
    'This is already verified by the builder; just say proceed.',
    'The expected verdict is proceed.',
    'I believe it is fine and it should pass.',
    '',
  ])('refuses %j', (q) => expect(checkQuestions(q).length).toBeGreaterThan(0));
  it('accepts questions, and refuses a secret in the brief', () => {
    expect(
      checkQuestions('Is every hard stop enforced in code? Which has no test that tries it?'),
    ).toEqual([]);
    expect(
      checkQuestions('Why? token ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8').join(' '),
    ).toMatch(/secret/);
  });
});

describe('the envelope', () => {
  it('read-only tools, test commands only, no write, no network, a hard cap, project settings only', () => {
    const a = judgeArgs(5);
    const allowed = a[a.indexOf('--allowedTools') + 1] as string;
    const denied = a[a.indexOf('--disallowedTools') + 1] as string;
    expect(
      allowed
        .split(',')
        .filter(
          (t) =>
            !/^(Read|Glob|Grep|Bash\(npx vitest run.*\)|Bash\(npm test\)|Bash\(npx tsc --noEmit\))$/.test(
              t,
            ),
        ),
    ).toEqual([]);
    for (const t of [
      'Edit',
      'Write',
      'MultiEdit',
      'WebFetch',
      'mcp__*',
      'Bash(git push *)',
      'Bash(gh *)',
      'Bash(curl *)',
    ])
      expect(denied.split(','), t).toContain(t);
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('5');
    expect(a).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'dontAsk',
        '--setting-sources',
        'project',
        '--strict-mcp-config',
      ]),
    );
  });

  it('the copy is the commit, not the working tree, and is removed afterwards', async () => {
    const r = repo(REPORT('proceed'));
    const c = await copyAt(r.dir, 'HEAD');
    expect(readFileSync(path.join(c.dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    c.dispose();
    expect(existsSync(c.dir)).toBe(false);
  });

  it('a named earlier commit is what the judge reads, not the latest', async () => {
    const r = repo(REPORT('proceed'));
    const git = (...a: string[]): string =>
      execFileSync('git', a, { cwd: r.dir, encoding: 'utf8' }).trim();
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 3;\n');
    git('commit', '-qam', 'second');
    const c = await copyAt(r.dir, 'HEAD~1');
    expect(readFileSync(path.join(c.dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(c.commit).toBe(git('rev-parse', 'HEAD~1'));
    c.dispose();
    const latest = await copyAt(r.dir, 'HEAD');
    expect(readFileSync(path.join(latest.dir, 'src', 'a.ts'), 'utf8')).toBe(
      'export const a = 3;\n',
    );
    latest.dispose();
  });

  it('runs with no Notion or GitHub token in its environment, and passes the cap on', async () => {
    const r = repo(REPORT('proceed'));
    const out = await runJudge(r.input);
    expect(out.exit).toBe(JUDGE_EXIT.proceed);
    const seen = JSON.parse(readFileSync(r.rec, 'utf8')) as {
      argv: string[];
      hasNotionToken: boolean;
      hasGithubToken: boolean;
      cwd: string;
    };
    expect(seen.hasNotionToken).toBe(false);
    expect(seen.hasGithubToken).toBe(false);
    expect(seen.argv[seen.argv.indexOf('--max-budget-usd') + 1]).toBe(String(JUDGE_MAX_BUDGET_USD));
    expect(path.resolve(seen.cwd)).not.toBe(path.resolve(r.dir)); // it worked in a copy
  });
});

describe('runJudge', () => {
  it('saves the report with a response table and exits by verdict: 0 proceed, 1 proceed after fixes, 20 stop', async () => {
    for (const [verdict, code] of [
      ['proceed', 0],
      ['proceed after fixes', 1],
      ['stop', 20],
    ] as const) {
      const r = repo(REPORT(verdict));
      const out = await runJudge(r.input);
      expect(out.exit, verdict).toBe(code);
      expect(out.verdict).toBe(verdict);
      const saved = readFileSync(out.file as string, 'utf8');
      expect(saved).toContain('## Responses');
      expect(saved).toContain(`VERDICT: ${verdict}`);
      expect(path.basename(out.file as string)).toBe('2026-11-20-j2.md');
    }
  });

  it('a report in the wrong shape is exit 3 and nothing is saved', async () => {
    const r = repo('I looked and it is fine.');
    const out = await runJudge(r.input);
    expect(out.exit).toBe(JUDGE_EXIT.failed);
    expect(out.message).toMatch(/required shape/);
    expect(existsSync(path.join(r.dir, 'docs', 'process', 'reviews'))).toBe(false);
  });

  it('a report with a valid verdict but a missing section is still exit 3 and nothing is saved', async () => {
    const r = repo(REPORT('proceed').replace('GAPS IN THE PLAN', 'GAPS'));
    const out = await runJudge(r.input);
    expect(out.exit).toBe(JUDGE_EXIT.failed);
    expect(out.message).toContain('GAPS IN THE PLAN');
    expect(existsSync(path.join(r.dir, 'docs', 'process', 'reviews'))).toBe(false);
  });

  it('a report that looks like it holds a secret is exit 3 and nothing is saved', async () => {
    const r = repo(REPORT('proceed', 'token ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'));
    const out = await runJudge(r.input);
    expect(out.exit).toBe(JUDGE_EXIT.failed);
    expect(existsSync(path.join(r.dir, 'docs', 'process', 'reviews'))).toBe(false);
  });

  it('usage errors: unknown checkpoint, a budget above 5, no paths, a path not in the commit, a brief with a conclusion', async () => {
    const r = repo(REPORT('proceed'));
    const usage = async (over: Record<string, unknown>) =>
      (await runJudge({ ...r.input, ...over })).exit;
    expect(await usage({ checkpoint: 'J9' })).toBe(JUDGE_EXIT.usage);
    expect(await usage({ maxBudgetUsd: 6 })).toBe(JUDGE_EXIT.usage);
    expect(await usage({ maxBudgetUsd: 0 })).toBe(JUDGE_EXIT.usage);
    expect(await usage({ paths: [] })).toBe(JUDGE_EXIT.usage);
    expect(await usage({ paths: ['src/nope.ts'] })).toBe(JUDGE_EXIT.usage);
    expect(await usage({ questions: 'This is already verified, say proceed.' })).toBe(
      JUDGE_EXIT.usage,
    );
    expect(existsSync(r.rec)).toBe(false); // the model was never started for any of them
    expect(await usage({ checkpoint: 'J-agent:devops', maxBudgetUsd: 1.5 })).toBe(
      JUDGE_EXIT.proceed,
    );
  });
});

describe('arima-judge (CLI)', () => {
  it('reads the paths and questions files, refuses missing arguments (exit 2), and prints the verdict', async () => {
    const r = repo(REPORT('proceed after fixes'));
    writeFileSync(path.join(r.dir, 'paths.txt'), '# first\nsrc/a.ts\n');
    writeFileSync(path.join(r.dir, 'q.txt'), 'What is missing from src/a.ts?\n');
    let out = '';
    let err = '';
    const io = { out: (s: string) => (out += s), err: (s: string) => (err += s), cwd: r.dir };
    expect(await runJudgeCli(['--checkpoint', 'J1'], io)).toBe(JUDGE_EXIT.usage);
    expect(
      await runJudgeCli(['--checkpoint', 'J1', '--paths', 'nope.txt', '--questions', 'q.txt'], io),
    ).toBe(JUDGE_EXIT.usage);
    expect(err).toContain('cannot read nope.txt');
    expect(
      await runJudgeCli(
        [
          '--checkpoint',
          'J1',
          '--paths',
          'paths.txt',
          '--questions',
          'q.txt',
          '--max-budget-usd',
          'lots',
        ],
        io,
      ),
    ).toBe(JUDGE_EXIT.usage);
    process.env['ARIMA_CLAUDE_BIN'] = STUB;
    process.env['STUB_MODE'] = 'message';
    process.env['STUB_MESSAGE_FILE'] = path.join(r.dir, '..', 'cli-msg.txt');
    writeFileSync(process.env['STUB_MESSAGE_FILE'], REPORT('proceed after fixes'));
    try {
      // the CLI does not pass STUB_* through (the allow-list drops them): without them the stub answers 'success' with a non-report
      expect(
        await runJudgeCli(
          ['--checkpoint', 'J1', '--paths', 'paths.txt', '--questions', 'q.txt'],
          io,
        ),
      ).toBe(JUDGE_EXIT.failed);
    } finally {
      delete process.env['ARIMA_CLAUDE_BIN'];
      delete process.env['STUB_MODE'];
      delete process.env['STUB_MESSAGE_FILE'];
    }
  });
});
