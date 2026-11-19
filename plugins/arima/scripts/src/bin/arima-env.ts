import { runEnvCli } from '../cli/env-cli.js';

process.exitCode = await runEnvCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
