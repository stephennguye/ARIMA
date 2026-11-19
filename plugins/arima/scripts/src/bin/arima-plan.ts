import { runPlanCli } from '../cli/plan-cli.js';

process.exitCode = await runPlanCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
