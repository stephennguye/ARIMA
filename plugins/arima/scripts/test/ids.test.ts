import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, formatId, idsFile, nextId, readCounters } from '../src/ids.js';
import { runIdsCli } from '../src/cli/ids-cli.js';
import { PLUGIN_ROOT, buildBin, tempDir } from './helpers.js';

const pluginEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };

const run = promisify(execFile);

describe('formatId (spec §2 padding)', () => {
  it.each([
    ['REQ', 14, 'REQ-014'],
    ['NFR', 3, 'NFR-003'],
    ['EP', 4, 'EP-04'],
    ['US', 112, 'US-112'],
    ['TC', 231, 'TC-0231'],
    ['BUG', 45, 'BUG-045'],
    ['ADR', 7, 'ADR-0007'],
    ['RISK', 9, 'RISK-009'],
    ['DEC', 120, 'DEC-0120'],
    ['Q', 31, 'Q-031'],
    ['MS', 3, 'MS-03'],
    ['CR', 6, 'CR-006'],
    ['INC', 2, 'INC-002'],
    ['LES', 11, 'LES-011'],
  ] as const)('%s %i -> %s', (prefix, n, expected) => {
    expect(formatId(prefix, n)).toBe(expected);
  });

  it('grows past the minimum width instead of truncating', () => {
    expect(formatId('REQ', 1000)).toBe('REQ-1000');
  });

  it('covers every counter prefix in the spec', () => {
    expect([...ID_PREFIXES].sort()).toEqual(
      [
        'ADR',
        'BUG',
        'CR',
        'DEC',
        'EP',
        'INC',
        'LES',
        'MS',
        'NFR',
        'Q',
        'REQ',
        'RISK',
        'TC',
        'US',
      ].sort(),
    );
  });
});

describe('nextId', () => {
  it('issues sequential IDs per prefix independently', async () => {
    const dir = tempDir();
    expect(await nextId(dir, 'REQ')).toBe('REQ-001');
    expect(await nextId(dir, 'REQ')).toBe('REQ-002');
    expect(await nextId(dir, 'US')).toBe('US-001');
    expect(await nextId(dir, 'REQ')).toBe('REQ-003');
    expect(readCounters(dir)).toEqual({ REQ: 3, US: 1 });
  });

  it('rejects an unknown prefix without touching state', async () => {
    const dir = tempDir();
    await expect(nextId(dir, 'FOO')).rejects.toThrow(/Unknown ID prefix "FOO"/);
    await expect(nextId(dir, 'req')).rejects.toThrow(/Unknown ID prefix/);
    await expect(nextId(dir, 'G0')).rejects.toThrow(/Unknown ID prefix/);
    expect(existsSync(idsFile(dir))).toBe(false);
  });

  it('continues from existing state and never reuses an ID', async () => {
    const dir = tempDir();
    mkdirSync(path.dirname(idsFile(dir)), { recursive: true });
    writeFileSync(idsFile(dir), JSON.stringify({ schema_version: 1, counters: { DEC: 119 } }));
    expect(await nextId(dir, 'DEC')).toBe('DEC-0120');
  });

  it('refuses to reset a corrupt counter file (would risk reusing IDs)', async () => {
    const dir = tempDir();
    mkdirSync(path.dirname(idsFile(dir)), { recursive: true });
    writeFileSync(idsFile(dir), JSON.stringify({ schema_version: 1, counters: { REQ: -5 } }));
    await expect(nextId(dir, 'REQ')).rejects.toThrow(/Corrupt/);
    expect(JSON.parse(readFileSync(idsFile(dir), 'utf8')).counters.REQ).toBe(-5);
  });

  it('leaves no lock or temp file behind', async () => {
    const dir = tempDir();
    await nextId(dir, 'MS');
    expect(existsSync(`${idsFile(dir)}.lock`)).toBe(false);
  });

  it('issues unique, gap-free IDs under concurrent in-process calls', async () => {
    const dir = tempDir();
    const ids = await Promise.all(Array.from({ length: 40 }, () => nextId(dir, 'BUG')));
    expect(new Set(ids).size).toBe(40);
    expect([...ids].sort()).toEqual(Array.from({ length: 40 }, (_, i) => formatId('BUG', i + 1)));
  });
});

describe('arima-ids across processes', () => {
  it('issues unique, gap-free IDs from parallel processes', async () => {
    const bin = await buildBin('arima-ids');
    const dir = tempDir();
    const workers = 6;
    const perWorker = 6;
    const results = await Promise.all(
      Array.from({ length: workers }, async () => {
        const got: string[] = [];
        for (let i = 0; i < perWorker; i++) {
          const { stdout } = await run(process.execPath, [bin, 'next', 'US', '--project', dir], {
            env: pluginEnv,
          });
          got.push(stdout.trim());
        }
        return got;
      }),
    );
    const all = results.flat();
    const total = workers * perWorker;
    expect(new Set(all).size).toBe(total);
    expect([...all].sort()).toEqual(
      Array.from({ length: total }, (_, i) => formatId('US', i + 1)).sort(),
    );
    expect(readCounters(dir).US).toBe(total);
  }, 60_000);
});

describe('arima-ids CLI', () => {
  const cli = async (argv: string[], cwd: string) => {
    let out = '';
    let err = '';
    const code = await runIdsCli(argv, { out: (s) => (out += s), err: (s) => (err += s), cwd });
    return { code, out, err };
  };

  it('prints the next ID and exits 0', async () => {
    const dir = tempDir();
    const r = await cli(['next', 'REQ'], dir);
    expect(r).toMatchObject({ code: 0, out: 'REQ-001\n' });
  });

  it('exits 2 for an unknown prefix and for bad usage', async () => {
    const dir = tempDir();
    expect((await cli(['next', 'XYZ'], dir)).code).toBe(2);
    expect((await cli(['next'], dir)).code).toBe(2);
    expect((await cli([], dir)).code).toBe(2);
    expect((await cli(['next', 'REQ', '--nope'], dir)).code).toBe(2);
  });

  it('shows counters', async () => {
    const dir = tempDir();
    await cli(['next', 'TC'], dir);
    const r = await cli(['show'], dir);
    expect(r.out).toContain('TC\t1\tlast TC-0001');
  });
});
