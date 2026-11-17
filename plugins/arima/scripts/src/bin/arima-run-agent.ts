import { runAgentCli } from '../cli/run-agent-cli.js';

process.exitCode = await runAgentCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
