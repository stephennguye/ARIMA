import { describe, expect, it } from 'vitest';
import { validateDocument } from '../src/catalog.js';
import { renderTemplate } from '../src/templates.js';

const charterVars = {
  name: 'Tasty',
  key: 'TAS',
  client: 'Acme',
  profile: 'client-project',
  in_scope: 'x',
  out_of_scope: 'y',
  goals: 'g',
  roles: '- po: human',
  project_cap: '$50',
  constraints: 'c',
  risks: 'r',
};

describe('template renderer', () => {
  it('fills every placeholder and the result passes the catalog validator', () => {
    const md = renderTemplate('charter', charterVars);
    expect(md).toContain('# Charter: Tasty');
    expect(md).not.toMatch(/\{\{/);
    expect(validateDocument(md, 'charter')).toEqual({ ok: true, missing: [] });
  });
  it('the budget plan template satisfies its catalog sections', () => {
    const md = renderTemplate('budget-plan', {
      project_cap: '$50',
      daily_cap: '$5',
      per_run_cap: '$1',
      per_story_default: '$1',
      story_budgets: '- S: $1',
      alerts: '50%',
    });
    expect(validateDocument(md, 'budget-plan')).toEqual({ ok: true, missing: [] });
  });
  it('a missing value or an unused value is an error, so template and code cannot drift', () => {
    const { risks: _omit, ...short } = charterVars;
    void _omit;
    expect(() => renderTemplate('charter', short)).toThrow(/no value for \{\{risks\}\}/);
    expect(() => renderTemplate('charter', { ...charterVars, extra: 'x' })).toThrow(/unused/);
  });
});
