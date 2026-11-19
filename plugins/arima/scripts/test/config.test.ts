import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateProject } from '../src/config.js';
import { runConfigCli } from '../src/cli/config-cli.js';
import { EXAMPLES, project, tempDir } from './helpers.js';

const messages = (r: ReturnType<typeof validateProject>): string[] =>
  r.errors.map((e) => e.message);

describe('validateProject: schema errors', () => {
  it('accepts the shipped examples with no errors or warnings', () => {
    const r = validateProject(EXAMPLES);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('reports a missing file', () => {
    const dir = project();
    rmSync(path.join(dir, 'team.yaml'));
    const r = validateProject(dir);
    expect(r.ok).toBe(false);
    expect(messages(r)).toContain('team.yaml not found');
  });

  it('reports YAML syntax errors with a line number', () => {
    const dir = project({}, { arima: 'schema_version: 1\nproject: [unclosed\n' });
    const r = validateProject(dir);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/YAML syntax error/);
    expect(r.errors[0]?.line).toBeGreaterThan(0);
  });

  it('reports an unknown property on the exact line', () => {
    const dir = project({
      arima: [['profile: client-project', 'profile: client-project\nbogus: 1']],
    });
    const r = validateProject(dir);
    const e = r.errors.find((x) => x.message.includes('unknown property "bogus"'));
    expect(e).toBeDefined();
    expect(e?.line).toBe(10);
    expect(e?.file).toMatch(/arima\.yaml$/);
  });

  it('reports a missing required property', () => {
    const dir = project({ arima: [[/^runtime:[\s\S]*?allow_usage_credits: false\n/m, '']] });
    expect(messages(validateProject(dir))).toContain('(root): missing required property "runtime"');
  });

  it('reports an invalid enum value with the allowed values', () => {
    const dir = project({ arima: [['profile: client-project', 'profile: enterprise']] });
    const r = validateProject(dir);
    expect(r.errors.some((e) => e.message.startsWith('profile: must be one of'))).toBe(true);
  });

  it('rejects non-web platforms (D-33)', () => {
    const dir = project({ arima: [['platforms: [web]', 'platforms: [ios]']] });
    expect(validateProject(dir).ok).toBe(false);
  });

  it('refuses a hard-stop list that drops prod_deploy (§11.1)', () => {
    const dir = project({ arima: [['prod_deploy, ', '']] });
    expect(validateProject(dir).ok).toBe(false);
  });

  it('gives one concise error for a role with an unknown type', () => {
    const dir = project({ team: [['qa:        { type: agent }', 'qa:        { type: robot }']] });
    const r = validateProject(dir);
    const roleErrors = r.errors.filter((e) => e.path.startsWith('roles.qa'));
    expect(roleErrors).toHaveLength(1);
    expect(roleErrors[0]?.message).toContain('must be one of ["human","agent"]');
  });

  it('rejects agent-only fields on a human role', () => {
    const dir = project({
      team: [
        [
          'po:        { type: human, person: me }',
          'po:        { type: human, person: me, count: 2 }',
        ],
      ],
    });
    const r = validateProject(dir);
    expect(r.errors.some((e) => e.message.includes('unknown property "count"'))).toBe(true);
  });
});

describe('validateProject: cross-field rules', () => {
  it('requires gate approver roles of the profile to be human', () => {
    const dir = project({
      team: [['sponsor:   { type: human, person: client_rep }', 'sponsor:   { type: agent }']],
    });
    const r = validateProject(dir);
    expect(r.ok).toBe(false);
    const e = r.errors.find((x) => x.path === 'roles.sponsor');
    expect(e?.message).toContain('must be type: human');
    expect(e?.file).toMatch(/team\.yaml$/);
  });

  it('only checks approvers of the active profile (solo-lite needs just po)', () => {
    const dir = project({
      arima: [['profile: client-project', 'profile: solo-lite']],
      team: [['sponsor:   { type: human, person: client_rep }', 'sponsor:   { type: agent }']],
    });
    expect(validateProject(dir).ok).toBe(true);
    const bad = project({
      arima: [['profile: client-project', 'profile: solo-lite']],
      team: [['po:        { type: human, person: me }', 'po:        { type: agent }']],
    });
    expect(validateProject(bad).errors.some((e) => e.path === 'roles.po')).toBe(true);
  });

  it('regulated also requires legal to be human', () => {
    const dir = project({
      arima: [['profile: client-project', 'profile: regulated']],
      team: [['legal:     { type: human, person: me }', 'legal:     { type: agent }']],
    });
    expect(validateProject(dir).errors.some((e) => e.path === 'roles.legal')).toBe(true);
  });

  it('rejects developer.count above parallelism.max_developer_agents', () => {
    const dir = project({ team: [['count: 3', 'count: 5']] });
    const r = validateProject(dir);
    expect(
      r.errors.some((e) => e.path === 'roles.developer.count' && e.message.includes('(5)')),
    ).toBe(true);
  });

  it('allows developer.count below the maximum', () => {
    const dir = project({ team: [['count: 3', 'count: 2']] });
    expect(validateProject(dir).ok).toBe(true);
  });

  it('rejects a person reference that is not in people', () => {
    const dir = project({
      team: [
        ['legal:     { type: human, person: me }', 'legal:     { type: human, person: ghost }'],
      ],
    });
    const r = validateProject(dir);
    const e = r.errors.find((x) => x.path === 'roles.legal.person');
    expect(e?.message).toContain('unknown person "ghost"');
  });

  it('warns, but does not fail, when usage credits are enabled', () => {
    const dir = project({ arima: [['allow_usage_credits: false', 'allow_usage_credits: true']] });
    const r = validateProject(dir);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.path).toBe('runtime.allow_usage_credits');
  });

  it('warns that a shortened hard_stops list switches nothing off', () => {
    const dir = project({ arima: [[', prod_data_migration, new_paid_service', '']] });
    const r = validateProject(dir);
    expect(r.ok).toBe(true);
    const w = r.warnings.find((x) => x.path === 'autonomy.hard_stops');
    expect(w?.message).toContain('prod_data_migration');
    expect(w?.message).toContain('new_paid_service');
    expect(w?.message).toContain('cannot be disabled');
    expect(validateProject(EXAMPLES).warnings).toEqual([]);
  });

  it('skips cross-field rules when a file fails the schema', () => {
    const dir = project({
      arima: [['profile: client-project', 'profile: nope']],
      team: [['count: 3', 'count: 50']],
    });
    const r = validateProject(dir);
    expect(r.errors.some((e) => e.path === 'roles.developer.count')).toBe(true);
    expect(r.errors.some((e) => e.message.includes('must be one of'))).toBe(true);
  });
});

describe('arima-config CLI', () => {
  const run = (argv: string[], cwd: string) => {
    let out = '';
    let err = '';
    const code = runConfigCli(argv, { out: (s) => (out += s), err: (s) => (err += s), cwd });
    return { code, out, err };
  };

  it('exits 0 for a valid project', () => {
    const r = run(['validate', '--project', EXAMPLES], tempDir());
    expect(r.code).toBe(0);
    expect(r.out).toContain('config valid');
  });

  it('exits 1 with file:line messages for an invalid project', () => {
    const dir = project({ team: [['count: 3', 'count: 9']] });
    const r = run(['validate'], dir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/team\.yaml:\d+: error: /);
  });

  it('exits 2 on bad usage', () => {
    expect(run([], tempDir()).code).toBe(2);
    expect(run(['validate', '--project'], tempDir()).code).toBe(2);
    expect(run(['validate', '--wat'], tempDir()).code).toBe(2);
  });

  it('prints machine-readable output with --json', () => {
    const dir = project({ team: [['count: 3', 'count: 9']] });
    const r = run(['validate', '--json'], dir);
    const parsed = JSON.parse(r.out) as { ok: boolean; errors: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toHaveLength(1);
  });
});
