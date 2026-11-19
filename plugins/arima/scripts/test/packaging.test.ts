// S0.8: the plugin folder is self-contained, its JSON is valid, and runtime dependencies are Apache-2.0 compatible.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT, REPO_ROOT } from './helpers.js';

const read = (p: string): string => readFileSync(p, 'utf8');

describe('plugin packaging', () => {
  it.each(['LICENSE', 'NOTICE', 'CHANGELOG.md', 'README.md'])(
    '%s ships inside the plugin folder',
    (f) => {
      expect(existsSync(path.join(PLUGIN_ROOT, f))).toBe(true);
    },
  );
  it('LICENSE and NOTICE match the repository root', () => {
    expect(read(path.join(PLUGIN_ROOT, 'LICENSE'))).toBe(read(path.join(REPO_ROOT, 'LICENSE')));
    expect(read(path.join(PLUGIN_ROOT, 'NOTICE'))).toBe(read(path.join(REPO_ROOT, 'NOTICE')));
  });
  it('the changelog has an entry for the manifest version line', () => {
    const v = (
      JSON.parse(read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) as {
        version: string;
      }
    ).version;
    expect(read(path.join(PLUGIN_ROOT, 'CHANGELOG.md'))).toContain(v.replace(/-dev$/, ''));
  });
  it('hooks.json is valid and every command names a file that exists', () => {
    const h = JSON.parse(read(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'))) as {
      hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
    };
    for (const groups of Object.values(h.hooks))
      for (const g of groups)
        for (const hook of g.hooks) {
          expect(hook.timeout).toBeGreaterThan(0);
          const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(hook.command);
          expect(m).not.toBeNull();
          expect(existsSync(path.join(PLUGIN_ROOT, m![1] as string))).toBe(true);
        }
  });
  it('runtime dependencies use licences compatible with Apache-2.0', () => {
    const ok = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD)$/;
    for (const dep of ['@notionhq/client', 'ajv', 'yaml']) {
      const pj = JSON.parse(read(path.join(REPO_ROOT, 'node_modules', dep, 'package.json'))) as {
        license: string;
      };
      expect(pj.license, dep).toMatch(ok);
    }
  });
});
