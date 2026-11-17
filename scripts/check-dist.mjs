// Fails if a fresh build differs from the committed plugins/arima/scripts/dist (ADR-0001).
import { execFileSync } from 'node:child_process';

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

run(process.execPath, ['scripts/build.mjs']);
const dirty = run('git', ['status', '--porcelain', '--', 'plugins/arima/scripts/dist']).trim();
if (dirty) {
  console.error('dist/ is out of date. Run `npm run build` and commit the result:\n' + dirty);
  process.exit(1);
}
console.log('dist/ is up to date.');
