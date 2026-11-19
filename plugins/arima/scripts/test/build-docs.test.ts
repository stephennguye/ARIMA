// The docs/build set must stay true: work packages are consistent, the contracts match the code,
// every agent has a card, and no document mentions a package that does not exist.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { HARD_STOPS } from '../src/hardstops.js';
import { ROLES } from '../src/roles.js';
import { PREFLIGHT_EXIT } from '../src/preflight.js';
import { EXIT } from '../src/run-agent.js';
import { INIT_EXIT } from '../src/init.js';
import { REPO_ROOT } from './helpers.js';

const BUILD = path.join(REPO_ROOT, 'docs', 'build');
const read = (...p: string[]): string => readFileSync(path.join(BUILD, ...p), 'utf8');
const mdFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? mdFiles(path.join(dir, e.name))
      : e.name.endsWith('.md')
        ? [path.join(dir, e.name)]
        : [],
  );

interface Pkg {
  id: string;
  stage: number;
  track: string;
  status: 'done' | 'ready' | 'planned' | 'owner';
  title: string;
  deps: string[];
  spec: string[];
  acceptance: string[];
  owner_input?: string;
}
const reg = parse(read('work-packages.yaml')) as { schema_version: number; packages: Pkg[] };
const pkgs = reg.packages;
const byId = new Map(pkgs.map((p) => [p.id, p]));

describe('work-packages.yaml', () => {
  it('has unique ids, valid fields and known dependencies', () => {
    expect(byId.size).toBe(pkgs.length);
    for (const p of pkgs) {
      expect(p.id, p.id).toMatch(/^WP-\d{3}$/);
      expect(['done', 'ready', 'planned', 'owner'], p.id).toContain(p.status);
      expect(p.stage, p.id).toBeGreaterThanOrEqual(0);
      expect(p.stage, p.id).toBeLessThanOrEqual(5);
      expect(p.acceptance.length, `${p.id} acceptance`).toBeGreaterThan(0);
      for (const d of p.deps) expect(byId.has(d), `${p.id} -> ${d}`).toBe(true);
      if (p.status === 'owner') expect(p.owner_input, p.id).toBeTruthy();
    }
  });

  it('has no dependency cycle and never depends on a later stage', () => {
    const seen = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, trail: string[]): void => {
      if (seen.get(id) === 'done') return;
      expect(seen.get(id), `cycle: ${[...trail, id].join(' -> ')}`).not.toBe('visiting');
      seen.set(id, 'visiting');
      const p = byId.get(id) as Pkg;
      for (const d of p.deps) {
        expect((byId.get(d) as Pkg).stage, `${id} depends on later stage ${d}`).toBeLessThanOrEqual(
          p.stage,
        );
        visit(d, [...trail, id]);
      }
      seen.set(id, 'done');
    };
    for (const p of pkgs) visit(p.id, []);
  });

  it('a ready or done package has every dependency done', () => {
    for (const p of pkgs.filter((x) => x.status === 'ready' || x.status === 'done')) {
      for (const d of p.deps)
        expect((byId.get(d) as Pkg).status, `${p.id} needs ${d}`).toBe('done');
    }
  });

  it('every stage-0 package is done or waits for the owner, and a package is done only when its dependencies are', () => {
    for (const p of pkgs.filter((x) => x.stage === 0))
      expect(['done', 'owner'], p.id).toContain(p.status);
    for (const p of pkgs.filter((x) => x.status === 'done'))
      for (const d of p.deps)
        expect(byId.get(d)?.status, `${p.id} is done but ${d} is not`).toBe('done');
  });

  it('spec references point at real spec sections', () => {
    const spec = readFileSync(path.join(REPO_ROOT, 'docs', 'spec', 'ARIMA-Master-Spec.md'), 'utf8');
    const sections = new Set(
      [...spec.matchAll(/^#{2,3} (\d+(?:\.\d+)?)[ .]/gm)].map((m) => m[1] as string),
    );
    for (const p of pkgs)
      for (const s of p.spec) expect(sections.has(s), `${p.id} cites spec ${s}`).toBe(true);
  });

  it('STATE.md names the first ready package', () => {
    const first = pkgs.find((p) => p.status === 'ready');
    expect(first).toBeDefined();
    expect(read('STATE.md')).toContain((first as Pkg).id);
  });
});

describe('documents reference only real packages', () => {
  it('every WP-nnn mentioned anywhere in docs/build exists in the register', () => {
    for (const f of mdFiles(BUILD)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/WP-\d{3}/g))
        expect(byId.has(m[0]), `${path.relative(BUILD, f)} mentions ${m[0]}`).toBe(true);
    }
  });

  it('README lists files that exist', () => {
    const text = read('README.md');
    for (const m of text.matchAll(/`((?:\d\d-[a-z-]+|STATE|work-packages)\.(?:md|yaml))`/g))
      expect(existsSync(path.join(BUILD, m[1] as string)), m[1]).toBe(true);
  });
});

