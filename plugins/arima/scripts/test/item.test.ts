// WP-106: item model (counters, types, sizes) and the profile-aware Definition of Ready.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog, validateDocument } from '../src/catalog.js';
import {
  ITEM_STATUSES,
  ITEM_TYPES,
  SIZE_POINTS,
  SIZES,
  checkDoR,
  itemFile,
  newItem,
  readItem,
  renderDorDod,
  screensSection,
  splitCriteria,
  storyScreens,
  updateItem,
} from '../src/item.js';
import type { DoRInput, DoRElement } from '../src/item.js';
import { appendLedgerRow, buildLedgerRow } from '../src/ledger.js';
import { PROFILE_NAMES, loadProfile } from '../src/profiles.js';
import { tempDir } from './helpers.js';

const GOOD_AC =
  '1. Given a cart with 2 items When I open the summary Then I see the total\n2. Given an empty cart When I open the summary Then I see an empty state';

const ready = (over: Partial<DoRInput> = {}): DoRInput => ({
  id: 'US-112',
  type: 'Story',
  complexity: 'M',
  acceptance_criteria: GOOD_AC,
  linked_reqs: ['REQ-014'],
  screens: 'n/a',
  open_dependencies: [],
  api_covered: true,
  ...over,
});

const elements = (dir: string, input: DoRInput, profile = 'solo-lite'): DoRElement[] =>
  checkDoR(dir, input, loadProfile(profile)).problems.map((p) => p.element);

function screens(dir: string, id: string, files: string[]): void {
  const d = path.join(dir, 'design', 'screens', id);
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(path.join(d, f), 'x');
}
const ALL_SCREENS = ['empty.html', 'loading.html', 'error.html', 'success.html', 'a11y.md'];

describe('checkDoR: every missing element is named', () => {
  it('a complete story is ready', () => {
    const r = checkDoR(tempDir(), ready(), loadProfile('solo-lite'));
    expect(r).toEqual({ ready: true, problems: [] });
  });

  it('fails for each missing element and names it', () => {
    const dir = tempDir();
    const cases: [Partial<DoRInput>, DoRElement][] = [
      [{ acceptance_criteria: '' }, 'acceptance_criteria'],
      [{ acceptance_criteria: undefined }, 'acceptance_criteria'],
      [{ acceptance_criteria: 'It should work well' }, 'criteria_format'],
      [{ linked_reqs: [] }, 'linked_req'],
      [{ linked_reqs: ['story 4'] }, 'linked_req'],
      [{ complexity: undefined }, 'complexity'],
      [{ complexity: 'XL' }, 'complexity'],
      [{ screens: '' }, 'screens'],
      [{ screens: '<!-- links into design/ -->' }, 'screens'],
      [{ open_dependencies: ['US-100'] }, 'dependencies'],
      [{ api_covered: false }, 'api_coverage'],
      [{ api_covered: undefined }, 'api_coverage'],
    ];
    for (const [over, element] of cases)
      expect(elements(dir, ready(over)), JSON.stringify(over)).toEqual([element]);
  });

  it('reports every problem at once, with detail', () => {
    const r = checkDoR(
      tempDir(),
      ready({
        acceptance_criteria: '',
        linked_reqs: [],
        complexity: '',
        open_dependencies: ['US-1', 'US-2'],
      }),
      loadProfile('solo-lite'),
    );
    expect(r.ready).toBe(false);
    expect(r.problems.map((p) => p.element)).toEqual([
      'acceptance_criteria',
      'linked_req',
      'complexity',
      'dependencies',
    ]);
    expect(r.problems.find((p) => p.element === 'dependencies')?.detail).toBe(
      'open dependencies: US-1, US-2',
    );
  });

  it('each criterion must be Given/When/Then; the one that is not is named by number', () => {
    const r = checkDoR(
      tempDir(),
      ready({
        acceptance_criteria:
          '1. Given a When b Then c\n2. The page loads fast\n3. Given x\nWhen y\nThen z',
      }),
      loadProfile('solo-lite'),
    );
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.detail).toMatch(/criterion 2 is not Given\/When\/Then/);
  });
});

