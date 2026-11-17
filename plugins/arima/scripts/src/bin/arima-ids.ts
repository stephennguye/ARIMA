import { runIdsCli } from '../cli/ids-cli.js';

process.exitCode = await runIdsCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
