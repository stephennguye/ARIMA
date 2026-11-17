import { runStateCli } from '../cli/state-cli.js';

process.exitCode = await runStateCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
