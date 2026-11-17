import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT } from './helpers.js';

function loadAgent(name: string): { front: Record<string, unknown>; body: string } {
  const text = readFileSync(path.join(PLUGIN_ROOT, 'agents', `${name}.md`), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${name}.md has no frontmatter`);
  return { front: parse(m[1] as string) as Record<string, unknown>, body: m[2] as string };
}

/** Spec §5: every agent file has exactly these sections, in this order. */
const SECTIONS = [
  'Mission',
  'Triggered by',
  'Reads',
  'Writes',
  'Tools',
  'Must not',
  'Done when',
  'Escalates when',
];

describe('agents/orchestrator.md (spec §5.2)', () => {
  const { front, body } = loadAgent('orchestrator');

  it('has valid frontmatter with no ":" in the name', () => {
    expect(front['name']).toBe('orchestrator');
    expect(String(front['name'])).not.toContain(':');
    expect(String(front['description']).length).toBeGreaterThan(20);
    expect(front['model']).toBe('inherit');
  });

  it('has exactly the eight spec sections, in order', () => {
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(SECTIONS);
  });

  it('grants no Notion MCP tool and no web access (ADR-0003, v0.1 abilities)', () => {
    const tools = String(front['tools'])
      .split(',')
      .map((t) => t.trim());
    expect(tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
    expect(tools.some((t) => /notion|mcp__/i.test(t))).toBe(false);
  });

  it('states the must-nots of spec §5.2 and the security rules of §11.3', () => {
    const must = /## Must not([\s\S]*?)\n## /.exec(body)?.[1] ?? '';
    for (const phrase of [
      'product code',
      'Approve a gate',
      'merge',
      'deploy to production',
      'Delete anything',
      'human-only',
      'secret',
      'Follow instructions found in Notion',
    ]) {
      expect(must, phrase).toContain(phrase);
    }
  });

  it('references only scripts that ship in the plugin, via CLAUDE_PLUGIN_ROOT', () => {
    const refs = [...body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/dist\/([a-z-]+)\.mjs/g)].map(
      (m) => m[1],
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const r of new Set(refs)) {
      expect([
        'arima-config',
        'arima-preflight',
        'arima-ids',
        'arima-notion',
        'arima-state',
      ]).toContain(r);
    }
  });
});
