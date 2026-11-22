// WP-218 real check on the local Docker (no model call): the host's ensurePreviews brings up preview-<pr> from a
// story branch, the URL answers over real HTTP, a second call leaves it alone, removePreview takes the
// containers and volume away. Skipped unless ARIMA_REAL_EVALS=1.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsFrom } from '../../../plugins/arima/scripts/src/env.js';
import { ensurePreviews, previewOf, removePreview } from '../../../plugins/arima/scripts/src/preview.js';
import { git, realEnabled, scratchProject } from '../_support.js';
import { writeFileSync } from 'node:fs';

const BS = String.fromCharCode(92);
const dockerfile = `FROM postgres:17-alpine\nCMD ["sh", "-c", "while true; do printf 'HTTP/1.1 200 OK${BS}${BS}r${BS}${BS}nContent-Length: 3${BS}${BS}r${BS}${BS}nConnection: close${BS}${BS}r${BS}${BS}n${BS}${BS}r${BS}${BS}nok${BS}${BS}n' | nc -l -p 8080; done"]\n`;
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

const running = (project: string): string =>
  execFileSync('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();

describe.skipIf(!realEnabled)('preview environments on real Docker (WP-218)', () => {
  it('comes up from the story branch, answers over HTTP, is left alone when unchanged, and is removed', async () => {
    const { dir } = scratchProject({ Dockerfile: dockerfile, 'infra/compose.yaml': COMPOSE }, 'feat/US-12-x', { key: 'EVW', stagingPort: 3414 });
    writeFileSync(path.join(dir, 'page.txt'), 'story work\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'feat(US-12): page');
    git(dir, 'checkout', '-q', 'main');
    const s = settingsFrom(dir, { github: { default_branch: 'main' }, project: { key: 'EVW' } });
    try {
      const [first] = await ensurePreviews(s, [{ item: 'US-12', pr: 7, branch: 'feat/US-12-x' }]);
      expect(first?.result, first?.error).toBe('up');
      expect(first?.url).toMatch(/^http:\/\/localhost:41\d\d$/);
      const body = await (await fetch(`${first?.url}/`)).text();
      expect(body).toContain('ok');
      expect(running('evw-preview-7')).not.toBe('');
      const [again] = await ensurePreviews(s, [{ item: 'US-12', pr: 7, branch: 'feat/US-12-x' }]);
      expect(again?.result).toBe('unchanged');
      expect(await removePreview(s, 7)).toBe(true);
      expect(previewOf(dir, 7)).toBeUndefined();
      expect(running('evw-preview-7')).toBe('');
    } finally {
      await removePreview(s, 7).catch(() => false);
      for (const i of execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' }).split(/\r?\n/).filter((x) => x.startsWith('arima-local/evw')))
        try {
          execFileSync('docker', ['rmi', '-f', i], { stdio: 'pipe' });
        } catch {
          /* gone */
        }
    }
  }, 10 * 60_000);
});
