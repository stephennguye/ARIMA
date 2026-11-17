import { handleHook } from '../hooks.js';
import type { HookInput } from '../hooks.js';

const KINDS = ['pre-tool-use', 'post-tool-use', 'stop', 'subagent-stop'] as const;
type Kind = (typeof KINDS)[number];

export interface HookIo {
  stdin: string;
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * `arima-hook <kind>`: reads the hook payload JSON from stdin. Exit 0 allows; exit 2 blocks with
 * the reason on stderr. Malformed input never blocks (a broken hook must not wedge the session).
 */
export async function runHookCli(argv: string[], io: HookIo): Promise<number> {
  const kind = argv[0];
  if (!(KINDS as readonly string[]).includes(kind ?? '')) {
    io.err(`Usage: arima-hook <${KINDS.join('|')}> (payload JSON on stdin)\n`);
    return 1;
  }
  let input: HookInput = {};
  try {
    const parsed: unknown = io.stdin.trim() === '' ? {} : JSON.parse(io.stdin);
    if (parsed !== null && typeof parsed === 'object') input = parsed as HookInput;
  } catch {
    return 0;
  }
  try {
    const out = await handleHook(kind as Kind, input, io.env ?? process.env);
    if (out.stderr) io.err(`${out.stderr}\n`);
    return out.exitCode;
  } catch {
    return 0;
  }
}
