import { runDigestCli } from '../cli/digest-cli.js';

process.exitCode = await runDigestCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
