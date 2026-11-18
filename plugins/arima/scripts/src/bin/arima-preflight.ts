import { runPreflightCli } from '../cli/preflight-cli.js';

process.exitCode = await runPreflightCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
