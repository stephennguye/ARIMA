// Judge #4 fixes: scrubber, transient classification, catalog/profile agreement both ways,
// template sections from spec 8.2, gate template drift, blind kill switch at dispatch.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { headingsOf, loadCatalog } from '../src/catalog.js';
import { isTransient } from '../src/lib/throttle.js';
import { checkKillSwitch } from '../src/killswitch.js';
import { loadAllProfiles } from '../src/profiles.js';
import { DispatchRefused, runAgent } from '../src/run-agent.js';
import { scrub } from '../test-live/scrub.js';
import { PLUGIN_ROOT, tempDir } from './helpers.js';
import { FakeNotion } from './fake-notion.js';
import { Throttle } from '../src/lib/throttle.js';
import { createNotionPort } from '../src/notion/port.js';
import { setNotionSwitch } from '../src/killswitch.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'notion-real');
const tpl = (f: string): string => readFileSync(path.join(PLUGIN_ROOT, 'templates', f), 'utf8');

describe('fixture scrubber', () => {
  it('replaces ids, names, e-mails, urls and the workspace name', () => {
    const out = scrub({
      id: '41c0c75b-b8d0-8043-906d-e5edb3a55d41',
      url: 'https://www.notion.so/Secret-Page-41c0c75bb8d08043906de5edb3a55d41',
      bot: { workspace_name: "Someone's Notion", owner: { type: 'user' } },
      user: {
        object: 'user',
        type: 'person',
        name: 'Real Person',
        person: { email: 'r@real.com' },
      },
    });
    const text = JSON.stringify(out);
    for (const leak of ['41c0c75b', 'Secret-Page', "Someone's", 'Real Person', 'r@real.com'])
      expect(text).not.toContain(leak);
  });
  it('every committed fixture holds only placeholders', () => {
    for (const f of readdirSync(FIX)) {
      const text = readFileSync(path.join(FIX, f), 'utf8');
      const uuids =
        text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
      for (const u of uuids)
        expect(u, `${f} has a real-looking id`).toMatch(/^00000000-0000-4000-8000-/);
      for (const e of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [])
        expect(e, f).toBe('test@example.com');
      expect(text, f).not.toMatch(/workspace_name": "(?!Test Workspace)/);
    }
  });
});

describe('transient classification (reads only)', () => {
  it.each([
    [{ code: 'ECONNRESET' }, true],
    [{ status: 503 }, true],
    [
      { code: 'notionhq_client_request_timeout', message: 'Request to Notion API has timed out' },
      true,
    ],
    [{ status: 400 }, false],
    [{ status: 401 }, false],
    [{ status: 404 }, false],
    [{ status: 403, message: 'forbidden' }, false],
  ])('%j -> %s', (e, want) => {
    expect(
      isTransient(Object.assign(new Error((e as { message?: string }).message ?? 'x'), e)),
    ).toBe(want);
  });
});

describe('catalog and profiles agree in both directions', () => {
  it('a profile requires exactly the artifacts the catalog flags for it (minus conditional and human-only)', () => {
    const cat = loadCatalog();
    const key = {
      'solo-lite': 'solo_lite',
      'client-project': 'client_project',
      regulated: 'regulated',
    } as const;
    for (const p of loadAllProfiles()) {
      const flagged = cat
        .filter((a) => a.required[key[p.name]])
        .map((a) => a.id)
        .filter((id) => !(id in p.artifacts.conditional) && !p.artifacts.human_only.includes(id))
        .sort();
      expect(flagged, p.name).toEqual([...p.artifacts.required].sort());
    }
  });
});

describe('spec 8.2 templates are validated', () => {
  it('every artifact with a template and sections has them as H2 headings (spec 8.2 set included)', () => {
    const cat = loadCatalog();
    for (const id of [
      'backlog',
      'adrs',
      'bug-reports',
      'meeting-minutes',
      'incidents',
      'change-requests',
      'digest',
    ]) {
      const a = cat.find((x) => x.id === id)!;
      expect(a.sections?.length, id).toBeGreaterThan(0);
      const have = new Set(headingsOf(tpl(a.template as string)));
      expect(
        (a.sections ?? []).filter((s) => !have.has(s.toLowerCase())),
        id,
      ).toEqual([]);
    }
  });
  it('the two gate templates have the same sections, so they cannot drift', () => {
    expect(headingsOf(tpl('gate-page.md'))).toEqual(headingsOf(tpl('gate-evidence-pack.md')));
  });
});

describe('blind kill switch at dispatch', () => {
  it('refuses to dispatch (exit 12) when Notion is down and the state branch cannot be read', async () => {
    const f = new FakeNotion();
    const port = createNotionPort(f.client, new Throttle(0), { sleep: () => Promise.resolve() });
    await setNotionSwitch(port, f.rootId, false);
    f.down = true;
    const ks = await checkKillSwitch(tempDir(), { port, rootPageId: f.rootId }, () =>
      Promise.resolve(undefined),
    );
    expect(ks.on).toBe(true);
    const dir = tempDir();
    const prompt = path.join(dir, 'p.md');
    writeFileSync(prompt, 'x');
    await expect(
      runAgent({
        projectDir: dir,
        role: 'developer',
        item: 'US-1',
        budgetUsd: 1,
        maxTurns: 3,
        promptFile: prompt,
        phase: 4,
        config: {
          projectKey: 'T',
          perRunCap: 2,
          maxRunMinutes: 1,
          notionTokenEnv: 'X',
          projectCap: 100,
          dailyCap: 20,
        },
        killSwitch: {
          notion: { port, rootPageId: f.rootId },
          remotePause: () => Promise.resolve(undefined),
        },
      }),
    ).rejects.toBeInstanceOf(DispatchRefused);
  });
});
