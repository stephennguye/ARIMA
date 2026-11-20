import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from './config.js';
import { readEvents } from './events.js';
import { writeFileAtomic } from './lib/atomic-file.js';
import { getValidator } from './lib/schema.js';
import { findSecrets } from './lib/secrets.js';
import { verdictAfterLastPush } from './merge.js';
import { findRow, readMirror } from './notion/mirror.js';
import type { MirrorRow } from './notion/mirror.js';
import type { NotionPort } from './notion/port.js';
import { digestQuestions } from './questions.js';

/**
 * Notifications (spec 12.3, D-20, D-23, WP-142): ARIMA sends no email. Each item awaiting a person gets an
 * @mention (a comment on its own Notion page), and the urgent cases (a P1 or P2 incident, a hotfix waiting
 * for its production approval, a red health day) an @mention on the Urgent page, so Notion's own email and
 * mobile notifications deliver them. Append-only, once per state an item waits in (a state file keeps the
 * keys), never deletes; the text holds ids and a short quote only and is secret-scanned.
 */

export const URGENT_PAGE = 'Urgent';
export const MAX_PER_RUN = 20;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

interface NotifyState {
  schema_version: 1;
  sent: Record<string, string>;
}
const stateFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'state', 'notifications.json');

export function readSent(projectDir: string): Record<string, string> {
  const f = stateFile(projectDir);
  if (!existsSync(f)) return {};
  const data: unknown = JSON.parse(readFileSync(f, 'utf8'));
  if (!getValidator('notifications-state')(data))
    throw new Error(`${f} is not a valid notifications file`);
  return (data as NotifyState).sent;
}
function writeSent(projectDir: string, sent: Record<string, string>): void {
  const s: NotifyState = { schema_version: 1, sent };
  if (!getValidator('notifications-state')(s))
    throw new Error('refusing to write an invalid notifications file');
  writeFileAtomic(stateFile(projectDir), `${JSON.stringify(s, null, 2)}\n`);
}

/** The Notion user ids of the humans who decide: po first, then sponsor. A placeholder id is not a person. */
export function ownersOf(projectDir: string): { po: string[]; both: string[] } {
  const team = validateProject(projectDir).team;
  const idOf = (role: string): string | undefined => {
    const r = team?.roles[role];
    if (r?.type !== 'human' || r.person === undefined) return undefined;
    const id = team?.people[r.person]?.notion_user;
    return id !== undefined && UUID.test(id) ? id : undefined;
  };
  const po = idOf('po');
  const sponsor = idOf('sponsor');
  return {
    po: po ? [po] : [],
    both: [...new Set([po, sponsor].filter((x): x is string => x !== undefined))],
  };
}

export interface Notice {
  key: string;
  /** Notion page the mention goes on. */
  pageId: string;
  kind: 'awaiting' | 'urgent';
  text: string;
  who: string[];
}

const quote = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 100);
const waitedSince = (ts: string): string => ts;

export interface NoticeInput {
  projectDir: string;
  urgentPageId: string;
  redHealth?: { date: string; reasons: string[] };
}

/** What deserves a mention right now, from the mirror, the engine's state and the events. */
export function collectNotices(i: NoticeInput): Notice[] {
  const o = ownersOf(i.projectDir);
  const out: Notice[] = [];
  const rows = (db: Parameters<typeof readMirror>[1]): MirrorRow[] =>
    readMirror(i.projectDir, db)?.rows ?? [];
  const add = (n: Notice): void => void out.push(n);

  for (const g of rows('gates').filter((r) => r.properties['Status'] === 'Ready for review'))
    add({
      key: `gate:${g.id}:${waitedSince(g.last_edited_time)}`,
      pageId: g.page_id,
      kind: 'awaiting',
      who: o.both,
      text: `Gate ${g.id} is ready for your decision.`,
    });
  for (const r of rows('releases').filter((x) => x.properties['Status'] === 'Awaiting approval'))
    add({
      key: `release:${r.id}:${r.last_edited_time}`,
      pageId: r.page_id,
      kind: 'awaiting',
      who: o.both,
      text: `Production approval for ${r.id} is waiting for you.`,
    });
  for (const c of rows('change_requests').filter((x) => x.properties['Decision'] === 'Pending'))
    add({
      key: `cr:${c.id}:${c.last_edited_time}`,
      pageId: c.page_id,
      kind: 'awaiting',
      who: o.po,
      text: `Change request ${c.id} awaits your decision.`,
    });
  for (const q of digestQuestions(i.projectDir, { max: 1000 }).shown) {
    const row = findRow(readMirror(i.projectDir, 'questions'), q.id);
    if (row === undefined) continue; // not in Notion yet: the next run
    add({
      key: `question:${q.id}`,
      pageId: row.page_id,
      kind: 'awaiting',
      who: q.hardStop ? o.both : o.po,
      text: `${q.blocking ? 'Blocking q' : 'Q'}uestion ${q.id} needs your answer: ${quote(q.question)}${q.hardStop ? ` [hard stop: ${q.hardStop}]` : ''}`,
    });
  }
  const events = readEvents(i.projectDir);
  for (const s of rows('stories').filter((x) => x.properties['Status'] === 'In QA')) {
    if (verdictAfterLastPush(i.projectDir, s.id, 'qa', 'qa') !== 'pass') continue;
    const pr = [...events].reverse().find((e) => e.type === 'pr.published' && e.item === s.id)
      ?.data?.['pr'];
    const qaAt =
      [...events]
        .reverse()
        .find((e) => e.type === 'report.accepted' && e.item === s.id && e.data?.['role'] === 'qa')
        ?.ts ?? '';
    if (typeof pr !== 'number') continue;
    add({
      key: `pr:${s.id}:${pr}:${qaAt}`,
      pageId: s.page_id,
      kind: 'awaiting',
      who: o.po,
      text: `Pull request #${pr} for ${s.id} passed QA and awaits your approval.`,
    });
  }

  // Urgent: incidents P1 and P2, a hotfix waiting for approval, a red health day.
  const incidents = rows('incidents').filter(
    (x) =>
      ['P1', 'P2'].includes(String(x.properties['Priority'])) &&
      ['Open', 'Mitigated'].includes(String(x.properties['Status'])),
  );
  for (const inc of incidents)
    add({
      key: `urgent:incident:${inc.id}:${String(inc.properties['Status'])}`,
      pageId: i.urgentPageId,
      kind: 'urgent',
      who: o.both,
      text: `URGENT: incident ${inc.id} (${String(inc.properties['Priority'])}) is ${String(inc.properties['Status'])}.`,
    });
  if (incidents.length > 0)
    for (const r of rows('releases').filter((x) => x.properties['Status'] === 'Awaiting approval'))
      add({
        key: `urgent:hotfix:${r.id}:${r.last_edited_time}`,
        pageId: i.urgentPageId,
        kind: 'urgent',
        who: o.both,
        text: `URGENT: the production approval for ${r.id} is waiting while an incident is open (hotfix).`,
      });
  if (i.redHealth)
    add({
      key: `urgent:health:${i.redHealth.date}`,
      pageId: i.urgentPageId,
      kind: 'urgent',
      who: o.both,
      text: `URGENT: health is red on ${i.redHealth.date}: ${quote(i.redHealth.reasons.join('; '))}.`,
    });
  return out;
}

