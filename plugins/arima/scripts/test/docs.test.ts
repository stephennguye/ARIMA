import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INIT_EXIT } from '../src/init.js';
import { PREFLIGHT_EXIT } from '../src/preflight.js';
import { DATABASES, expandedSpec } from '../src/notion/schema.js';
import { REPO_ROOT } from './helpers.js';

const doc = (name: string): string => readFileSync(path.join(REPO_ROOT, 'docs', name), 'utf8');

describe('docs/NOTION-TEMPLATE.md stays in step with the schema', () => {
  const text = doc('NOTION-TEMPLATE.md');

  it('names all 19 databases', () => {
    expect(DATABASES).toHaveLength(19);
    for (const d of DATABASES) expect(text, d.title).toContain(`| ${d.title} |`);
  });

  it('lists every human-only property', () => {
    for (const s of expandedSpec()) {
      for (const p of s.props.filter(
        (x) => x.humanOnly === true || x.humanOnlyValues !== undefined,
      )) {
        expect(text, `${s.title}.${p.name}`).toContain(p.name);
      }
    }
  });

  it('lists the formulas and rollups that may need manual setup', () => {
    for (const s of expandedSpec()) {
      for (const p of s.props.filter((x) => x.type === 'formula' || x.type === 'rollup')) {
        expect(text, `${s.title}.${p.name}`).toContain(`| ${s.title} | ${p.name} |`);
      }
    }
  });

  it('describes the six views of spec §9.2', () => {
    for (const v of [
      'Board',
      'Approval inbox',
      'RTM',
      'Milestone burn',
      'Open bugs',
      'Portfolio',
    ]) {
      expect(text, v).toContain(`| ${v} |`);
    }
  });
});

describe('docs/INSTALL.md stays in step with the code', () => {
  const text = doc('INSTALL.md');

  it('documents every init/preflight exit code', () => {
    const codes = [
      ...new Set([...Object.values(INIT_EXIT), ...Object.values(PREFLIGHT_EXIT)]),
    ].filter((c) => c !== 0);
    for (const c of codes) expect(text, `exit ${c}`).toContain(`| ${c} |`);
  });

  it('shows the install commands, the token rule and the three commands', () => {
    expect(text).toContain('/plugin marketplace add stephennguye/ARIMA');
    expect(text).toContain('/plugin install arima@arima');
    expect(text).toMatch(/Never paste it into Claude/);
    for (const c of ['/arima:init', '/arima:status', '/arima:pause']) expect(text).toContain(c);
  });
});
