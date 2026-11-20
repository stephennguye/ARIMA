import type { NotionMap } from './mapper.js';
import type { NotionPort } from './port.js';

/**
 * The human views of the workspace (spec 9.2, WP-142), created through the API: Board, Approval inbox
 * (one per database that has something waiting for a person), RTM, Milestone burn, Open bugs. A view is
 * a saved filter, sort and grouping of one database, so "the Approval inbox" is the same-named view in
 * each database it spans. Creating is idempotent by name and never alters or deletes a view.
 */

export interface ViewSpec {
  /** Key of the database in the Notion map. */
  db: string;
  name: string;
  type: 'table' | 'board';
  filter?: Record<string, unknown>;
  sorts?: Record<string, unknown>[];
  /** Board only: the select property to group by. */
  groupBy?: string;
  /** What the person sees it for. */
  why: string;
}

const select = (property: string, equals: string): Record<string, unknown> => ({
  property,
  select: { equals },
});

export const VIEW_SPECS: readonly ViewSpec[] = [
  {
    db: 'stories',
    name: 'Board',
    type: 'board',
    groupBy: 'Status',
    filter: { property: 'Status', select: { does_not_equal: 'Cancelled' } },
    sorts: [{ property: 'Priority', direction: 'ascending' }],
    why: 'Stories by Status (add a Milestone filter in Notion for the current milestone)',
  },
  {
    db: 'gates',
    name: 'Approval inbox',
    type: 'table',
    filter: select('Status', 'Ready for review'),
    why: 'Gates waiting for your decision',
  },
  {
    db: 'questions',
    name: 'Approval inbox',
    type: 'table',
    filter: {
      and: [select('Status', 'Open'), { property: 'Blocking', checkbox: { equals: true } }],
    },
    why: 'Blocking questions waiting for your answer',
  },
  {
    db: 'releases',
    name: 'Approval inbox',
    type: 'table',
    filter: select('Status', 'Awaiting approval'),
    why: 'Production approvals waiting',
  },
  {
    db: 'change_requests',
    name: 'Approval inbox',
    type: 'table',
    filter: select('Decision', 'Pending'),
    why: 'Change requests waiting for a decision',
  },
  {
    db: 'decisions',
    name: 'Approval inbox',
    type: 'table',
    filter: { property: 'Date', date: { past_week: {} } },
    sorts: [{ property: 'Date', direction: 'descending' }],
    why: 'Decisions made for you recently, each with its veto box',
  },
  {
    db: 'requirements',
    name: 'RTM',
    type: 'table',
    sorts: [{ property: 'ID', direction: 'ascending' }],
    why: 'Requirements with their stories, test cases, results and coverage',
  },
  {
    db: 'milestones',
    name: 'Milestone burn',
    type: 'table',
    sorts: [{ property: 'ID', direction: 'ascending' }],
    why: 'Budget against cost per milestone',
  },
  {
    db: 'stories',
    name: 'Milestone burn',
    type: 'table',
    sorts: [{ property: 'Cost USD', direction: 'descending' }],
    why: 'Cost against budget per story',
  },
  {
    db: 'bugs',
    name: 'Open bugs',
    type: 'table',
    filter: {
      or: [select('Status', 'Open'), select('Status', 'In progress'), select('Status', 'Fixed')],
    },
    sorts: [{ property: 'Severity', direction: 'ascending' }],
    why: 'Bugs not yet verified, by severity',
  },
];

export interface EnsureViewsResult {
  created: { db: string; name: string; id: string }[];
  existing: { db: string; name: string }[];
  failed: { db: string; name: string; reason: string }[];
}

export async function ensureViews(
  port: NotionPort,
  map: NotionMap,
  specs: readonly ViewSpec[] = VIEW_SPECS,
): Promise<EnsureViewsResult> {
  const res: EnsureViewsResult = { created: [], existing: [], failed: [] };
  const have = new Map<string, Set<string>>();
  for (const spec of specs) {
    const db = map.databases[spec.db];
    if (db === undefined) {
      res.failed.push({
        db: spec.db,
        name: spec.name,
        reason: 'the database is not in the Notion map (run arima-notion map)',
      });
      continue;
    }
    try {
      if (!have.has(db.database_id))
        have.set(
          db.database_id,
          new Set((await port.listViews(db.database_id)).map((v) => v.name)),
        );
      const names = have.get(db.database_id) as Set<string>;
      if (names.has(spec.name)) {
        res.existing.push({ db: spec.db, name: spec.name });
        continue;
      }
      const groupId = spec.groupBy === undefined ? undefined : db.properties[spec.groupBy]?.id;
      if (spec.groupBy !== undefined && groupId === undefined)
        throw new Error(`${spec.groupBy} is not a property of ${spec.db}`);
      const id = await port.createView({
        databaseId: db.database_id,
        dataSourceId: db.data_source_id,
        name: spec.name,
        type: spec.type,
        ...(spec.filter ? { filter: spec.filter } : {}),
        ...(spec.sorts ? { sorts: spec.sorts } : {}),
        ...(groupId !== undefined
          ? { groupBy: { propertyId: groupId, type: 'select' as const } }
          : {}),
      });
      names.add(spec.name);
      res.created.push({ db: spec.db, name: spec.name, id });
    } catch (e) {
      res.failed.push({
        db: spec.db,
        name: spec.name,
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }
  return res;
}
