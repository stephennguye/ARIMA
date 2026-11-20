import { runReviewCli } from '../cli/review-cli.js';

process.exitCode = await runReviewCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