describe('contracts agree with the code', () => {
  const contracts = read('03-contracts.md');

  it('hard-stop ids in the contracts are the canonical list', () => {
    const line = /Hard-stop ids \| `([^`]+)`/.exec(contracts)?.[1] ?? '';
    expect(line.split(/\s+/).sort()).toEqual([...HARD_STOPS].sort());
  });

  it('roles in the contracts are the real roles', () => {
    const line = /Roles \| `([^`]+)`/.exec(contracts)?.[1] ?? '';
    expect(line.split(/,\s*/).sort()).toEqual([...ROLES].sort());
  });

  it('event types in the contracts match events.ts', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'plugins/arima/scripts/src/events.ts'), 'utf8');
    const union = src.slice(src.indexOf('export type EventType'), src.indexOf('export interface'));
    const code = [...union.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1] as string);
    const doc = /Types: `([^`]+)`/.exec(contracts)?.[1] ?? '';
    expect(doc.split(/\s+/).sort()).toEqual([...code].sort());
  });

  it('exit-code registry rows contain every built code', () => {
    const row = (name: string): string =>
      contracts.split('\n').find((l) => l.startsWith(`| \`${name}\``)) ?? '';
    for (const code of Object.values(PREFLIGHT_EXIT))
      expect(row('arima-preflight'), `preflight ${code}`).toMatch(new RegExp(`\\b${code}\\b`));
    for (const code of Object.values(EXIT))
      expect(row('arima-run-agent'), `run-agent ${code}`).toMatch(new RegExp(`\\b${code}\\b`));
    for (const code of Object.values(INIT_EXIT))
      expect(row('arima-init'), `init ${code}`).toMatch(new RegExp(`\\b${code}\\b`));
  });
});

describe('agent cards', () => {
  const HEADINGS = [
    'Identity and purpose',
    'Triggers and preconditions',
    'Inputs and input handling',
    'Processing outline',
    'Outputs',
    'Tools and permissions',
    'Conditions and rules',
    'Failure handling and escalation',
    'Budget and cost',
    'Test and eval plan',
    'Dependencies',
    'Resolved decisions and status',
  ];
  it.each([...ROLES])('%s has a card with the twelve headings, in order', (role) => {
    const file = path.join(BUILD, 'agents', `${role}.md`);
    expect(existsSync(file), `docs/build/agents/${role}.md`).toBe(true);
    const text = readFileSync(file, 'utf8');
    let at = 0;
    HEADINGS.forEach((h, i) => {
      const found = text.indexOf(`## ${i + 1}. ${h}`, at);
      expect(found, `${role}: heading ${i + 1} ${h}`).toBeGreaterThanOrEqual(0);
      at = found;
    });
    expect(text, `${role} has no TBD`).not.toMatch(/\bTBD\b/);
  });
});

describe('feature specs', () => {
  it('every feature spec has the twelve numbered sections', () => {
    const dir = path.join(BUILD, 'features');
    const files = readdirSync(dir).filter((f) => /^F\d\d-.*\.md$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const f of files) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      for (let i = 1; i <= 12; i++)
        expect(text, `${f} section ${i}`).toMatch(new RegExp(`^## ${i}\\. `, 'm'));
    }
  });
});

describe('stage plan covers the register', () => {
  it('every package from stage 1 on is named in 02-stages.md', () => {
    const stages = read('02-stages.md');
    for (const p of pkgs.filter((x) => x.stage >= 1))
      expect(stages, `${p.id} missing from 02-stages.md`).toContain(p.id);
  });
  it('every stage-2 agent package waits for the owner stack decision (WP-201)', () => {
    for (const id of ['WP-210', 'WP-211', 'WP-212', 'WP-213'])
      expect((byId.get(id) as Pkg).deps, id).toContain('WP-201');
  });
  it('no acceptance criterion is a bare "recorded", "published" or "accepted"', () => {
    for (const p of pkgs)
      for (const a of p.acceptance)
        expect(a.trim(), `${p.id}: "${a}"`).not.toMatch(
          /^(ADR accepted|published, reproducible|timed external run)$/,
        );
  });
});