describe('screens for UI stories are checked from design/screens files', () => {
  it('a UI story needs all four states and a11y.md; each missing file is named', () => {
    const dir = tempDir();
    const input = ready({ screens: 'See design/screens/US-112/' });
    const none = checkDoR(dir, input, loadProfile('solo-lite')).problems.map((p) => p.detail);
    expect(none).toHaveLength(5);
    expect(none.join('\n')).toMatch(
      /empty\.html[\s\S]*loading\.html[\s\S]*error\.html[\s\S]*success\.html[\s\S]*a11y\.md/,
    );
    screens(dir, 'US-112', ['empty.html', 'loading.html', 'success.html']);
    const some = checkDoR(dir, input, loadProfile('solo-lite')).problems.map((p) => p.detail);
    expect(some).toHaveLength(2);
    expect(some.join('\n')).toMatch(/error\.html/);
    expect(some.join('\n')).toMatch(/a11y\.md/);
    screens(dir, 'US-112', ALL_SCREENS);
    expect(checkDoR(dir, input, loadProfile('solo-lite')).ready).toBe(true);
  });

  it('screens of another story do not count, and "n/a" skips the check', () => {
    const dir = tempDir();
    screens(dir, 'US-999', ALL_SCREENS);
    expect(elements(dir, ready({ screens: 'design/screens/US-112/' }))).toEqual(
      Array(5).fill('screens'),
    );
    expect(elements(dir, ready({ screens: 'N/A, no UI' }))).toEqual([]);
  });

  it('storyScreens and screensSection read the story body', () => {
    expect(storyScreens(undefined)).toBe('unknown');
    expect(storyScreens('<!-- links -->\n')).toBe('unknown');
    expect(storyScreens('none')).toBe('no_ui');
    expect(storyScreens('design/screens/US-1/')).toBe('ui');
    const body = '# US-1: x\n\n## Story\nAs a\n\n## Screens\nn/a\n\n## Test cases\n';
    expect(screensSection(body)?.trim()).toBe('n/a');
    expect(screensSection('## Story\nx\n')).toBeUndefined();
    expect(screensSection('## Screens\nlast section')?.trim()).toBe('last section');
  });
});

describe('item types have DoR variants', () => {
  const dir = tempDir();
  it('a spike needs its questions and a size, and no Given/When/Then, REQ, screens or API', () => {
    const spike: DoRInput = {
      id: 'US-200',
      type: 'Spike',
      complexity: 'S',
      acceptance_criteria: 'Which queue library fits our load?',
      linked_reqs: [],
      open_dependencies: [],
    };
    expect(checkDoR(dir, spike, loadProfile('regulated')).ready).toBe(true);
    expect(elements(dir, { ...spike, acceptance_criteria: '' })).toEqual(['acceptance_criteria']);
    expect(
      checkDoR(dir, { ...spike, acceptance_criteria: '' }, loadProfile('solo-lite')).problems[0]
        ?.detail,
    ).toMatch(/question/);
  });

  it('a tech task needs criteria (plain list) and a size; a REQ only where the profile traces every item', () => {
    const task: DoRInput = {
      id: 'US-201',
      type: 'Tech task',
      complexity: 'M',
      acceptance_criteria: '- CI runs lint\n- CI runs tests',
      linked_reqs: [],
      open_dependencies: [],
    };
    expect(checkDoR(dir, task, loadProfile('solo-lite')).ready).toBe(true);
    expect(checkDoR(dir, task, loadProfile('client-project')).ready).toBe(true);
    expect(elements(dir, task, 'regulated')).toEqual(['linked_req']);
    expect(
      checkDoR(dir, { ...task, linked_reqs: ['REQ-003'] }, loadProfile('regulated')).ready,
    ).toBe(true);
    expect(elements(dir, { ...task, open_dependencies: ['US-1'] })).toEqual(['dependencies']);
  });

  it('a bug fix needs Given/When/Then criteria, a size, an API check; a REQ only in regulated; screens only if it says so', () => {
    const fix: DoRInput = {
      id: 'BUG-045',
      type: 'Bug fix',
      complexity: 'S',
      acceptance_criteria: 'Given a 0 price When I add it Then the total is 0',
      linked_reqs: [],
      open_dependencies: [],
      api_covered: true,
    };
    expect(checkDoR(dir, fix, loadProfile('solo-lite')).ready).toBe(true);
    expect(elements(dir, fix, 'regulated')).toEqual(['linked_req']);
    expect(elements(dir, { ...fix, acceptance_criteria: 'fix it' })).toEqual(['criteria_format']);
    expect(elements(dir, { ...fix, api_covered: undefined })).toEqual(['api_coverage']);
    expect(elements(dir, { ...fix, screens: 'design/screens/BUG-045/' })).toEqual(
      Array(5).fill('screens'),
    );
  });
});

describe('splitCriteria', () => {
  it('splits on numbers, bullets and Given, and joins continuation lines', () => {
    expect(splitCriteria('1. a\n2) b\n- c\n* d')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitCriteria('Given a\nWhen b\nThen c\nGiven d When e Then f')).toEqual([
      'Given a When b Then c',
      'Given d When e Then f',
    ]);
    expect(splitCriteria('\n\n')).toEqual([]);
  });
});

