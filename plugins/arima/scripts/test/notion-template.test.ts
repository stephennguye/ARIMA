import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runNotionCli } from '../src/cli/notion-cli.js';
import { Throttle } from '../src/lib/throttle.js';
import { getValidator } from '../src/lib/schema.js';
import { VERSION_MARKER, bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { createNotionPort } from '../src/notion/port.js';
import { toApiProperty } from '../src/notion/props.js';
import { DATABASES, LAST_WRITTEN_BY_RUN, expandedSpec } from '../src/notion/schema.js';
import type { PropSpec } from '../src/notion/schema.js';
import { FakeNotion } from './fake-notion.js';
import { project, tempDir } from './helpers.js';

const newPort = (fake: FakeNotion) => createNotionPort(fake.client, new Throttle(0));
const built = async () => {
  const fake = new FakeNotion();
  const port = newPort(fake);
  const report = await bootstrapTemplate(port, fake.rootId);
  return { fake, port, report };
};

describe('template schema (spec §9.1, §9.3)', () => {
  const specs = expandedSpec();

  it('defines exactly the 19 databases of the spec', () => {
    expect(DATABASES).toHaveLength(19);
    expect(specs.map((s) => s.title).sort()).toEqual(
      [
        'Gates',
        'Requirements',
        'Epics',
        'Stories',
        'Test Cases',
        'Bugs',
        'Milestones',
        'Documents',
        'Decisions',
        'Questions',
        'Meetings',
        'Digests',
        'Releases',
        'Incidents',
        'Change Requests',
        'Risks',
        'Lessons',
        'Cost log',
        'Human tasks',
      ].sort(),
    );
  });

  it('gives every database one title property, unique names and the audit property', () => {
    for (const s of specs) {
      expect(
        s.props.filter((p) => p.type === 'title'),
        s.title,
      ).toHaveLength(1);
      const names = s.props.map((p) => p.name);
      expect(new Set(names).size, `${s.title} has duplicate property names`).toBe(names.length);
      expect(names).toContain(LAST_WRITTEN_BY_RUN);
    }
  });

  it('makes every relation two-way and consistent', () => {
    for (const s of specs) {
      for (const p of s.props.filter((x) => x.type === 'relation')) {
        const target = specs.find((t) => t.key === p.relation?.target);
        const back = target?.props.find((x) => x.name === p.relation?.reverse);
        expect(back, `${s.title}.${p.name}`).toBeDefined();
        expect(back?.relation).toEqual({ target: s.key, reverse: p.name });
      }
    }
  });

  it('only rolls up and formulas over properties that exist', () => {
    for (const s of specs) {
      for (const p of s.props.filter((x) => x.type === 'rollup')) {
        const rel = s.props.find((x) => x.name === p.rollup?.relation);
        expect(rel?.type, `${s.title}.${p.name}`).toBe('relation');
        const target = specs.find((t) => t.key === rel?.relation?.target);
        expect(
          target?.props.some((x) => x.name === p.rollup?.property),
          `${s.title}.${p.name}`,
        ).toBe(true);
      }
      for (const p of s.props.filter((x) => x.type === 'formula')) {
        for (const ref of [...(p.formula ?? '').matchAll(/prop\("([^"]+)"\)/g)].map((m) => m[1])) {
          expect(
            s.props.some((x) => x.name === ref),
            `${s.title}.${p.name} reads ${ref}`,
          ).toBe(true);
        }
      }
    }
  });

  it('flags exactly the human-only fields of §9.3', () => {
    const flagged = specs.flatMap((s) =>
      s.props
        .filter((p) => p.humanOnly === true || p.humanOnlyValues !== undefined)
        .map((p) => `${s.title}.${p.name}`),
    );
    expect(flagged.sort()).toEqual(
      [
        'Gates.Approvers',
        'Gates.Decided by',
        'Gates.Status',
        'Digests.Reviewed by',
        'Digests.Minutes spent',
        'Decisions.Veto',
        'Decisions.Veto reason',
        'Questions.Answer',
        'Questions.Answered by',
        'Releases.Prod deploy approval',
        'Releases.Prod deploy approver',
        'Change Requests.Decision',
        'Change Requests.Approver',
      ].sort(),
    );
  });

  it('covers the story state machine and spec property lists', () => {
    const stories = specs.find((s) => s.key === 'stories')!;
    const status = stories.props.find((p) => p.name === 'Status')!;
    expect(status.options).toEqual([
      'Backlog',
      'Ready',
      'In Progress',
      'In Review',
      'In QA',
      'PO Acceptance',
      'Done',
      'Released',
      'Blocked',
      'Cancelled',
    ]);
    for (const n of [
      'Complexity',
      'Acceptance criteria',
      'Assigned role',
      'Assignee',
      'PR link',
      'Attempt',
      'Budget USD',
      'Cost USD',
      'Blocked reason',
      'Started',
      'Done',
      'Epic',
      'Requirements',
      'Milestone',
      'Test Cases',
      'Bugs',
      'Questions',
      'Cost log',
    ]) {
      expect(
        stories.props.map((p) => p.name),
        n,
      ).toContain(n);
    }
  });

  it('avoids characters Notion rejects in select options', () => {
    for (const s of specs)
      for (const p of s.props) for (const o of p.options ?? []) expect(o).not.toContain(',');
  });
});

describe('bootstrap (mocked Notion)', () => {
  it('creates all 19 databases with every property and relation', async () => {
    const { fake, report } = await built();
    expect(report.created).toHaveLength(19);
    expect(report.manual).toEqual([]);
    for (const s of expandedSpec()) {
      const actual = fake.props(s.title);
      for (const p of s.props) {
        expect(actual.get(p.name)?.type, `${s.title}.${p.name}`).toBe(p.type);
        if (p.type === 'select') {
          expect(actual.get(p.name)?.select?.options.map((o) => o.name)).toEqual(p.options);
        }
      }
    }
  });

  it('wires relations to the right data sources, with reverse properties', async () => {
    const { fake } = await built();
    const sourceOf = (title: string): string =>
      fake.databases.get(fake.dbIdByTitle(title))!.dataSourceId;
    expect(fake.props('Stories').get('Requirements')?.relation?.data_source_id).toBe(
      sourceOf('Requirements'),
    );
    expect(fake.props('Requirements').get('Stories')?.relation?.data_source_id).toBe(
      sourceOf('Stories'),
    );
    expect(fake.props('Stories').get('Epic')?.relation?.data_source_id).toBe(sourceOf('Epics'));
    expect(fake.props('Milestones').get('Cost log')?.relation?.data_source_id).toBe(
      sourceOf('Cost log'),
    );
  });

  it('writes the template schema version once', async () => {
    const { fake, port } = await built();
    const marks = (fake.pages.get(fake.rootId) ?? []).filter((b) => b.type === 'paragraph');
    expect(marks).toHaveLength(1);
    await bootstrapTemplate(port, fake.rootId);
    expect((fake.pages.get(fake.rootId) ?? []).filter((b) => b.type === 'paragraph')).toHaveLength(
      1,
    );
    expect(JSON.stringify(marks[0])).toContain(VERSION_MARKER);
  });

  it('is idempotent: a second run creates and adds nothing', async () => {
    const { fake, port } = await built();
    const before = fake.calls.filter((c) => c === 'databases.create').length;
    const again = await bootstrapTemplate(port, fake.rootId);
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(19);
    expect(again.added).toEqual([]);
    expect(fake.calls.filter((c) => c === 'databases.create').length).toBe(before);
  });

  it('reports formulas or rollups the API refuses as manual steps, and finishes everything else', async () => {
    const fake = new FakeNotion();
    fake.rejectProperty = (_t, name) =>
      name === 'Coverage' ? 'formula not supported here' : undefined;
    const report = await bootstrapTemplate(newPort(fake), fake.rootId);
    expect(report.manual).toHaveLength(1);
    expect(report.manual[0]).toMatchObject({ database: 'Requirements', property: 'Coverage' });
    expect(report.manual[0]?.hint).toContain('Test results');
    expect(fake.props('Requirements').has('Coverage')).toBe(false);
    expect(fake.props('Risks').has('Score')).toBe(true);
    expect(fake.props('Stories').has('Cost USD')).toBe(true);
  });

  it('a re-run completes what a refused step left open', async () => {
    const fake = new FakeNotion();
    fake.rejectProperty = (_t, name) => (name === 'Coverage' ? 'nope' : undefined);
    const port = newPort(fake);
    await bootstrapTemplate(port, fake.rootId);
    fake.rejectProperty = () => undefined;
    const second = await bootstrapTemplate(port, fake.rootId);
    expect(second.added).toEqual(['Requirements.Coverage']);
    expect(second.manual).toEqual([]);
  });

  it('never alters an existing property (the port refuses)', async () => {
    const { fake, port } = await built();
    const ds = fake.databases.get(fake.dbIdByTitle('Stories'))!.dataSourceId;
    await expect(
      port.addProperties(ds, { Status: { select: { options: [{ name: 'Only one' }] } } }),
    ).rejects.toThrow(/refusing to alter existing/);
    expect(fake.props('Stories').get('Status')?.select?.options.length).toBe(10);
  });

  it('sends the audit property and a title on every created database', async () => {
    const { fake } = await built();
    for (const d of DATABASES) {
      expect(fake.props(d.title).has(LAST_WRITTEN_BY_RUN)).toBe(true);
    }
  });
});

describe('map (mocked Notion)', () => {
  it('maps a fresh duplicate: all 19 databases, valid against the schema, with ids and human-only flags', async () => {
    const { fake, port } = await built();
    const r = await mapWorkspace(port, fake.rootId, { now: new Date('2026-11-18T00:00:00Z') });
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const map = r.map!;
    expect(Object.keys(map.databases)).toHaveLength(19);
    const validate = getValidator('notion-map');
    expect(validate(map), JSON.stringify(validate.errors)).toBe(true);
    expect(map.databases['stories']?.database_id).toBe(fake.dbIdByTitle('Stories'));
    expect(map.databases['gates']?.properties['Approvers']).toMatchObject({
      type: 'people',
      human_only: true,
    });
    expect(map.databases['gates']?.properties['Status']).toMatchObject({
      human_only_values: ['Approved', 'Approved with conditions', 'Rejected'],
    });
    expect(map.databases['decisions']?.properties['Veto']?.human_only).toBe(true);
    expect(map.databases['stories']?.properties['Status']?.human_only).toBeUndefined();
    expect(map.databases['stories']?.properties['Status']?.id).toBe(
      fake.props('Stories').get('Status')?.id,
    );
  });

  it('reports a missing database', async () => {
    const { fake, port } = await built();
    const blocks = fake.pages.get(fake.rootId)!;
    blocks.splice(
      blocks.findIndex((b) => b.type === 'child_database'),
      1,
    );
    const r = await mapWorkspace(port, fake.rootId);
    expect(r.map).toBeUndefined();
    expect(r.issues.some((i) => i.kind === 'missing_database')).toBe(true);
  });

  it('reports ambiguous duplicates', async () => {
    const { fake, port } = await built();
    const blocks = fake.pages.get(fake.rootId)!;
    blocks.push({ id: 'dup', type: 'child_database', child_database: { title: 'Stories' } });
    const r = await mapWorkspace(port, fake.rootId);
    expect(r.issues.some((i) => i.kind === 'ambiguous_database')).toBe(true);
  });

  it('reports a missing property, and --migrate adds it', async () => {
    const { fake, port } = await built();
    fake.humanDeleteProperty('Stories', 'Attempt');
    const bad = await mapWorkspace(port, fake.rootId);
    expect(bad.map).toBeUndefined();
    expect(bad.issues).toContainEqual(
      expect.objectContaining({
        kind: 'missing_property',
        database: 'Stories',
        property: 'Attempt',
      }),
    );

    const fixed = await mapWorkspace(port, fake.rootId, { migrate: true });
    expect(fixed.migrated).toEqual(['Stories.Attempt']);
    expect(fixed.map).toBeDefined();
    expect(fake.props('Stories').get('Attempt')?.type).toBe('number');
  });

  it('--migrate recreates a deleted relation pair', async () => {
    const { fake, port } = await built();
    fake.humanDeleteProperty('Stories', 'Bugs');
    fake.humanDeleteProperty('Bugs', 'Story');
    const r = await mapWorkspace(port, fake.rootId, { migrate: true });
    expect(r.migrated).toContain('Stories.Bugs');
    expect(r.map).toBeDefined();
    expect(fake.props('Bugs').get('Story')?.type).toBe('relation');
  });

  it('reports a wrong property type and does not migrate it', async () => {
    const { fake, port } = await built();
    fake.humanRetypeProperty('Stories', 'Budget USD', 'rich_text');
    const r = await mapWorkspace(port, fake.rootId, { migrate: true });
    expect(r.map).toBeUndefined();
    expect(r.issues).toContainEqual(
      expect.objectContaining({ kind: 'wrong_type', property: 'Budget USD' }),
    );
    expect(fake.props('Stories').get('Budget USD')?.type).toBe('rich_text');
  });

  it('warns about a missing select option but still maps', async () => {
    const { fake, port } = await built();
    const opts = fake.props('Stories').get('Complexity')!.select!.options;
    opts.splice(
      opts.findIndex((o) => o.name === 'L'),
      1,
    );
    const r = await mapWorkspace(port, fake.rootId);
    expect(r.map).toBeDefined();
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        kind: 'missing_option',
        property: 'Complexity',
      }),
    );
  });

  it('flags a relation that points at the wrong database', async () => {
    const { fake, port } = await built();
    const wrong = fake.databases.get(fake.dbIdByTitle('Bugs'))!.dataSourceId;
    fake.props('Stories').get('Requirements')!.relation = { data_source_id: wrong };
    const r = await mapWorkspace(port, fake.rootId);
    expect(
      r.issues.some((i) => i.kind === 'wrong_relation_target' && i.property === 'Requirements'),
    ).toBe(true);
  });

  it('warns when the version marker is missing and errors when the template is newer', async () => {
    const { fake, port } = await built();
    const blocks = fake.pages.get(fake.rootId)!;
    const idx = blocks.findIndex((b) => b.type === 'paragraph');
    const saved = blocks.splice(idx, 1)[0]!;
    const warn = await mapWorkspace(port, fake.rootId);
    expect(warn.map).toBeDefined();
    expect(warn.issues.some((i) => i.kind === 'missing_version' && i.severity === 'warning')).toBe(
      true,
    );

    blocks.push({ ...saved, paragraph: { rich_text: [{ plain_text: `${VERSION_MARKER} 99` }] } });
    const newer = await mapWorkspace(port, fake.rootId);
    expect(newer.map).toBeUndefined();
    expect(newer.issues.some((i) => i.kind === 'newer_version')).toBe(true);
  });
});

