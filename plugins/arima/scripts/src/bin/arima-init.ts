import { runInitCli } from '../cli/project-cli.js';

process.exitCode = await runInitCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
