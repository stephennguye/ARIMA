import type { DatabaseInfo, NotionPort } from './port.js';
import { isPlain, toApiProperty, toApiRelation } from './props.js';
import type { ApiProperty } from './props.js';
import { DATABASES, TEMPLATE_SCHEMA_VERSION, expandedSpec } from './schema.js';
import type { DbKey, DbSpec, PropSpec } from './schema.js';

export const VERSION_MARKER = 'ARIMA template schema_version:';

export interface ManualStep {
  database: string;
  property: string;
  reason: string;
  /** What to enter by hand, e.g. the formula expression. */
  hint?: string;
}

export interface EnsureResult {
  added: string[];
  manual: ManualStep[];
}

export type DbMap = Map<DbKey, DatabaseInfo>;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Adds whatever is missing, in dependency order: plain properties, relations, rollups, formulas.
 * Never alters an existing property (the port refuses). Relations need both ends to exist; rollups
 * and formulas are attempted and, if the API refuses, reported as manual steps instead of failing.
 */
export async function ensureProperties(
  port: NotionPort,
  specs: DbSpec[],
  dbs: DbMap,
  only?: Set<DbKey>,
): Promise<EnsureResult> {
  const added: string[] = [];
  const manual: ManualStep[] = [];
  const targets = specs.filter((s) => dbs.has(s.key) && (only === undefined || only.has(s.key)));

  const current = new Map<DbKey, Record<string, unknown>>();
  const refresh = async (key: DbKey): Promise<Record<string, unknown>> => {
    const info = dbs.get(key) as DatabaseInfo;
    const props = await port.getDataSourceProperties(info.dataSourceId);
    current.set(key, props);
    return props;
  };
  for (const s of targets) await refresh(s.key);
  const has = (key: DbKey, name: string): boolean => name in (current.get(key) ?? {});

  // A. plain properties
  for (const s of targets) {
    const batch: Record<string, ApiProperty> = {};
    for (const p of s.props)
      if (isPlain(p) && p.type !== 'title' && !has(s.key, p.name)) batch[p.name] = toApiProperty(p);
    if (Object.keys(batch).length > 0) {
      await port.addProperties((dbs.get(s.key) as DatabaseInfo).dataSourceId, batch);
      for (const n of Object.keys(batch)) added.push(`${s.title}.${n}`);
    }
  }

  // B. relations (owner side only; Notion creates the reverse). A reverse that already exists
  // without its owner is left for a human rather than risking a duplicate.
  for (const owner of DATABASES) {
    if (!dbs.has(owner.key) || (only !== undefined && !only.has(owner.key))) continue;
    const batch: Record<string, ApiProperty> = {};
    for (const p of owner.props) {
      if (p.type !== 'relation' || p.relation === undefined || has(owner.key, p.name)) continue;
      const target = dbs.get(p.relation.target);
      if (target === undefined) {
        manual.push({
          database: owner.title,
          property: p.name,
          reason: `target database ${p.relation.target} is missing`,
        });
        continue;
      }
      if (has(p.relation.target, p.relation.reverse)) {
        manual.push({
          database: owner.title,
          property: p.name,
          reason: `reverse property ${p.relation.reverse} already exists on the target; connect them by hand`,
        });
        continue;
      }
      batch[p.name] = toApiRelation(target.dataSourceId, p.relation.reverse);
    }
    if (Object.keys(batch).length > 0) {
      await port.addProperties((dbs.get(owner.key) as DatabaseInfo).dataSourceId, batch);
      for (const n of Object.keys(batch)) added.push(`${owner.title}.${n}`);
      await refresh(owner.key);
      for (const p of owner.props) {
        if (p.type === 'relation' && p.relation && dbs.has(p.relation.target))
          await refresh(p.relation.target);
      }
    }
  }

  // C. rollups, D. formulas (formulas may read rollups, so rollups go first)
  for (const kind of ['rollup', 'formula'] as const) {
    for (const s of targets) {
      const missing = s.props.filter((p) => p.type === kind && !has(s.key, p.name));
      for (const p of missing) {
        try {
          await port.addProperties((dbs.get(s.key) as DatabaseInfo).dataSourceId, {
            [p.name]: toApiProperty(p),
          });
          added.push(`${s.title}.${p.name}`);
          await refresh(s.key);
        } catch (e) {
          manual.push({
            database: s.title,
            property: p.name,
            reason: `the API did not accept this ${kind}: ${errText(e)}`,
            hint: describeDerived(p),
          });
        }
      }
    }
  }
  return { added, manual };
}

function describeDerived(p: PropSpec): string {
  if (p.type === 'formula') return `Formula property "${p.name}": ${p.formula}`;
  if (p.rollup)
    return `Rollup property "${p.name}": relation "${p.rollup.relation}", property "${p.rollup.property}", calculate "${p.rollup.fn}"`;
  return p.name;
}

export interface BootstrapReport {
  created: string[];
  skipped: string[];
  added: string[];
  manual: ManualStep[];
  databases: Record<string, DatabaseInfo>;
}

/**
 * Builds the template under `parentPageId` (spec §9.1): the 19 databases, then relations,
 * rollups and formulas. Safe to re-run: databases that already exist (by title) are reused and
 * only missing properties are added. Views are not created (spec §9.2; see docs/NOTION-TEMPLATE.md).
 */
export async function bootstrapTemplate(
  port: NotionPort,
  parentPageId: string,
  log: (line: string) => void = () => undefined,
): Promise<BootstrapReport> {
  const children = await port.listChildren(parentPageId);
  const existing = new Map<string, string>();
  for (const c of children) if (c.type === 'child_database') existing.set(c.text.trim(), c.id);

  const report: BootstrapReport = {
    created: [],
    skipped: [],
    added: [],
    manual: [],
    databases: {},
  };
  const dbs: DbMap = new Map();

  for (const d of DATABASES) {
    const existingId = existing.get(d.title);
    if (existingId !== undefined) {
      dbs.set(d.key, await port.getDatabase(existingId));
      report.skipped.push(d.title);
      log(`exists   ${d.title}`);
      continue;
    }
    const full = expandedSpec().find((x) => x.key === d.key) as DbSpec;
    const plainProps: Record<string, ApiProperty> = {};
    for (const p of full.props) if (isPlain(p)) plainProps[p.name] = toApiProperty(p);
    dbs.set(d.key, await port.createDatabase(parentPageId, d.title, plainProps));
    report.created.push(d.title);
    log(`created  ${d.title}`);
  }

  const result = await ensureProperties(port, expandedSpec(), dbs);
  report.added = result.added;
  report.manual = result.manual;
  for (const [key, info] of dbs) report.databases[key] = info;
  for (const m of result.manual) log(`manual   ${m.database}.${m.property}: ${m.reason}`);

  const blocks = await port.listChildren(parentPageId);
  if (!blocks.some((b) => b.type === 'paragraph' && b.text.startsWith(VERSION_MARKER))) {
    await port.appendParagraph(parentPageId, `${VERSION_MARKER} ${TEMPLATE_SCHEMA_VERSION}`);
    log('wrote    template schema version');
  }
  return report;
}