describe('arima-notion CLI', () => {
  const run = async (
    argv: string[],
    cwd: string,
    fake: FakeNotion,
    env: NodeJS.ProcessEnv = { ARIMA_NOTION_TOKEN: 'ntn_fake_token_value_for_test' },
  ) => {
    let out = '';
    let err = '';
    const code = await runNotionCli(
      argv,
      { out: (s) => (out += s), err: (s) => (err += s), cwd },
      { portFactory: () => newPort(fake), env, now: new Date('2026-11-18T00:00:00Z') },
    );
    return { code, out, err };
  };

  it('bootstrap builds the template and prints the manual-view reminder', async () => {
    const fake = new FakeNotion();
    const r = await run(['bootstrap', '--parent', fake.rootId], tempDir(), fake);
    expect(r.code).toBe(0);
    expect(r.out).toContain('19 created');
    expect(r.out).toContain('views are not created');
  });

  it('map writes a valid .arima/notion-map.json', async () => {
    const fake = new FakeNotion();
    await bootstrapTemplate(newPort(fake), fake.rootId);
    const dir = tempDir();
    const r = await run(['map', '--root', fake.rootId, '--project', dir], tempDir(), fake);
    expect(r.code).toBe(0);
    const file = path.join(dir, '.arima', 'notion-map.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as object;
    expect(getValidator('notion-map')(parsed)).toBe(true);
  });

  it('map reads the root page id from arima.yaml', async () => {
    const fake = new FakeNotion('page-from-config');
    await bootstrapTemplate(newPort(fake), 'page-from-config');
    const dir = project({
      arima: [['"<duplicated template root page id>"', '"page-from-config"']],
    });
    const r = await run(['map', '--project', dir], tempDir(), fake);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, '.arima', 'notion-map.json'))).toBe(true);
  });

  it('map exits 1 and writes nothing when verification fails', async () => {
    const fake = new FakeNotion();
    await bootstrapTemplate(newPort(fake), fake.rootId);
    fake.humanDeleteProperty('Stories', 'Attempt');
    const dir = tempDir();
    const r = await run(['map', '--root', fake.rootId, '--project', dir], tempDir(), fake);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR');
    expect(existsSync(path.join(dir, '.arima', 'notion-map.json'))).toBe(false);
    const fixed = await run(
      ['map', '--root', fake.rootId, '--project', dir, '--migrate'],
      tempDir(),
      fake,
    );
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain('added    Stories.Attempt');
  });

  it('exits 2 without a token and never prints the token', async () => {
    const fake = new FakeNotion();
    const none = await run(['bootstrap', '--parent', fake.rootId], tempDir(), fake, {});
    expect(none.code).toBe(2);
    const token = 'ntn_super_secret_value_do_not_print_123';
    const ok = await run(['bootstrap', '--parent', fake.rootId], tempDir(), fake, {
      ARIMA_NOTION_TOKEN: token,
    });
    expect(ok.out + ok.err).not.toContain(token);
  });

  it('exits 2 on bad usage', async () => {
    const fake = new FakeNotion();
    expect((await run([], tempDir(), fake)).code).toBe(2);
    expect((await run(['bootstrap'], tempDir(), fake)).code).toBe(2);
    expect((await run(['map'], tempDir(), fake)).code).toBe(2);
  });
});

describe('Requirements.Coverage formula (real API: a formula on a select rollup is text)', () => {
  const COVERAGE = 'if(contains(prop("Test results"), "Pass"), "Covered", "Not covered")';
  const coverage = () =>
    expandedSpec()
      .find((s) => s.title === 'Requirements')
      ?.props.find((p) => p.name === 'Coverage');

  it('uses contains() on the rollup, not .some(current == ...)', () => {
    expect(coverage()).toMatchObject({ type: 'formula', formula: COVERAGE });
    expect(JSON.stringify(coverage())).not.toContain('.some(');
  });

  it('the property body sent to Notion carries exactly that expression', () => {
    expect(toApiProperty(coverage() as PropSpec)).toEqual({ formula: { expression: COVERAGE } });
  });

  it('docs/NOTION-TEMPLATE.md shows the same formula for the manual step', () => {
    const doc = readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'NOTION-TEMPLATE.md'),
      'utf8',
    );
    expect(doc).toContain(COVERAGE);
    expect(doc).not.toContain('.some(current');
  });
});
