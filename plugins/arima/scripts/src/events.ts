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
  | 'hardstop.hit';

export interface ArimaEvent {
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
