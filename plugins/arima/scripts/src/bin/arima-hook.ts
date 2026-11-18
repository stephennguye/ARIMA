import { runHookCli } from '../cli/hook-cli.js';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);

process.exitCode = await runHookCli(process.argv.slice(2), {
  stdin: Buffer.concat(chunks).toString('utf8'),
  err: (s) => process.stderr.write(s),
});
