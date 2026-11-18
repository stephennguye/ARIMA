import { runConfigCli } from '../cli/config-cli.js';

process.exitCode = runConfigCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
