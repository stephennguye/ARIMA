import path from 'node:path';
import { appendJsonl, readJsonl } from './lib/jsonl.js';

export type EventType =
  | 'run.start'
  | 'run.end'
  | 'run.paused'
  | 'preflight.fail'
  | 'killswitch.on'
  | 'killswitch.off'
  | 'id.issued'
  | 'notion.pull'
  | 'notion.push'
  | 'notion.conflict'
  | 'notion.refused'
  | 'item.status'
  | 'gate.opened'
  | 'gate.decided'
  | 'question.raised'
  | 'question.answered'
  | 'decision.made'
  | 'decision.vetoed'
  | 'tool.used'
  | 'tool.blocked'
  | 'state.push'
  | 'state.pull'
  | 'budget.alert'
  | 'sandbox.finished'
  | 'hardstop.hit'
  | 'agent.stop'
  | 'report.accepted'
  | 'report.rejected'
  | 'unit.dispatched'
  | 'unit.retried'
  | 'merge.done'
  | 'merge.refused'
  | 'pr.published'
  | 'deploy.staging'
  | 'deploy.preview'
  | 'deploy.production'
  | 'deploy.rollback'
  | 'probe.recorded'
  | 'meeting.held'
  | 'digest.published'
  | 'phase.step_done'
  | 'phase.pilot_failed'
  | 'team.changed'
  | 'release.rc_tagged'
  | 'incident.opened'
  | 'incident.closed'
  | 'cr.decided'
  | 'lesson.applied';

export interface ArimaEvent {
  /** Absent on events written before the field existed; means 1 (WP-195). */
  schema_version?: 1;
  ts: string;
  type: EventType;
  actor: string;
  run_id?: string;
  item?: string;
  data?: Record<string, unknown>;
}

export type NewEvent = Omit<ArimaEvent, 'ts'> & { ts?: string };

export function eventsFile(projectDir: string): string {
  return path.join(projectDir, '.arima', 'events.jsonl');
}

/** Appends one event to .arima/events.jsonl (validated, append-only). Returns what was written. */
export async function appendEvent(projectDir: string, event: NewEvent): Promise<ArimaEvent> {
  const full = { ...event, ts: event.ts ?? new Date().toISOString() } as ArimaEvent;
  await appendJsonl(eventsFile(projectDir), 'event', full);
  return full;
}

export function readEvents(projectDir: string): ArimaEvent[] {
  return readJsonl<ArimaEvent>(eventsFile(projectDir), 'event');
}
