import { runMergeCli } from '../cli/merge-cli.js';

process.exitCode = await runMergeCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
