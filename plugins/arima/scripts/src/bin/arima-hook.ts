import { runHookCli } from '../cli/hook-cli.js';
import { findProjectDir } from '../hooks.js';

const kind = process.argv[2] ?? '';

/** Whatever goes wrong here, a PreToolUse guard inside an ARIMA project must say "block" (exit 2). */
function failureExit(): number {
  try {
    return kind === 'pre-tool-use' && findProjectDir({ cwd: process.cwd() }) !== undefined ? 2 : 0;
  } catch {
    return kind === 'pre-tool-use' ? 2 : 0;
  }
}

let code: number;
try {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  code = await runHookCli(process.argv.slice(2), {
    stdin: Buffer.concat(chunks).toString('utf8'),
    err: (s) => process.stderr.write(s),
  });
} catch {
  process.stderr.write('ARIMA guard crashed, so this action is blocked to be safe.\n');
  code = failureExit();
}

// Exit explicitly: a lock-retry timer left running by the event log must never keep this process
// alive until Claude Code's hook timeout kills it (a killed hook is NOT a block).
process.stderr.write('', () => process.exit(code));
