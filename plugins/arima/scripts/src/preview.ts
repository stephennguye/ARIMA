import { execFileSync } from 'node:child_process';
import { ENV_EXIT, EnvError, downEnv, readEnvState, upEnv } from './env.js';
import type { EnvDeps, EnvRecord, EnvSettings } from './env.js';
import { appendEvent } from './events.js';

/**
 * Preview environments (WP-218, D-47): the host, never an agent, runs `arima-env up preview-<pr>` for
 * a story that reached In Review, so the tech-lead's approval can move it to In QA only once a
 * preview answers its smoke request, and QA tests that preview. A preview that does not answer
 * stays recorded as failed (with its error) and the queue plans a devops `preview-diagnose` unit.
 */

export const previewName = (pr: number): string => `preview-${pr}`;
export const previewUrl = (port: number): string => `http://localhost:${port}`;

/** True when the repository has a Compose file at the default branch (Phase 3 done): no file, no preview is possible. */
export function previewsPossible(s: EnvSettings): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${s.defaultBranch}:${s.composeFile}`], {
      cwd: s.projectDir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** The recorded preview of a PR, if any. */
export function previewOf(projectDir: string, pr: number): EnvRecord | undefined {
  try {
    return readEnvState(projectDir).previews[String(pr)];
  } catch {
    return undefined;
  }
}

/** A preview of this PR that answered its smoke request at this commit. */
export function previewHealthy(projectDir: string, pr: number, sha?: string): boolean {
  const r = previewOf(projectDir, pr);
  return r !== undefined && r.ok && (sha === undefined || r.ref === sha);
}

export interface FailedPreview {
  pr: number;
  ref: string;
  error: string;
}

/** Previews whose last deploy failed its smoke test and has not been followed by a good one. */
export function failedPreviews(projectDir: string): FailedPreview[] {
  try {
    return Object.entries(readEnvState(projectDir).previews)
      .filter(([, r]) => !r.ok)
      .map(([pr, r]) => ({
        pr: Number(pr),
        ref: r.ref,
        error: r.error ?? 'the preview did not answer',
      }));
  } catch {
    return [];
  }
}

/** The commit a branch points at, or undefined when it does not exist. */
export function branchSha(projectDir: string, branch: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

export interface EnsureResult {
  pr: number;
  item: string;
  result: 'up' | 'unchanged' | 'failed' | 'skipped';
  url?: string;
  error?: string;
}

/**
 * Creates or refreshes the preview of each story that is In Review and has a published PR: one whose
 * recorded preview is healthy at the branch's current commit is left alone. A failure is recorded by
 * `upEnv` (state and event) and returned, never thrown; a paused ARIMA or a repository without a
 * Compose file skips quietly.
 */
export async function ensurePreviews(
  s: EnvSettings,
  items: { item: string; pr: number; branch: string }[],
  deps: EnvDeps = {},
): Promise<EnsureResult[]> {
  const out: EnsureResult[] = [];
  if (items.length === 0) return out;
  if (!previewsPossible(s))
    return items.map((i) => ({ pr: i.pr, item: i.item, result: 'skipped' as const }));
  for (const i of items) {
    const sha = branchSha(s.projectDir, i.branch);
    if (sha === undefined) {
      out.push({
        pr: i.pr,
        item: i.item,
        result: 'skipped',
        error: `branch ${i.branch} does not exist here`,
      });
      continue;
    }
    if (previewHealthy(s.projectDir, i.pr, sha)) {
      out.push({
        pr: i.pr,
        item: i.item,
        result: 'unchanged',
        url: previewUrl(previewOf(s.projectDir, i.pr)?.port ?? 0),
      });
      continue;
    }
    try {
      const r = await upEnv(s, previewName(i.pr), { ...deps, ref: i.branch });
      out.push({ pr: i.pr, item: i.item, result: 'up', url: previewUrl(r.port) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const paused = e instanceof EnvError && e.exit === ENV_EXIT.killSwitch;
      if (paused) {
        out.push({ pr: i.pr, item: i.item, result: 'skipped', error: message.slice(0, 200) });
        continue;
      }
      // upEnv records a failed smoke test itself; a refusal before that (lint, export) needs a record here.
      if (!failedPreviews(s.projectDir).some((f) => f.pr === i.pr && f.ref === sha)) {
        await appendEvent(s.projectDir, {
          type: 'deploy.preview',
          actor: 'system',
          item: i.item,
          data: { environment: previewName(i.pr), ok: false, error: message.slice(0, 600) },
        });
      }
      out.push({ pr: i.pr, item: i.item, result: 'failed', error: message.slice(0, 600) });
    }
  }
  return out;
}

/** Removes a preview (containers and its volumes) when its PR is merged or closed; no error if there is none. */
export async function removePreview(
  s: EnvSettings,
  pr: number,
  deps: EnvDeps = {},
): Promise<boolean> {
  if (previewOf(s.projectDir, pr) === undefined) return false;
  try {
    await downEnv(s, previewName(pr), deps);
    return true;
  } catch {
    return false;
  }
}

/** Statuses after which a story's preview has no use: merged and accepted, released, or cancelled (a closed PR). */
export const PREVIEW_DONE_STATUSES: ReadonlySet<string> = new Set([
  'PO Acceptance',
  'Done',
  'Released',
  'Cancelled',
]);

/**
 * Removes the previews of stories whose work is over (merged, accepted, released or cancelled), so a
 * merged or closed PR never leaves containers and volumes behind. `prItems` maps a PR number to its story.
 */
export async function sweepPreviews(
  s: EnvSettings,
  prItems: Record<number, string>,
  statusOf: (item: string) => string | undefined,
  deps: EnvDeps = {},
): Promise<number[]> {
  const removed: number[] = [];
  let state;
  try {
    state = readEnvState(s.projectDir);
  } catch {
    return removed;
  }
  for (const key of Object.keys(state.previews)) {
    const pr = Number(key);
    const item = prItems[pr];
    const status = item === undefined ? undefined : statusOf(item);
    if (
      status !== undefined &&
      PREVIEW_DONE_STATUSES.has(status) &&
      (await removePreview(s, pr, deps))
    )
      removed.push(pr);
  }
  return removed;
}
