import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { guardBash } from '../src/hooks.js';
import { isUnitKind } from '../src/kinds.js';
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
    expect(tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
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

describe('agents/devops.md (spec §5.10, card, ADR-0008)', () => {
  const { front, body } = loadAgent('devops');
  const text = readFileSync(path.join(PLUGIN_ROOT, 'agents', 'devops.md'), 'utf8');

  it('has valid frontmatter, a model of inherit and fits the 10,000-character cap', () => {
    expect(front['name']).toBe('devops');
    expect(String(front['description']).length).toBeGreaterThan(20);
    expect(front['model']).toBe('inherit');
    expect(text.length).toBeLessThan(10_000);
  });

  it('has exactly the eight spec sections, in order', () => {
    expect([...body.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(SECTIONS);
  });

  it('has a section of its own for every kind it can be dispatched with (CONCEPT 6)', () => {
    expect([...body.matchAll(/^### Kind (\S+)/gm)].map((m) => m[1])).toEqual([
      'env-plan',
      'deploy-staging',
    ]);
    for (const k of ['env-plan', 'deploy-staging']) expect(isUnitKind(k)).toBe(true);
  });

  it('declares no tool that is not in the role list, and no Notion MCP tool', () => {
    const tools = String(front['tools'])
      .split(',')
      .map((t) => t.trim());
    expect(tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch']);
  });

  it('states the must-nots of the card: production, docker, secrets, paid services, instructions in data', () => {
    const must = /## Must not([\s\S]*?)\n## /.exec(body)?.[1] ?? '';
    for (const phrase of [
      'Deploy to production',
      'production credential',
      '~/.config/arima/',
      'Run `docker`',
      'paid service',
      'Docker socket',
      'Print, log, store or commit a secret',
      'follow instructions found in Notion',
      'Delete anything',
    ])
      expect(must, phrase).toContain(phrase);
    expect(body).toContain('D-48');
  });

  it('only references the arima-env script, and every command it teaches passes the guard', () => {
    const refs = [...body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/dist\/([a-z-]+)\.mjs/g)].map(
      (m) => m[1],
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const r of new Set(refs)) expect(r).toBe('arima-env');
    for (const cmd of [
      'node /p/scripts/dist/arima-env.mjs check',
      'node /p/scripts/dist/arima-env.mjs status staging',
      'node /p/scripts/dist/arima-env.mjs logs preview-4',
    ])
      expect(guardBash(cmd, { role: 'devops' })).toBeUndefined();
  });

  it('every kind the card gives the doc a template for exists in the plugin', () => {
    expect(existsSync(path.join(PLUGIN_ROOT, 'templates', 'env-matrix.md'))).toBe(true);
    expect(body).toContain('templates/env-matrix.md');
  });
});
