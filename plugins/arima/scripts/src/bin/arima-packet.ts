import { runPacketCli } from '../cli/packet-cli.js';

process.exitCode = runPacketCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
