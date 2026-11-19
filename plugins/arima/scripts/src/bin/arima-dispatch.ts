import { runDispatchCli } from '../cli/dispatch-cli.js';

process.exitCode = await runDispatchCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