const mention = (userId: string): Record<string, unknown> => ({
  type: 'mention',
  mention: { type: 'user', user: { id: userId } },
});

export interface NotifyResult {
  sent: { key: string; kind: Notice['kind']; via: 'comment' | 'page' }[];
  skipped: string[];
  failed: { key: string; reason: string }[];
}

/**
 * Posts what is new. One failure does not stop the others; a key is recorded only after its mention went
 * out. When the integration may not insert comments, the mention goes into the page as a paragraph instead.
 */
export async function sendNotifications(o: {
  projectDir: string;
  port: NotionPort;
  rootPageId: string;
  now?: Date;
  redHealth?: { date: string; reasons: string[] };
  dryRun?: boolean;
}): Promise<NotifyResult> {
  const res: NotifyResult = { sent: [], skipped: [], failed: [] };
  const sent = readSent(o.projectDir);
  const needsUrgent = true;
  let urgentPageId = '';
  const cheap = collectNotices({
    projectDir: o.projectDir,
    urgentPageId: 'pending',
    ...(o.redHealth ? { redHealth: o.redHealth } : {}),
  });
  const fresh = cheap.filter((n) => sent[n.key] === undefined);
  if (fresh.length === 0) return res;
  if (fresh.some((n) => n.kind === 'urgent') && needsUrgent && o.dryRun !== true)
    urgentPageId = await o.port.findOrCreateChildPage(o.rootPageId, URGENT_PAGE);
  let n = 0;
  for (const notice of fresh) {
    if (notice.who.length === 0) {
      res.skipped.push(`${notice.key}: no Notion user id for po or sponsor in team.yaml`);
      continue;
    }
    if (n >= MAX_PER_RUN) {
      res.skipped.push(`${notice.key}: over ${MAX_PER_RUN} for this run, next run`);
      continue;
    }
    if (findSecrets(notice.text).length > 0) {
      res.skipped.push(`${notice.key}: the text looks like a secret`);
      continue;
    }
    if (o.dryRun === true) {
      res.sent.push({ key: notice.key, kind: notice.kind, via: 'comment' });
      n += 1;
      continue;
    }
    const pageId = notice.kind === 'urgent' ? urgentPageId : notice.pageId;
    const rich = [
      ...notice.who.flatMap((id) => [mention(id), { type: 'text', text: { content: ' ' } }]),
      { type: 'text', text: { content: notice.text } },
    ];
    try {
      let via: 'comment' | 'page' = 'comment';
      try {
        await o.port.createComment(pageId, rich);
      } catch {
        via = 'page';
        await o.port.appendChildren(pageId, [
          { object: 'block', type: 'paragraph', paragraph: { rich_text: rich } },
        ]);
      }
      sent[notice.key] = (o.now ?? new Date()).toISOString();
      writeSent(o.projectDir, sent);
      res.sent.push({ key: notice.key, kind: notice.kind, via });
      n += 1;
    } catch (e) {
      res.failed.push({
        key: notice.key,
        reason: e instanceof Error ? e.message.slice(0, 160) : String(e),
      });
    }
  }
  return res;
}
