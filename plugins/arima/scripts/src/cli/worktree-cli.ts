import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  WorktreeError,
  createWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from '../worktree.js';
import type { Io } from './config-cli.js';

export const WORKTREE_EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export const WORKTREE_USAGE = `Usage: arima-worktree create --branch <feat/US-112-slug> --base <ref> --run-id <id> [--sparse <path>]... [--project <dir>] [--json]
       arima-worktree remove --branch <branch> [--delete-branch] [--project <dir>]
       arima-worktree list [--project <dir>] [--json]
       arima-worktree prune [--project <dir>]
Exit codes: 0 ok, 1 git failure or refusal, 2 usage`;

/** `arima-worktree`: host-only; no role is allowed to run it. */
export async function runWorktreeCli(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  let v: {
    branch?: string;
    base?: string;
    'run-id'?: string;
    sparse?: string[];
    project?: string;
    'delete-branch'?: boolean;
    json?: boolean;
  };
  try {
    v = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        branch: { type: 'string' },
        base: { type: 'string' },
        'run-id': { type: 'string' },
        sparse: { type: 'string', multiple: true },
        project: { type: 'string' },
        'delete-branch': { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }).values;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${WORKTREE_USAGE}\n`);
    return WORKTREE_EXIT.usage;
  }
  const projectDir = path.resolve(io.cwd, v.project ?? '.');
  const need = (name: string, value: string | undefined): string | undefined => {
    if (value === undefined) io.err(`--${name} is required\n${WORKTREE_USAGE}\n`);
    return value;
  };
  try {
    switch (command) {
      case 'create': {
        const branch = need('branch', v.branch);
        const base = need('base', v.base);
        const runId = need('run-id', v['run-id']);
        if (branch === undefined || base === undefined || runId === undefined)
          return WORKTREE_EXIT.usage;
        const c = await createWorktree({
          projectDir,
          branch,
          base,
          runId,
          ...(v.sparse ? { sparse: v.sparse } : {}),
        });
        io.out(
          v.json === true
            ? `${JSON.stringify(c)}\n`
            : `created ${c.path} on ${c.branch} at ${c.head.slice(0, 12)}\n`,
        );
        return WORKTREE_EXIT.ok;
      }
      case 'remove': {
        const branch = need('branch', v.branch);
        if (branch === undefined) return WORKTREE_EXIT.usage;
        const gone = await removeWorktree({
          projectDir,
          branch,
          ...(v['delete-branch'] ? { deleteBranch: true } : {}),
        });
        io.out(
          gone
            ? 'removed\n'
            : 'could not remove the folder completely; it will be pruned on the next dispatcher start\n',
        );
        return gone ? WORKTREE_EXIT.ok : WORKTREE_EXIT.failed;
      }
      case 'list': {
        const l = listWorktrees({ projectDir });
        io.out(
          v.json === true
            ? `${JSON.stringify(l)}\n`
            : l.map((w) => `${w.branch ?? '(detached)'}\t${w.path}\n`).join(''),
        );
        return WORKTREE_EXIT.ok;
      }
      case 'prune': {
        const r = await pruneWorktrees({ projectDir });
        io.out(
          `removed ${r.removed.length}, kept ${r.kept.length}, forgotten ${r.forgotten.length}\n`,
        );
        return WORKTREE_EXIT.ok;
      }
      default:
        io.err(`${WORKTREE_USAGE}\n`);
        return WORKTREE_EXIT.usage;
    }
  } catch (e) {
    if (!(e instanceof WorktreeError)) throw e;
    io.err(`${e.message}\n`);
    return WORKTREE_EXIT.failed;
  }
}
