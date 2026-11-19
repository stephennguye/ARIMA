import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  headingsOf,
  loadCatalog,
  profileStatus,
  templateExists,
  validateDocument,
} from '../src/catalog.js';
import { loadAllProfiles, loadProfile } from '../src/profiles.js';
import { PLUGIN_ROOT, REPO_ROOT } from './helpers.js';

const catalog = loadCatalog();
const tpl = (f: string): string => readFileSync(path.join(PLUGIN_ROOT, 'templates', f), 'utf8');

describe('artifact catalog (spec section 8.1)', () => {
  it('lists exactly 58 artifacts with unique ids', () => {
    expect(catalog).toHaveLength(58);
    expect(new Set(catalog.map((a) => a.id)).size).toBe(58);
  });

  it('matches the spec table: one row per artifact, in order, with the same required-in letters', () => {
    const spec = readFileSync(path.join(REPO_ROOT, 'docs/spec/ARIMA-Master-Spec.md'), 'utf8');
    const rows = spec
      .slice(spec.indexOf('### 8.1 Catalog'), spec.indexOf('### 8.2'))
      .split('\n')
      .filter((l) => l.startsWith('|'))
      .slice(2)
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    expect(rows).toHaveLength(catalog.length);
    rows.forEach((r, i) => {
      expect(catalog[i]?.name).toBe(r[0]);
      expect(catalog[i]?.required_in).toBe(r[6]);
    });
  });

  it('agrees with the three profiles: every profile slug exists and is flagged for that profile', () => {
    const ids = new Set(catalog.map((a) => a.id));
    const key = {
      'solo-lite': 'solo_lite',
      'client-project': 'client_project',
      regulated: 'regulated',
    } as const;
    for (const p of loadAllProfiles()) {
      const listed = [
        ...p.artifacts.required,
        ...Object.keys(p.artifacts.conditional),
        ...p.artifacts.human_only,
      ];
      for (const slug of listed) expect(ids.has(slug), `${p.name}: ${slug}`).toBe(true);
      for (const slug of p.artifacts.required) {
        expect(
          catalog.find((a) => a.id === slug)?.required[key[p.name]],
          `${p.name} requires ${slug}`,
        ).toBe(true);
      }
    }
  });

  it('every document artifact has a template file whose headings include its required sections', () => {
    for (const a of catalog.filter((x) => x.kind === 'document')) {
      expect(templateExists(a), a.id).toBe(true);
      const have = new Set(headingsOf(tpl(a.template as string)));
      const missing = (a.sections ?? []).filter((s) => !have.has(s.toLowerCase()));
      expect(missing, `${a.id} template lacks sections`).toEqual([]);
    }
  });
});

describe('document validator', () => {
  it('a charter template passes; one missing a required section fails and says which', () => {
    expect(validateDocument(tpl('charter.md'), 'charter', catalog)).toEqual({
      ok: true,
      missing: [],
    });
    const broken = tpl('charter.md').replace('## Risks', '## Thoughts');
    expect(validateDocument(broken, 'charter', catalog)).toEqual({
      ok: false,
      missing: ['Risks'],
    });
  });
  it('rejects an unknown artifact id', () => {
    expect(() => validateDocument('x', 'nope', catalog)).toThrow(/Unknown artifact/);
  });
});

describe('profile rule checks', () => {
  it('lists what a profile requires, what is present and what is missing', () => {
    const s = profileStatus(
      loadProfile('solo-lite'),
      ['project-brief', 'prd'],
      { personalData: false },
      catalog,
    );
    expect(s.present).toEqual(['project-brief', 'prd']);
    expect(s.missing).toContain('budget-plan');
    expect(s.missing).not.toContain('dpia');
  });
  it('adds the DPIA when personal data is handled, and excludes human-only artifacts', () => {
    const c = loadProfile('client-project');
    expect(profileStatus(c, [], { personalData: true }, catalog).required).toContain('dpia');
    expect(profileStatus(c, [], { personalData: false }, catalog).required).not.toContain('sow');
  });
  it('rejects an unknown artifact id in the present list', () => {
    expect(() =>
      profileStatus(loadProfile('solo-lite'), ['nope'], { personalData: false }, catalog),
    ).toThrow();
  });
});
