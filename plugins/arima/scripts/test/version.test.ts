import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION, describeVersion } from '../src/version.js';

const manifest = JSON.parse(
  readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
) as { version: string };

describe('version', () => {
  it('is single-sourced from plugin.json', () => {
    expect(VERSION).toBe(manifest.version);
  });

  it('describes itself', () => {
    expect(describeVersion()).toBe(`arima ${manifest.version}`);
  });
});
