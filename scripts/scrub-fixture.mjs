// Scrubs a recorded `claude -p --output-format json` result before it is committed as a fixture
// (WP-191). Keeps the shape and the numbers (cost, tokens, turns, durations, subtype); replaces
// anything that identifies a person, a machine or a session: session ids and other UUIDs, absolute
// paths, user and host names, e-mail addresses, and anything that looks like a credential.
//   node scripts/scrub-fixture.mjs <in.json> [<out.json>]      (prints to stdout without <out>)
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WIN_PATH = /\b[A-Za-z]:[\\/](?:[^\s"'<>|:*?]+[\\/]?)+/g;
const POSIX_PATH = /(?<![\w.])\/(?:Users|home|tmp|var|mnt|opt|root|private)\/[^\s"'<>]+/g;
const TOKEN = /\b(?:ntn_|secret_|ghp_|gho_|github_pat_|sk-ant-|AKIA|xox[baprs]-)[A-Za-z0-9_-]{8,}/g;
const KEYS_TO_PLACEHOLDER = new Set(['session_id', 'uuid', 'parent_tool_use_id', 'request_id']);

export function scrubString(s, names = defaultNames()) {
  let out = s
    .replace(UUID, '00000000-0000-4000-8000-000000000000')
    .replace(EMAIL, 'user@example.invalid')
    .replace(TOKEN, '<token>')
    .replace(WIN_PATH, '<path>')
    .replace(POSIX_PATH, '<path>');
  for (const n of names)
    if (n.length >= 3)
      out = out.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<name>');
  return out;
}

function defaultNames() {
  const n = new Set();
  try {
    n.add(userInfo().username);
  } catch {
    /* no user info */
  }
  n.add(hostname());
  const home = homedir().split(/[\\/]/).pop();
  if (home) n.add(home);
  return [...n].filter(Boolean);
}

/** Scrubs every string in a JSON value; ids under known keys become a fixed placeholder. */
export function scrub(value, names = defaultNames()) {
  if (typeof value === 'string') return scrubString(value, names);
  if (Array.isArray(value)) return value.map((v) => scrub(v, names));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        KEYS_TO_PLACEHOLDER.has(k) && typeof v === 'string'
          ? '00000000-0000-4000-8000-000000000000'
          : scrub(v, names),
      ]),
    );
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: node scripts/scrub-fixture.mjs <in.json> [<out.json>]');
    process.exit(2);
  }
  const text = `${JSON.stringify(scrub(JSON.parse(readFileSync(input, 'utf8'))), null, 2)}\n`;
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);
}
