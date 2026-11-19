import { runWorktreeCli } from '../cli/worktree-cli.js';

process.exitCode = await runWorktreeCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
