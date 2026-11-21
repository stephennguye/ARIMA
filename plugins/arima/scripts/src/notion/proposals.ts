import type { Role } from '../ledger.js';
import type { AgentReport } from '../report.js';
import { enqueue } from './outbox.js';
import type { OutboxEntry } from './outbox.js';
import { ID_PREFIX_BY_DB, allocateId, titleProperty } from './allocations.js';
import { dbByKey } from './schema.js';
import type { DbKey } from './schema.js';

const PLACEHOLDER = /\bNEW-(\d+)\b/g;
const isPlaceholder = (v: unknown): v is string => typeof v === 'string' && /^NEW-\d+$/.test(v);

interface Proposal {
  database: DbKey;
  ref?: string;
  properties: Record<string, unknown>;
  content_markdown?: string;
}

/**
 * Severity of a QA bug is a proposal (spec 7.7). S1 and S2 stop a release, so the engine accepts them
 * only for a failure that reproduced in two runs (spec 7.12, `reproductions` at least 2 on the record);
 * otherwise it lowers the proposal to S3 and says so in `Actual`, where the PO can see and change it.
 */
export function bugSeverityRule(
  role: Role,
  database: DbKey,
  properties: Record<string, unknown>,
  reproductions: unknown,
): Record<string, unknown> {
  const sev = properties['Severity'];
  if (role !== 'qa' || database !== 'bugs' || (sev !== 'S1' && sev !== 'S2')) return properties;
  if (typeof reproductions === 'number' && reproductions >= 2) return properties;
  const actual = typeof properties['Actual'] === 'string' ? `${properties['Actual']} ` : '';
  return {
    ...properties,
    Severity: 'S3',
    Actual: `${actual}[severity lowered from ${sev} to S3 by the engine: not reproduced in two runs (spec 7.12); the PO may change it]`,
  };
}

/**
 * A relation property takes an array of ARIMA ids; an agent naturally writes the one id (`Story: "US-12"`).
 * One id becomes a one-element array (found by the live check against real Notion, WP-211).
 */
export function normaliseRelations(
  database: DbKey,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  let relations: Set<string>;
  try {
    relations = new Set(
      dbByKey(database)
        .props.filter((p) => p.type === 'relation')
        .map((p) => p.name),
    );
  } catch {
    return properties;
  }
  const out = { ...properties };
  for (const [k, v] of Object.entries(out))
    if (relations.has(k) && typeof v === 'string') out[k] = [v];
  return out;
}

function fromReport(r: AgentReport, role: Role, today: string): Proposal[] {
  const out: Proposal[] = [];
  const item = r.item === 'none' ? undefined : r.item;
  // Questions are not enqueued here: the question protocol (questions.ts) decides who they go to,
  // whether they block, and whether a decision is assumed.
  for (const d of (r.decisions ?? []) as unknown as Record<string, unknown>[]) {
    out.push({
      database: 'decisions',
      properties: {
        Summary: d['summary'] as string,
        'Made by': role,
        'Options considered': (d['options_considered'] as string[]).join('; '),
        Chosen: d['chosen'] as string,
        Reversible: d['reversible'] === true,
        Date: today,
        ...(typeof (d['item'] ?? item) === 'string' ? { Item: (d['item'] ?? item) as string } : {}),
      },
    });
  }
  for (const rec of (r.records ?? []) as unknown as Record<string, unknown>[]) {
    const database = rec['database'] as DbKey;
    out.push({
      database,
      ...(typeof rec['ref'] === 'string' ? { ref: rec['ref'] } : {}),
      properties: normaliseRelations(
        database,
        bugSeverityRule(
          role,
          database,
          { ...(rec['properties'] as Record<string, unknown>) },
          rec['reproductions'],
        ),
      ),
      ...(typeof rec['content_markdown'] === 'string'
        ? { content_markdown: rec['content_markdown'] }
        : {}),
    });
  }
  return out;
}

const rewrite = (v: unknown, ids: ReadonlyMap<string, string>): unknown => {
  if (typeof v === 'string')
    return v.replace(PLACEHOLDER, (m) => {
      const id = ids.get(m);
      if (id === undefined)
        throw new Error(`placeholder ${m} is not defined by any record of the report`);
      return id;
    });
  if (Array.isArray(v)) return v.map((x) => rewrite(x, ids));
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, ids)]));
  return v;
};

export interface EnqueueResult {
  /** Outbox entry ids, in order. */
  entries: string[];
  /** Placeholder (or `question:n`, `decision:n`) -> issued id. */
  ids: Record<string, string>;
}

/**
 * Turns the records and decisions of a validated agent report into outbox entries
 * (03-contracts 3.3). The engine, not the agent, issues every id: each proposal in an
 * id-titled database gets the next counter value, and `NEW-n` placeholders anywhere in the batch
 * become the issued ids. An agent that supplies its own id for such a record is refused. Entries
 * carry the run's role and run id, so push can bind them to the run.
 */
export async function enqueueReportRecords(o: {
  projectDir: string;
  runId: string;
  role: Role;
  report: AgentReport;
  now?: Date;
}): Promise<EnqueueResult> {
  const now = o.now ?? new Date();
  const proposals = fromReport(o.report, o.role, now.toISOString().slice(0, 10));
  const ids = new Map<string, string>();
  const issued: string[] = [];

  for (const p of proposals) {
    const prefix = ID_PREFIX_BY_DB[p.database];
    if (prefix === undefined) continue;
    const title = p.properties[titleProperty(p.database)];
    if (title !== undefined && !isPlaceholder(title))
      throw new Error(
        `${p.database}: an agent cannot choose an id ("${String(title)}"); leave it out or use NEW-n`,
      );
    const id = await allocateId(o.projectDir, prefix, o.runId);
    issued.push(id);
    p.properties[titleProperty(p.database)] = id;
    if (p.ref !== undefined) {
      if (ids.has(p.ref)) throw new Error(`placeholder ${p.ref} is defined twice`);
      ids.set(p.ref, id);
    } else if (title !== undefined && isPlaceholder(title)) ids.set(title, id);
  }

  const entries: string[] = [];
  for (const [n, p] of proposals.entries()) {
    const properties = rewrite(p.properties, ids) as Record<string, unknown>;
    const entry: OutboxEntry = {
      id: `${o.runId}-${String(n + 1).padStart(2, '0')}`,
      created_at: new Date(now.getTime() + n).toISOString(),
      run_id: o.runId,
      role: o.role,
      op: 'create',
      database: p.database,
      properties,
      ...(p.content_markdown !== undefined
        ? { content_markdown: rewrite(p.content_markdown, ids) as string }
        : {}),
    };
    enqueue(o.projectDir, entry);
    entries.push(entry.id);
  }
  return { entries, ids: Object.fromEntries(ids) };
}
