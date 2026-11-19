import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARD_STOPS, isHardStop } from '../src/hardstops.js';
import { PLUGIN_ROOT, REPO_ROOT } from './helpers.js';

describe('canonical hard-stop ids (S2, D-42)', () => {
  it('are the sixteen of spec 11.1 plus missing_credential, with no duplicates', () => {
    expect(new Set(HARD_STOPS).size).toBe(HARD_STOPS.length);
    expect(HARD_STOPS).toHaveLength(16);
    expect(isHardStop('kill_switch')).toBe(true);
    expect(isHardStop('nope')).toBe(false);
  });
  it('the config schema accepts exactly these ids', () => {
    const schema = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, 'schemas', 'arima.schema.json'), 'utf8'),
    ) as {
      properties: { autonomy: { properties: { hard_stops: { items: { enum: string[] } } } } };
    };
    expect([...schema.properties.autonomy.properties.hard_stops.items.enum].sort()).toEqual(
      [...HARD_STOPS].sort(),
    );
  });
  it('every stop id the code records in hardstop.hit events is canonical', () => {
    for (const f of ['run-agent.ts']) {
      const text = readFileSync(path.join(REPO_ROOT, 'plugins/arima/scripts/src', f), 'utf8');
      for (const m of text.matchAll(/refuse\(\s*'([a-z_A-Z0-9]+)'/g))
        expect(isHardStop(m[1] as string), m[1]).toBe(true);
    }
  });
});
