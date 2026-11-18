import { appendEvent } from './events.js';
import { pauseFile, setNotionSwitch, setPauseFile } from './killswitch.js';
import type { PauseSwitchPort } from './notion/port.js';
import { issueRunId } from './runid.js';
import { StateError, pushState } from './state.js';
import { existsSync } from 'node:fs';

export interface PauseOptions {
  projectDir: string;
  /** true = pause, false = resume. */
  on: boolean;
  reason?: string;
  /** Notion access for the root-page switch; null = only the PAUSE file. */
  notion?: { port: PauseSwitchPort; rootPageId: string } | null;
  actor?: string;
  /** Commit the PAUSE file to the state branch so it survives a Notion outage. */
  saveState?: boolean;
  branch?: string;
  allowPublic?: boolean;
  defaultBranch?: string;
  now?: Date;
}

export interface PauseResult {
  /** The state ARIMA is now in, as far as it could be set. */
  paused: boolean;
  file: boolean;
  notion: 'set' | 'unreachable' | 'skipped';
  /** Resume could not clear the Notion switch, so ARIMA is still paused there. */
  stillPausedInNotion: boolean;
  /**
   * What happened to the state branch: pushed to the remote, committed locally (no remote
   * configured), unchanged (nothing new), skipped (not asked for), or failed (see messages). A
   * failure means other machines will not see this change.
   */
  stateSaved: 'pushed' | 'committed' | 'unchanged' | 'skipped' | 'failed';
  messages: string[];
}

/**
 * Sets or clears the kill switch (spec §11.3): the "Pause ARIMA" to-do on the Notion root page and
 * the PAUSE file. Pausing succeeds if either could be set (fail closed); resuming is complete only
 * when both are clear, and says so when Notion could not be cleared.
 */
export async function setKillSwitch(o: PauseOptions): Promise<PauseResult> {
  const messages: string[] = [];
  let notion: PauseResult['notion'] = 'skipped';
  if (o.notion) {
    try {
      await setNotionSwitch(o.notion.port, o.notion.rootPageId, o.on);
      notion = 'set';
      messages.push(`Notion switch ${o.on ? 'on' : 'off'}`);
    } catch (e) {
      notion = 'unreachable';
      messages.push(`Notion unreachable (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    messages.push('Notion switch not touched');
  }

  setPauseFile(o.projectDir, o.on, o.reason);
  messages.push(`PAUSE file ${o.on ? 'written' : 'removed'}`);

  await appendEvent(o.projectDir, {
    type: o.on ? 'killswitch.on' : 'killswitch.off',
    actor: o.actor ?? 'human',
    data: { notion, ...(o.reason ? { reason: o.reason } : {}) },
  });

  let stateSaved: PauseResult['stateSaved'] = 'skipped';
  if (o.saveState === true) {
    try {
      const runId = await issueRunId(o.projectDir, o.now);
      const s = await pushState({
        projectDir: o.projectDir,
        runId,
        ...(o.allowPublic ? { allowPublic: true } : {}),
        ...(o.branch ? { branch: o.branch } : {}),
        ...(o.defaultBranch ? { defaultBranch: o.defaultBranch } : {}),
      });
      stateSaved = s.pushed ? 'pushed' : s.committed ? 'committed' : 'unchanged';
      messages.push(
        s.pushed ? 'state pushed' : s.committed ? 'state committed locally' : 'state unchanged',
      );
    } catch (e) {
      stateSaved = 'failed';
      messages.push(
        `state not saved: ${e instanceof StateError || e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const stillPausedInNotion = !o.on && notion === 'unreachable';
  return {
    paused: o.on ? true : existsSync(pauseFile(o.projectDir)) || stillPausedInNotion,
    file: existsSync(pauseFile(o.projectDir)),
    notion,
    stillPausedInNotion,
    stateSaved,
    messages,
  };
}
