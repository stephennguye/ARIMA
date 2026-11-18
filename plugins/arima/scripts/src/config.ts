import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ErrorObject } from 'ajv/dist/2020.js';
import { pluginRoot } from './lib/paths.js';
import { describeError, getValidator } from './lib/schema.js';
import type { SchemaName } from './lib/schema.js';
import { YamlSource } from './lib/yaml-source.js';
import { loadProfile, requiredApproverRoles } from './profiles.js';

export type Severity = 'error' | 'warning';

export interface Issue {
  severity: Severity;
  file: string;
  line: number;
  path: string;
  message: string;
}

export interface ConfigResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Parsed documents, present only when each file passed schema validation. */
  arima?: ArimaConfig;
  team?: TeamConfig;
}

export interface ArimaConfig {
  profile: string;
  parallelism?: { max_developer_agents?: number };
  runtime: { allow_usage_credits: boolean };
  [key: string]: unknown;
}

export interface Role {
  type: 'human' | 'agent';
  person?: string;
  agent?: string;
  count?: number;
}

export interface TeamConfig {
  people: Record<string, { name: string; notion_user: string; github?: string; access?: string }>;
  roles: Record<string, Role>;
  human_task_sla_hours: number;
}

const ROLE_BRANCH = ['human', 'agent'] as const;

/** Reduce Ajv oneOf noise: keep only the errors of the branch that matches `type`. */
function refine(errors: ErrorObject[], data: unknown): ErrorObject[] {
  const oneOfPaths = new Set(
    errors.filter((e) => e.keyword === 'oneOf').map((e) => e.instancePath),
  );
  if (oneOfPaths.size === 0) return errors;
  const out: ErrorObject[] = [];
  for (const e of errors) {
    const underOneOf = [...oneOfPaths].find((p) => e.instancePath.startsWith(p));
    if (underOneOf === undefined) {
      out.push(e);
      continue;
    }
    if (e.keyword === 'oneOf') {
      const node = getByPointer(data, e.instancePath) as { type?: unknown } | undefined;
      if (!ROLE_BRANCH.includes(node?.type as (typeof ROLE_BRANCH)[number])) {
        out.push({
          ...e,
          keyword: 'enum',
          params: { allowedValues: [...ROLE_BRANCH] },
          instancePath: `${e.instancePath}/type`,
        });
      }
      continue;
    }
    const node = getByPointer(data, underOneOf) as { type?: unknown } | undefined;
    const idx = ROLE_BRANCH.indexOf(node?.type as (typeof ROLE_BRANCH)[number]);
    if (idx >= 0 && e.schemaPath.includes(`/oneOf/${idx}/`)) out.push(e);
  }
  return out;
}

