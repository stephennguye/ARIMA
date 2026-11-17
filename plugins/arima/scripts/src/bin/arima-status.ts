import { runStatusCli } from '../cli/project-cli.js';

process.exitCode = runStatusCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
