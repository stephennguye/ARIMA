import { VERSION_MARKER, ensureProperties } from './build.js';
import type { DbMap, ManualStep } from './build.js';
import type { DatabaseInfo, NotionPort, PropertyInfo } from './port.js';
import { TEMPLATE_SCHEMA_VERSION, expandedSpec } from './schema.js';
import type { DbKey, DbSpec, PropSpec } from './schema.js';

export interface MapProperty {
  id: string;
  type: string;
  human_only?: true;
  human_only_values?: string[];
}

export interface MapDatabase {
  database_id: string;
  data_source_id: string;
  title: string;
  properties: Record<string, MapProperty>;
}

export interface NotionMap {
  schema_version: 1;
  template_schema_version: number;
  root_page_id: string;
  generated_at: string;
  databases: Record<string, MapDatabase>;
}

export type IssueKind =
  | 'missing_database'
  | 'ambiguous_database'
  | 'missing_property'
  | 'wrong_type'
  | 'wrong_relation_target'
  | 'missing_option'
  | 'missing_version'
  | 'newer_version';

export interface MapIssue {
  severity: 'error' | 'warning';
  kind: IssueKind;
  database: string;
  property?: string;
  detail: string;
}

export interface MapResult {
  /** Present only when verification found no errors. */
  map?: NotionMap;
  issues: MapIssue[];
  migrated: string[];
  manual: ManualStep[];
}

/** Notion reports a "title" property as type "title"; map our spec types to Notion's. */
const NOTION_TYPE: Record<PropSpec['type'], string> = {
  title: 'title',
  rich_text: 'rich_text',
  number: 'number',
  select: 'select',
  multi_select: 'multi_select',
  date: 'date',
  people: 'people',
  checkbox: 'checkbox',
  url: 'url',
  files: 'files',
  formula: 'formula',
  rollup: 'rollup',
  relation: 'relation',
};

/**
 * Finds the 19 databases under a duplicated template's root page, checks every required property
 * (name and type, relation targets, select options) and builds the notion-map (spec §9.3). With
 * `migrate`, missing properties are added first; existing ones are never changed.
 */
