import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { appendEvent } from './events.js';
import type { UnitKind } from './kinds.js';
import type { Role } from './ledger.js';
import { writeFileAtomic } from './lib/atomic-file.js';
import { findSecrets } from './lib/secrets.js';
import type { ReasonCode } from './reasons.js';
import { checkReport } from './report.js';
import type { AgentReport } from './report.js';

export interface Extracted {
  /** The JSON text of the one `arima-report` block, when there is exactly one. */
  json?: string;
  /** Why extraction failed. */
  error?: string;
}

/**
 * Finds the `arima-report` block in an agent's final message (03-contracts 3.3). Exactly one is
 * required: none, an unclosed one, or several are all errors. A block may be inside a longer
 * fence (a report quoted in prose cannot count), so fences are parsed the way packet.ts does.
 */
export function extractReport(message: string): Extracted {
  const blocks: { info: string; body: string; closed: boolean }[] = [];
  let open: { len: number; info: string; lines: string[] } | undefined;
  for (const line of message.replaceAll('\r\n', '\n').split('\n')) {
    if (open) {
      const close = /^(`{3,})\s*$/.exec(line);
      if (close && (close[1] as string).length >= open.len) {
        blocks.push({ info: open.info, body: open.lines.join('\n'), closed: true });
        open = undefined;
      } else open.lines.push(line);
      continue;
    }
    const start = /^(`{3,})(.*)$/.exec(line);
    if (start)
      open = { len: (start[1] as string).length, info: (start[2] as string).trim(), lines: [] };
  }
  if (open) blocks.push({ info: open.info, body: open.lines.join('\n'), closed: false });
  const reports = blocks.filter((b) => b.info === 'arima-report');
  if (reports.length === 0) return { error: 'the final message has no arima-report block' };
  if (reports.length > 1)
    return {
      error: `the final message has ${reports.length} arima-report blocks; exactly one is required`,
    };
  const only = reports[0] as { body: string; closed: boolean };
  if (!only.closed) return { error: 'the arima-report block is never closed' };
  return { json: only.body };
}

export interface CollectInput {
  projectDir: string;
  runId: string;
  role: Role;
  kind: UnitKind;
  item: string;
  /** The final message of the run (`result` of the claude result object). */
  message: string | undefined;
}

export interface Collected {
  ok: boolean;
  report?: AgentReport;
  /** Set when not ok: `report_invalid`, `evidence_missing` or `secret_in_output`. */
  reason?: ReasonCode;
  errors: string[];
}

export const reportFile = (projectDir: string, runId: string): string =>
  path.join(projectDir, '.arima', 'runs', `${runId}.report.json`);

/**
 * Extracts, validates and stores the agent report (03-contracts 3.3). A missing or invalid block
 * is a failed run (`report_invalid`); a report that holds a secret is dropped unread
 * (`secret_in_output`); a criterion marked met without evidence is `evidence_missing`. Only a valid
 * report is written to `runs/<run_id>.report.json`. Records `report.accepted` or `report.rejected`.
 */
export async function collectReport(i: CollectInput): Promise<Collected> {
  const reject = async (reason: ReasonCode, errors: string[]): Promise<Collected> => {
    await appendEvent(i.projectDir, {
      type: 'report.rejected',
      actor: 'system',
      run_id: i.runId,
      ...(i.item !== 'none' ? { item: i.item } : {}),
      data: { role: i.role, kind: i.kind, reason, errors: errors.slice(0, 10) },
    });
    return { ok: false, reason, errors };
  };

  if (i.message === undefined || i.message.trim() === '')
    return reject('report_invalid', ['the run produced no final message']);
  if (findSecrets(i.message).length > 0)
    return reject('secret_in_output', [
      'the final message looks like it contains a secret; it was discarded',
    ]);

  const ex = extractReport(i.message);
  if (ex.json === undefined) return reject('report_invalid', [ex.error ?? 'no report']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(ex.json);
  } catch {
    return reject('report_invalid', ['the arima-report block is not valid JSON']);
  }

  const check = checkReport(parsed, { role: i.role, kind: i.kind });
  if (!check.ok)
    return reject(check.evidenceMissing ? 'evidence_missing' : 'report_invalid', check.errors);
  const report = parsed as AgentReport;
  const errors: string[] = [];
  if (report.run_id !== i.runId)
    errors.push(`run_id: report says "${report.run_id}" but this is run ${i.runId}`);
  if (report.item !== i.item)
    errors.push(`item: report says "${report.item}" but the unit's item is "${i.item}"`);
  if (errors.length > 0) return reject('report_invalid', errors);

  const file = reportFile(i.projectDir, i.runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(report, null, 2)}\n`);
  await appendEvent(i.projectDir, {
    type: 'report.accepted',
    actor: 'system',
    run_id: i.runId,
    ...(i.item !== 'none' ? { item: i.item } : {}),
    data: {
      role: i.role,
      kind: i.kind,
      status: report.status,
      ...(report.verdict ? { verdict: report.verdict.result } : {}),
    },
  });
  return { ok: true, report, errors: [] };
}
