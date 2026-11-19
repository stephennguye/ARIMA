import { runCostCli } from '../cli/cost-cli.js';

process.exitCode = await runCostCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
