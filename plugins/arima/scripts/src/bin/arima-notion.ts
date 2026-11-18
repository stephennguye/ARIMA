import { runNotionCli } from '../cli/notion-cli.js';

process.exitCode = await runNotionCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
