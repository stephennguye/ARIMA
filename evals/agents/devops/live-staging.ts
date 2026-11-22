// A real staging on the local Docker for the devops scenarios (WP-213 step 7): a tiny service built from the
// postgres image already on the machine (a netcat HTTP server), deployed by the real `arima-env`. `good` is
// staging at version 1; `rolledback` is staging where a bad version 2 failed its health check and the host
// put version 1 back. The agent only reads it (status, logs, smoke), so one fixture serves every run.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { git, scratchProject } from '../_support.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const ARIMA_ENV = path.join(ROOT, 'plugins/arima/scripts/dist/arima-env.mjs');
const BS = String.fromCharCode(92);

const dockerfile = (status: string): string =>
  `FROM postgres:17-alpine\nCMD ["sh", "-c", "while true; do printf 'HTTP/1.1 ${status}${BS}${BS}r${BS}${BS}nContent-Length: 3${BS}${BS}r${BS}${BS}nConnection: close${BS}${BS}r${BS}${BS}n${BS}${BS}r${BS}${BS}nok${BS}${BS}n' | nc -l -p 8080; done"]\n`;

const COMPOSE = [
  'services:',
  '  web:',
  '    build: { context: .., dockerfile: Dockerfile }',
  '    image: arima-local/${ARIMA_PROJECT}-web:${ARIMA_TAG}',
  '    ports: ["127.0.0.1:${ARIMA_PORT}:8080"]',
  '    healthcheck: { test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/"], interval: 2s, timeout: 3s, retries: 10 }',
  '    mem_limit: 128m',
  '',
].join('\n');

export interface LiveStaging {
  dir: string;
  key: string;
  port: number;
  dispose: () => void;
}

const envCli = (dir: string, args: string[]): number => {
  try {
    execFileSync(process.execPath, [ARIMA_ENV, ...args, '--project', dir], { stdio: 'pipe', timeout: 5 * 60_000 });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
};

export function liveStaging(kind: 'good' | 'rolledback' | 'badpreview'): LiveStaging {
  const key = kind === 'good' ? 'EVG' : kind === 'rolledback' ? 'EVR' : 'EVP';
  const port = kind === 'good' ? 3411 : kind === 'rolledback' ? 3412 : 3413;
  const { dir } = scratchProject(
    { Dockerfile: dockerfile('200 OK'), 'infra/compose.yaml': COMPOSE },
    'chore/eval',
    { key, stagingPort: port },
  );
  git(dir, 'checkout', '-q', 'main');
  if (kind === 'badpreview') {
    // The story branch carries an app that answers 500: its preview fails the smoke test and is left running.
    git(dir, 'checkout', '-q', '-b', 'feat/US-12-x');
    execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'Dockerfile'))}, process.argv[1])`, dockerfile('500 Err')]);
    git(dir, 'commit', '-qam', 'feat(US-12): the page');
    git(dir, 'checkout', '-q', 'main');
    const code = envCli(dir, ['up', 'preview-7', '--ref', 'feat/US-12-x', '--timeout', '8']);
    if (code !== 71) throw new Error(`the bad preview should have failed its smoke test (exit 71), got ${code}`);
    git(dir, 'checkout', '-q', 'chore/eval');
    return {
      dir,
      key,
      port,
      dispose: () => {
        envCli(dir, ['down', 'preview-7']);
        const project = key.toLowerCase();
        for (const i of execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' }).split(/\r?\n/).filter((x) => x.startsWith(`arima-local/${project}`)))
          try {
            execFileSync('docker', ['rmi', '-f', i], { stdio: 'pipe' });
          } catch {
            /* gone */
          }
      },
    };
  }
  if (envCli(dir, ['up', 'staging']) !== 0) throw new Error(`the fixture staging (${kind}) did not come up`);
  if (kind === 'rolledback') {
    execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'Dockerfile'))}, process.argv[1])`, dockerfile('500 Err')]);
    git(dir, 'commit', '-qam', 'v2 (answers 500)');
    const code = envCli(dir, ['up', 'staging', '--timeout', '8']);
    if (code !== 71) throw new Error(`the bad version should have been rolled back (exit 71), got ${code}`);
  }
  git(dir, 'checkout', '-q', 'chore/eval');
  const project = key.toLowerCase();
  return {
    dir,
    key,
    port,
    dispose: () => {
      envCli(dir, ['down', 'staging']);
      const images = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter((i) => i.startsWith(`arima-local/${project}`));
      for (const i of images) {
        try {
          execFileSync('docker', ['rmi', '-f', i], { stdio: 'pipe' });
        } catch {
          /* already gone */
        }
      }
      try {
        execFileSync('docker', ['volume', 'rm', '-f', `${project}-staging_data`], { stdio: 'pipe' });
      } catch {
        /* none */
      }
    },
  };
}
