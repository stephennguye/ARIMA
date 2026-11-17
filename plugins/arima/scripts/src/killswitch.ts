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
 * Reads both kill switches: the "Pause ARIMA" to-do on the Notion root page and the PAUSE file
 * on the state branch. Either one being on pauses ARIMA. If Notion cannot be reached the PAUSE
 * file alone decides (spec §11.3); that is reported, not silently ignored.
 */
export async function checkKillSwitch(
  projectDir: string,
  notion: { port: PauseSwitchPort; rootPageId: string } | null,
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
        detail = `no "${PAUSE_TODO_TEXT}" to-do found on the Notion root page`;
      } else {
        remote = sw.checked;
      }
    } catch (e) {
      remote = 'unreachable';
      detail = `Notion unreachable (${e instanceof Error ? e.message : String(e)}); using the PAUSE file only`;
    }
  }
  const on = file || remote === true;
  if (on) {
    const reasons = [
      file ? 'PAUSE file present' : '',
      remote === true ? 'Notion switch is on' : '',
    ];
    detail = reasons.filter(Boolean).join(' and ');
    if (file) {
      const first = readFileSync(pauseFile(projectDir), 'utf8').split('\n')[0] ?? '';
      if (first.trim() !== '') detail += ` (${first.trim()})`;
    }
  }
  return { on, file, notion: remote, detail };
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
