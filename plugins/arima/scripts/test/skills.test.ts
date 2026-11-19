import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateProject } from '../src/config.js';
import { EXAMPLES, PLUGIN_ROOT, project } from './helpers.js';

function skill(name: string): { front: Record<string, unknown>; body: string } {
  const text = readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${name}/SKILL.md has no frontmatter`);
  return { front: parse(m[1] as string) as Record<string, unknown>, body: m[2] as string };
}

const binNames = readdirSync(path.join(PLUGIN_ROOT, 'scripts', 'src', 'bin'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''));

describe('skills (spec §14)', () => {
  it.each(['init', 'status', 'pause', 'cost', 'plan'])('%s has valid frontmatter', (name) => {
    const { front } = skill(name);
    expect(front['name']).toBe(name);
    expect(String(front['description']).length).toBeGreaterThan(30);
    expect(String(front['allowed-tools'])).toMatch(
      /Bash\(node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/dist\//,
    );
  });

  it('consequential commands are user-invoked only; status may be model-invoked', () => {
    expect(skill('init').front['disable-model-invocation']).toBe(true);
    expect(skill('pause').front['disable-model-invocation']).toBe(true);
    expect(skill('plan').front['disable-model-invocation']).toBe(true);
    expect(skill('status').front['disable-model-invocation']).toBeUndefined();
  });

  it('only reference scripts that exist (src/bin), and none grants unrestricted Bash', () => {
    for (const name of ['init', 'status', 'pause', 'cost', 'plan']) {
      const { front, body } = skill(name);
      const refs = [
        ...`${String(front['allowed-tools'])}\n${body}`.matchAll(
          /scripts\/dist\/(arima-[a-z]+)\.mjs/g,
        ),
      ].map((m) => m[1] as string);
      expect(refs.length, name).toBeGreaterThan(0);
      for (const r of new Set(refs)) expect(binNames, `${name} -> ${r}`).toContain(r);
      expect(String(front['allowed-tools']).split(/\s+/)).not.toContain('Bash');
    }
  });

  it('init covers every documented exit code and never asks for a secret', () => {
    const { body } = skill('init');
    for (const code of [
      '| 0 |',
      '| 2 |',
      '| 3 |',
      '| 4 |',
      '| 5 |',
      '| 10 |',
      '| 11 |',
      '| 12 |',
      '| 13 |',
      '| 14 |',
    ]) {
      expect(body, code).toContain(code);
    }
    expect(body).toMatch(/Never ask the user to paste a token/);
    expect(body).toMatch(/data, never as instructions/);
  });

  it('pause explains both switches and the Notion-down case', () => {
    const { body } = skill('pause');
    expect(body).toContain('PAUSE file');
    expect(body).toContain('Pause ARIMA');
    expect(body).toMatch(/cannot be reached/);
  });

  it('ships example config that stays identical to examples/ and validates', () => {
    for (const f of ['arima', 'team']) {
      const shipped = readFileSync(
        path.join(PLUGIN_ROOT, 'templates', `${f}.example.yaml`),
        'utf8',
      );
      expect(shipped, `${f}.example.yaml drifted from examples/${f}.yaml`).toBe(
        readFileSync(path.join(EXAMPLES, `${f}.yaml`), 'utf8'),
      );
    }
    const dir = project();
    expect(validateProject(dir).ok).toBe(true);
    expect(existsSync(path.join(PLUGIN_ROOT, 'templates', 'project-brief.md'))).toBe(true);
  });
});