function getByPointer(data: unknown, pointer: string): unknown {
  let cur: unknown = data;
  for (const part of pointer.split('/').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function schemaIssues(src: YamlSource, schema: SchemaName, root: string): Issue[] {
  const issues: Issue[] = src.parseErrors.map((p) => ({
    severity: 'error' as const,
    file: src.file,
    line: p.line,
    path: '(syntax)',
    message: `YAML syntax error: ${p.message}`,
  }));
  if (issues.length > 0) return issues;
  const data = src.data;
  const validate = getValidator(schema, root);
  if (validate(data)) return [];
  for (const e of refine(validate.errors ?? [], data)) {
    let pointer = e.instancePath;
    if (e.keyword === 'additionalProperties') {
      pointer += `/${(e.params as { additionalProperty: string }).additionalProperty}`;
    }
    issues.push({
      severity: 'error',
      file: src.file,
      line: src.lineOf(pointer),
      path: pointer.split('/').filter(Boolean).join('.') || '(root)',
      message: describeError(e),
    });
  }
  return issues;
}

/**
 * Validates <projectDir>/arima.yaml and team.yaml: JSON Schema first, then the cross-field rules of
 * spec §4.2 / §4.4. Pure: reads files, returns issues, never throws for bad config.
 */
export function validateProject(projectDir: string, root: string = pluginRoot()): ConfigResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const arimaFile = path.join(projectDir, 'arima.yaml');
  const teamFile = path.join(projectDir, 'team.yaml');

  const sources: Partial<Record<'arima' | 'team', YamlSource>> = {};
  for (const [key, file] of [
    ['arima', arimaFile],
    ['team', teamFile],
  ] as const) {
    if (!existsSync(file)) {
      errors.push({
        severity: 'error',
        file,
        line: 1,
        path: '(file)',
        message: `${path.basename(file)} not found`,
      });
      continue;
    }
    const src = new YamlSource(file);
    sources[key] = src;
    errors.push(...schemaIssues(src, key, root));
  }

  const aSrc = sources.arima;
  const tSrc = sources.team;
  const aOk = aSrc !== undefined && !errors.some((e) => e.file === aSrc.file);
  const tOk = tSrc !== undefined && !errors.some((e) => e.file === tSrc.file);
  if (!aOk || !tOk || !aSrc || !tSrc) return { ok: false, errors, warnings };

  const arima = aSrc.data as ArimaConfig;
  const team = tSrc.data as TeamConfig;
  const err = (src: YamlSource, pointer: string, message: string): void => {
    errors.push({
      severity: 'error',
      file: src.file,
      line: src.lineOf(pointer),
      path: pointer.split('/').filter(Boolean).join('.'),
      message,
    });
  };

  // Rule 1: every gate approver role of the active profile maps to a human (§4.2).
  const profile = loadProfile(arima.profile, root);
  for (const role of requiredApproverRoles(profile)) {
    if (team.roles[role]?.type !== 'human') {
      err(
        tSrc,
        `/roles/${role}`,
        `role "${role}" approves gates in profile "${profile.name}" and must be type: human, not agent`,
      );
    }
  }

  // Rule 2: developer.count <= parallelism.max_developer_agents.
  const dev = team.roles['developer'];
  const max = arima.parallelism?.max_developer_agents;
  if (dev?.type === 'agent' && dev.count !== undefined && max !== undefined && dev.count > max) {
    err(
      tSrc,
      '/roles/developer/count',
      `developer.count (${dev.count}) exceeds parallelism.max_developer_agents (${max}) in arima.yaml`,
    );
  }

  // Rule 3: every person reference exists in people.
  for (const [name, role] of Object.entries(team.roles)) {
    if (role.type === 'human' && role.person !== undefined && !(role.person in team.people)) {
      err(
        tSrc,
        `/roles/${name}/person`,
        `role "${name}" references unknown person "${role.person}" (not in people)`,
      );
    }
  }

  // Rule 4 (warn only): usage credits need a spend cap decision (Q-22, D-18).
  if (arima.runtime.allow_usage_credits) {
    warnings.push({
      severity: 'warning',
      file: aSrc.file,
      line: aSrc.lineOf('/runtime/allow_usage_credits'),
      path: 'runtime.allow_usage_credits',
      message:
        'usage credits are enabled: set a spend cap and note it in the digest configuration (Q-22); budgets are estimates, not money spent',
    });
  }

  // Rule 5 (warn only): the hard stops are fixed in ARIMA's code (spec §11.1); this list is
  // documentation, and shortening it does not switch anything off. Say so rather than let a
  // reader believe the config controls them.
  const listed = new Set(
    (arima as unknown as { autonomy: { hard_stops: string[] } }).autonomy.hard_stops,
  );
  const missing = REQUIRED_HARD_STOPS.filter((s) => !listed.has(s));
  if (missing.length > 0) {
    warnings.push({
      severity: 'warning',
      file: aSrc.file,
      line: aSrc.lineOf('/autonomy/hard_stops'),
      path: 'autonomy.hard_stops',
      message: `hard stops missing from this list: ${missing.join(', ')}. ARIMA enforces them anyway (they cannot be disabled by configuration, spec §11.1); keep the list complete so it matches what is enforced`,
    });
  }

  return { ok: errors.length === 0, errors, warnings, arima, team };
}

/** The hard stops of spec §4.1 / §11.1 that arima.yaml lists. */
export const REQUIRED_HARD_STOPS = [
  'G0',
  'G1',
  'G2',
  'G3',
  'G4',
  'prod_deploy',
  'secrets_change',
  'budget_exceeded',
  'notion_delete',
  'prod_data_migration',
  'new_paid_service',
] as const;

export function formatIssue(i: Issue): string {
  return `${i.file}:${i.line}: ${i.severity}: ${i.message}`;
}