export async function mapWorkspace(
  port: NotionPort,
  rootPageId: string,
  opts: { migrate?: boolean; now?: Date } = {},
): Promise<MapResult> {
  const specs = expandedSpec();
  const issues: MapIssue[] = [];
  const children = await port.listChildren(rootPageId);

  const found = new Map<DbKey, DatabaseInfo>();
  const byTitle = new Map<string, string[]>();
  for (const c of children) {
    if (c.type !== 'child_database') continue;
    const list = byTitle.get(c.text.trim()) ?? [];
    list.push(c.id);
    byTitle.set(c.text.trim(), list);
  }
  for (const s of specs) {
    const ids = byTitle.get(s.title) ?? [];
    if (ids.length === 0) {
      issues.push({
        severity: 'error',
        kind: 'missing_database',
        database: s.title,
        detail: `no database titled "${s.title}" under the root page`,
      });
    } else if (ids.length > 1) {
      issues.push({
        severity: 'error',
        kind: 'ambiguous_database',
        database: s.title,
        detail: `${ids.length} databases are titled "${s.title}"`,
      });
    } else {
      found.set(s.key, await port.getDatabase(ids[0] as string));
    }
  }

  const version = children.find((b) => b.type === 'paragraph' && b.text.startsWith(VERSION_MARKER));
  const versionNumber = version
    ? Number(version.text.slice(VERSION_MARKER.length).trim())
    : undefined;
  if (versionNumber === undefined) {
    issues.push({
      severity: 'warning',
      kind: 'missing_version',
      database: '(root page)',
      detail: 'the root page has no template schema_version marker',
    });
  } else if (versionNumber > TEMPLATE_SCHEMA_VERSION) {
    issues.push({
      severity: 'error',
      kind: 'newer_version',
      database: '(root page)',
      detail: `template is version ${versionNumber}, this ARIMA understands up to ${TEMPLATE_SCHEMA_VERSION}; upgrade the plugin`,
    });
  }

  let migrated: string[] = [];
  let manual: ManualStep[] = [];
  const dbs: DbMap = found;
  if (opts.migrate === true && found.size > 0) {
    const r = await ensureProperties(port, specs, dbs);
    migrated = r.added;
    manual = r.manual;
  }

  const propsByKey = new Map<DbKey, Record<string, PropertyInfo>>();
  for (const [key, info] of found)
    propsByKey.set(key, await port.getDataSourceProperties(info.dataSourceId));

  for (const s of specs) {
    const props = propsByKey.get(s.key);
    if (props === undefined) continue;
    for (const p of s.props) verifyProperty(s, p, props, found, issues);
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  const result: MapResult = { issues, migrated, manual };
  if (!hasErrors) {
    result.map = buildMap(rootPageId, specs, found, propsByKey, opts.now ?? new Date());
  }
  return result;
}

function verifyProperty(
  s: DbSpec,
  p: PropSpec,
  props: Record<string, PropertyInfo>,
  found: Map<DbKey, DatabaseInfo>,
  issues: MapIssue[],
): void {
  const actual = props[p.name];
  if (actual === undefined) {
    issues.push({
      severity: 'error',
      kind: 'missing_property',
      database: s.title,
      property: p.name,
      detail: `missing ${p.type} property "${p.name}" (run with --migrate to add it)`,
    });
    return;
  }
  if (actual.type !== NOTION_TYPE[p.type]) {
    issues.push({
      severity: 'error',
      kind: 'wrong_type',
      database: s.title,
      property: p.name,
      detail: `"${p.name}" is ${actual.type}, expected ${NOTION_TYPE[p.type]}`,
    });
    return;
  }
  if (p.type === 'relation' && p.relation) {
    const target = found.get(p.relation.target);
    if (target !== undefined && actual.relationTarget !== target.dataSourceId) {
      issues.push({
        severity: 'error',
        kind: 'wrong_relation_target',
        database: s.title,
        property: p.name,
        detail: `"${p.name}" does not point at the ${p.relation.target} database`,
      });
    }
  }
  if ((p.type === 'select' || p.type === 'multi_select') && p.options) {
    const missing = p.options.filter((o) => !(actual.options ?? []).includes(o));
    if (missing.length > 0) {
      issues.push({
        severity: 'warning',
        kind: 'missing_option',
        database: s.title,
        property: p.name,
        detail: `"${p.name}" lacks option(s): ${missing.join(', ')} (add by hand; ARIMA never edits existing options)`,
      });
    }
  }
}

function buildMap(
  rootPageId: string,
  specs: DbSpec[],
  found: Map<DbKey, DatabaseInfo>,
  propsByKey: Map<DbKey, Record<string, PropertyInfo>>,
  now: Date,
): NotionMap {
  const databases: Record<string, MapDatabase> = {};
  for (const s of specs) {
    const info = found.get(s.key) as DatabaseInfo;
    const props = propsByKey.get(s.key) as Record<string, PropertyInfo>;
    const out: Record<string, MapProperty> = {};
    for (const p of s.props) {
      const actual = props[p.name] as PropertyInfo;
      const entry: MapProperty = { id: actual.id, type: actual.type };
      if (p.humanOnly === true) entry.human_only = true;
      if (p.humanOnlyValues !== undefined) entry.human_only_values = [...p.humanOnlyValues];
      out[p.name] = entry;
    }
    databases[s.key] = {
      database_id: info.id,
      data_source_id: info.dataSourceId,
      title: s.title,
      properties: out,
    };
  }
  return {
    schema_version: 1,
    template_schema_version: TEMPLATE_SCHEMA_VERSION,
    root_page_id: rootPageId,
    generated_at: now.toISOString(),
    databases,
  };
}
