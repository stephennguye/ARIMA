// Points git at the committed hooks (.githooks/) so local pushes to main are blocked.
// Silent no-op outside a git checkout (e.g. when installed from a tarball).
import { execFileSync } from 'node:child_process';
try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  /* not a git checkout */
}
