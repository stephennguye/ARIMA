import { runJudgeCli } from '../cli/judge-cli.js';

process.exitCode = await runJudgeCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
