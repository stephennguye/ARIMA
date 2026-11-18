import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAUSE_TODO_TEXT } from './notion/port.js';
import type { PauseSwitchPort } from './notion/port.js';

export type NotionPauseState = boolean | 'unreachable' | 'unchecked' | 'missing';

export interface KillSwitchState {
  /** True when either source says pause (fail closed, spec principle 10). */
  on: boolean;
  file: boolean;
  notion: NotionPauseState;
  /** The PAUSE file on the remote state branch, when it had to be consulted. */
  stateBranch: boolean | 'unchecked';
  detail: string;
}

export function pauseFile(projectDir: string): string {
  return path.join(projectDir, '.arima', 'PAUSE');
}

export function setPauseFile(projectDir: string, on: boolean, reason = 'paused by a human'): void {
  const file = pauseFile(projectDir);
  if (on) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${reason}\n${new Date().toISOString()}\n`, 'utf8');
  } else {
    rmSync(file, { force: true });
  }
}

/**
 * Reads the kill switches: the "Pause ARIMA" to-do on the Notion root page, the local PAUSE file,
 * and (when Notion cannot be consulted) the PAUSE file on the remote state branch. ANY of them
 * being on pauses ARIMA, and uncertainty also pauses (spec principle 10, fail closed):
 *  - a Notion root page with no "Pause ARIMA" to-do counts as paused, because a deleted switch
 *    must not mean "running";
 *  - if Notion is unreachable, the local PAUSE file and the remote state branch decide, and the
 *    outage is reported.
 * `remotePause` returns true/false for the state branch's PAUSE file, or undefined if it could not
 * be checked.
 */
export async function checkKillSwitch(
  projectDir: string,
  notion: { port: PauseSwitchPort; rootPageId: string } | null,
  remotePause?: () => Promise<boolean | undefined>,
): Promise<KillSwitchState> {
  const file = existsSync(pauseFile(projectDir));
  let remote: NotionPauseState = 'unchecked';
  let detail = '';
  if (notion !== null) {
    try {
      const todos = await notion.port.listTodoBlocks(notion.rootPageId);
      const sw = todos.find((t) => t.text.trim() === PAUSE_TODO_TEXT);
      if (sw === undefined) {
        remote = 'missing';
        detail = `the "${PAUSE_TODO_TEXT}" to-do is missing from the Notion root page, so ARIMA cannot tell whether it is paused; run /arima:pause --resume to recreate it`;
      } else {
        remote = sw.checked;
      }
    } catch (e) {
      remote = 'unreachable';
      detail = `Notion unreachable (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  let stateBranch: boolean | 'unchecked' = 'unchecked';
  if (!file && remote !== true && remotePause !== undefined && remote !== false) {
    const r = await remotePause();
    stateBranch = r === undefined ? 'unchecked' : r;
  }
  // Owner decision (S18, principle 10): when Notion is configured but neither it nor the remote
  // state branch could be read, nothing confirms "not paused", so ARIMA counts as paused.
  const blind = notion !== null && remote === 'unreachable' && stateBranch === 'unchecked';
  const on = file || remote === true || remote === 'missing' || stateBranch === true || blind;
  if (on) {
    const reasons = [
      file ? 'PAUSE file present' : '',
      remote === true ? 'Notion switch is on' : '',
      remote === 'missing' ? detail : '',
      stateBranch === true ? 'PAUSE file on the remote state branch' : '',
      blind
        ? `${detail}; the remote state branch could not be checked either, so ARIMA cannot confirm it is not paused`
        : '',
    ];
    detail = reasons.filter(Boolean).join(' and ');
    if (file) {
      const first = readFileSync(pauseFile(projectDir), 'utf8').split('\n')[0] ?? '';
      if (first.trim() !== '') detail += ` (${first.trim()})`;
    }
  } else if (remote === 'unreachable') {
    detail +=
      stateBranch === false
        ? '; the remote state branch has no PAUSE file'
        : '; the remote state branch could not be checked either, so only the local PAUSE file was consulted';
  }
  return { on, file, notion: remote, stateBranch, detail };
}

/** Turns the Notion switch on or off, creating the to-do on first use. Never deletes anything. */
export async function setNotionSwitch(
  port: PauseSwitchPort,
  rootPageId: string,
  on: boolean,
): Promise<void> {
  const todos = await port.listTodoBlocks(rootPageId);
  const sw = todos.find((t) => t.text.trim() === PAUSE_TODO_TEXT);
  if (sw === undefined) {
    await port.appendTodo(rootPageId, PAUSE_TODO_TEXT, on);
  } else if (sw.checked !== on) {
    await port.setTodoChecked(sw.id, on);
  }
}

/**
 * Makes sure the Notion switch exists, creating it UNCHECKED if it is missing. Never changes an
 * existing switch, so it cannot clear a pause. Returns true if it had to create it.
 */
export async function ensureNotionSwitch(
  port: PauseSwitchPort,
  rootPageId: string,
): Promise<boolean> {
  const todos = await port.listTodoBlocks(rootPageId);
  if (todos.some((t) => t.text.trim() === PAUSE_TODO_TEXT)) return false;
  await port.appendTodo(rootPageId, PAUSE_TODO_TEXT, false);
  return true;
}