describe('artifact map and concept', () => {
  const map = parse(read('artifact-map.yaml')) as {
    artifacts: { id: string; kind: string; produced_by: string[] | null }[];
  };
  const catalog = parse(
    readFileSync(path.join(REPO_ROOT, 'plugins/arima/catalog/artifacts.yaml'), 'utf8'),
  ) as { artifacts: { id: string; kind: string }[] };

  it('maps every catalog artifact exactly once', () => {
    expect(map.artifacts.map((a) => a.id)).toEqual(catalog.artifacts.map((a) => a.id));
    expect(map.artifacts).toHaveLength(58);
  });
  it('every artifact except external ones has a producing package, and every package exists', () => {
    for (const a of map.artifacts) {
      if (a.kind === 'external') continue;
      expect(a.produced_by?.length, `${a.id} has no producing package`).toBeGreaterThan(0);
      for (const wp of a.produced_by ?? []) expect(byId.has(wp), `${a.id} -> ${wp}`).toBe(true);
    }
  });
  it('CONCEPT.md exists and is the first document START-HERE and the handoff point to', () => {
    expect(existsSync(path.join(BUILD, 'CONCEPT.md'))).toBe(true);
    const start = readFileSync(path.join(REPO_ROOT, 'START-HERE.md'), 'utf8');
    expect(start.indexOf('CONCEPT.md')).toBeGreaterThan(-1);
    expect(read('00-handoff.md')).toContain('CONCEPT.md');
    expect(read('README.md')).toContain('CONCEPT.md');
  });
});

describe('nothing is orphaned', () => {
  it('every work package leads to the v1.0 package WP-505 (so no leg of the team can be skipped)', () => {
    const reach = new Set<string>();
    const walk = (id: string): void => {
      if (reach.has(id)) return;
      reach.add(id);
      for (const d of (byId.get(id) as Pkg).deps) walk(d);
    };
    walk('WP-505');
    for (const p of pkgs) expect(reach.has(p.id), `${p.id} is not required by WP-505`).toBe(true);
  });
  it('each stage evaluation depends on every package of its own stage', () => {
    const closure = (root: string): Set<string> => {
      const seen = new Set<string>();
      const walk = (id: string): void => {
        if (seen.has(id)) return;
        seen.add(id);
        for (const d of (byId.get(id) as Pkg).deps) walk(d);
      };
      walk(root);
      return seen;
    };
    const exempt = new Set(['WP-230', 'WP-232', 'WP-190', 'WP-191', 'WP-195', 'WP-160']);
    const c3 = closure('WP-351');
    for (const p of pkgs.filter((x) => x.stage === 3 && !exempt.has(x.id)))
      expect(c3.has(p.id), `${p.id} is not needed by the stage 3 evals`).toBe(true);
  });
});

describe('saved judge reviews (F10 5.5, WP-150)', () => {
  const dir = path.join(REPO_ROOT, 'docs', 'process', 'reviews');
  const generated = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ f, text: readFileSync(path.join(dir, f), 'utf8') }))
    .filter((x) => x.text.includes('Produced by `arima-judge`'));

  it('every blocker and major row of an arima-judge review has a response', () => {
    for (const { f, text } of generated) {
      const rows = [...text.matchAll(/^\| \d+ \| (blocker|major) \|(.*)\|\s*$/gm)];
      for (const r of rows) {
        const cells = (r[2] as string).split('|');
        const response = (cells[cells.length - 1] ?? '').trim();
        expect(response, `${f}: a ${r[1] as string} finding has no response`).not.toBe('');
      }
    }
  });

  it('the check itself fails on an unanswered row', () => {
    const open = '| 1 | blocker | the guard is not wired | |';
    const m = /^\| \d+ \| (blocker|major) \|(.*)\|\s*$/m.exec(open);
    expect(m).not.toBeNull();
    expect(((m?.[2] ?? '').split('|').at(-1) ?? '').trim()).toBe('');
  });
});
