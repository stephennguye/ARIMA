import { runLessonsCli } from '../cli/lessons-cli.js';

process.exitCode = await runLessonsCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
});