describe('item counters (03-contracts 9a)', () => {
  const RUN = 'r-20261119-1000-01';

  it('an untouched item has the initial counters', () => {
    expect(readItem(tempDir(), 'US-112')).toEqual(newItem('US-112'));
    expect(newItem('US-112')).toMatchObject({ attempt: 1, run_failures: 0, cost_usd_total: 0 });
  });

  it('updateItem writes a validated file and re-derives the cost from the ledger', async () => {
    const dir = tempDir();
    await appendLedgerRow(
      dir,
      buildLedgerRow(
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          total_cost_usd: 0.6,
          duration_ms: 1,
          num_turns: 1,
        },
        {
          run_id: RUN,
          date: '2026-11-19',
          project: 'TAS',
          phase: 4,
          item: 'US-112',
          role: 'developer',
          attempt: 1,
          is_rework: false,
          budget_usd: 2,
        },
      ),
    );
    const a = await updateItem(dir, 'US-112', (i) => ({ ...i, attempt: 2, cost_usd_total: 999 }));
    expect(a).toMatchObject({ attempt: 2, cost_usd_total: 0.6 });
    expect(JSON.parse(readFileSync(itemFile(dir, 'US-112'), 'utf8'))).toEqual(a);
    const b = await updateItem(dir, 'US-112', (i) => ({
      ...i,
      run_failures: 1,
      blocked_from: 'In Review',
      blocked_reason: 'third failed review',
    }));
    expect(b).toMatchObject({ attempt: 2, run_failures: 1, blocked_from: 'In Review' });
    expect(readItem(dir, 'US-112')).toEqual(b);
  });

  it('refuses an invalid record and a corrupt or foreign file, and never writes them', async () => {
    const dir = tempDir();
    await expect(updateItem(dir, 'US-112', (i) => ({ ...i, attempt: 0 }))).rejects.toThrow(
      /Invalid item/,
    );
    expect(existsSync(itemFile(dir, 'US-112'))).toBe(false);
    await expect(
      updateItem(dir, 'US-112', (i) => ({ ...i, blocked_from: 'Done' as never })),
    ).rejects.toThrow(/Invalid item/);
    mkdirSync(path.dirname(itemFile(dir, 'US-113')), { recursive: true });
    writeFileSync(itemFile(dir, 'US-113'), JSON.stringify({ ...newItem('US-999') }));
    expect(() => readItem(dir, 'US-113')).toThrow(/holds item US-999/);
    writeFileSync(itemFile(dir, 'US-114'), '{"schema_version":1}');
    expect(() => readItem(dir, 'US-114')).toThrow(/Corrupt/);
  });
});

describe('types, sizes and states', () => {
  it('match the Notion template and the spec', async () => {
    const { DATABASES } = await import('../src/notion/schema.js');
    const stories = DATABASES.find((d) => d.key === 'stories')!;
    const opts = (name: string): string[] =>
      (stories.props.find((p) => p.name === name) as unknown as { options: string[] }).options;
    expect([...ITEM_TYPES]).toEqual(opts('Type'));
    expect([...ITEM_STATUSES]).toEqual(opts('Status'));
    expect([...SIZES]).toEqual(opts('Complexity'));
    expect(SIZE_POINTS).toEqual({ S: 1, M: 2, L: 4 });
  });
});

describe('the DoR and DoD page is rendered from the profile', () => {
  it('has exactly the required sections of the dor-dod artifact, for every profile', () => {
    for (const name of PROFILE_NAMES) {
      const md = renderDorDod(loadProfile(name));
      expect(validateDocument(md, 'dor-dod', loadCatalog())).toEqual({ ok: true, missing: [] });
      expect(md.match(/^## /gm)).toHaveLength(2);
      expect(md).toContain(`profile ${name}`);
    }
  });

  it('follows the profile: reviewers, RTM coverage and the REQ rule differ', () => {
    const solo = renderDorDod(loadProfile('solo-lite'));
    const reg = renderDorDod(loadProfile('regulated'));
    expect(solo).toContain('No traceability coverage rule applies at G3');
    expect(solo).toContain('A linked REQ is not required.');
    expect(reg).toContain('Every requirement is covered by a story and a passing test case at G3.');
    expect(reg).toContain('At least one linked REQ (this profile traces every item).');
    expect(solo).not.toBe(reg);
    for (const md of [solo, reg]) {
      expect(md).toContain('the human approves the pull request');
      expect(md).toMatch(/Given \/ When \/ Then/);
      expect(md).toContain('empty, loading, error and success');
    }
  });

  it('the page and the checker agree: a rule the page states for a profile is what checkDoR enforces', () => {
    // regulated page says tech tasks need a REQ; the checker agrees (see "item types" above)
    const dir = tempDir();
    const task: DoRInput = {
      id: 'US-201',
      type: 'Tech task',
      complexity: 'S',
      acceptance_criteria: '- done',
      linked_reqs: [],
      open_dependencies: [],
    };
    for (const name of PROFILE_NAMES) {
      const says = renderDorDod(loadProfile(name)).includes(
        'At least one linked REQ (this profile traces every item).',
      );
      expect(elements(dir, task, name).includes('linked_req'), name).toBe(says);
    }
  });
});
