import { findProjectDir, handleHook } from '../hooks.js';
import type { HookInput } from '../hooks.js';

const KINDS = [
  'pre-tool-use',
  'post-tool-use',
  'permission-denied',
  'stop',
  'subagent-stop',
] as const;
type Kind = (typeof KINDS)[number];

export interface HookIo {
  stdin: string;
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Where the hook runs when the payload gives no cwd (defaults to the process's). */
  cwd?: string;
}

/**
 * `arima-hook <kind>`: reads the hook payload JSON from stdin. Exit 0 allows; exit 2 blocks with
 * the reason on stderr.
 *
 * Failure policy: the PreToolUse guard is a hard stop, so inside an ARIMA project it fails CLOSED
 * (a payload it cannot read, or an internal error, blocks the call). Outside an ARIMA project it
 * does nothing. The audit hooks (post-tool-use, stop, subagent-stop) fail open: losing a log line
 * must never wedge a session.
 */
export async function runHookCli(argv: string[], io: HookIo): Promise<number> {
  const kind = argv[0];
  if (!(KINDS as readonly string[]).includes(kind ?? '')) {
    io.err(`Usage: arima-hook <${KINDS.join('|')}> (payload JSON on stdin)\n`);
    return 1;
  }
  const env = io.env ?? process.env;
  const closed = (why: string): number => {
    io.err(
      `ARIMA guard could not decide (${why}), so this action is blocked to be safe. Ask the human to check the ARIMA plugin.\n`,
    );
    return 2;
  };
  const failsClosed = (): boolean =>
    kind === 'pre-tool-use' && findProjectDir({ cwd: io.cwd ?? process.cwd() }, env) !== undefined;

  let input: HookInput;
  try {
    const parsed: unknown = io.stdin.trim() === '' ? {} : JSON.parse(io.stdin);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('payload is not an object');
    input = parsed as HookInput;
  } catch {
    return failsClosed() ? closed('unreadable payload') : 0;
  }
  try {
    const out = await handleHook(kind as Kind, input, env);
    if (out.stderr) io.err(`${out.stderr}\n`);
    return out.exitCode;
  } catch (e) {
    return failsClosed() ? closed(e instanceof Error ? e.message : 'internal error') : 0;
  }
}
