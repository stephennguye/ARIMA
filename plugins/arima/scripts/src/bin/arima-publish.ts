import { runPublishCli } from '../cli/publish-cli.js';

process.exitCode = await runPublishCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
