import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Detects strings that look like credentials, so they can never reach the event log, the ledger,
 * Notion or a commit (spec §11.3). Heuristic by design: it prefers false alarms to leaks, and a
 * human can mark a reviewed false alarm as allowed (see `fingerprint`).
 */
interface Pattern {
  name: string;
  re: RegExp;
  /** Extra test on the matched text; a match that fails it is not reported (cuts false alarms). */
  accept?: (match: string, groups: string[]) => boolean;
}

/** Shannon entropy in bits per character: random keys score high, prose and placeholders low. */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER =
  /example|placeholder|your[-_]|replace|change[-_]?me|dummy|sample|redacted|xxxx|\*\*\*|<[^>]+>/i;
const looksRandom = (s: string, bits: number): boolean =>
  s.length >= 16 &&
  /[0-9]/.test(s) &&
  /[A-Za-z]/.test(s) &&
  entropy(s) >= bits &&
  !PLACEHOLDER.test(s);

const PATTERNS: Pattern[] = [
  { name: 'notion token', re: /\b(?:ntn_|secret_)[A-Za-z0-9]{20,}/g },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'github fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  {
    name: 'anthropic key',
    re: /\bsk-ant-([A-Za-z0-9_-]{20,})/g,
    accept: (_m, g) => looksRandom(g[0] ?? '', 3.4),
  },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/g, accept: (m) => !/EXAMPLE/.test(m) },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'google api key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: 'json web token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    name: 'bearer token',
    re: /\bBearer\s+([A-Za-z0-9._~+/-]{24,})=*/g,
    accept: (_m, g) => !PLACEHOLDER.test(g[0] ?? '') && entropy(g[0] ?? '') >= 3.3,
  },
  {
    // key = "long random-looking value" for names that usually hold credentials
    name: 'credential assignment',
    re: /(?<![A-Za-z])(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token|passwd|password|private[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9/+_=.-]{20,})/gi,
    accept: (_m, g) => looksRandom(g[0] ?? '', 3.5),
  },
];

export interface SecretFinding {
  /** Kind of secret, e.g. "github token". Never the secret itself. */
  rule: string;
  /** Short stable id of the matched text (sha-256 prefix) so a reviewed false alarm can be allowed. */
  fingerprint: string;
}

export function fingerprint(match: string): string {
  return `sha256:${createHash('sha256').update(match).digest('hex').slice(0, 16)}`;
}

function scan(text: string): SecretFinding[] {
  // Text is often scanned after JSON.stringify, where a newline is the two characters \n. That
  // would glue a secret to the letter "n" and defeat word-boundary patterns, so scan a copy with
  // JSON escapes turned back into spaces as well.
  const unescaped = text.replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"');
  const out: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    for (const t of text === unescaped ? [text] : [text, unescaped]) {
      for (const m of t.matchAll(new RegExp(p.re.source, p.re.flags))) {
        const groups = m.slice(1).map((x) => x ?? '');
        if (p.accept && !p.accept(m[0], groups)) continue;
        const f = fingerprint(m[0]);
        if (seen.has(`${p.name}|${f}`)) continue;
        seen.add(`${p.name}|${f}`);
        out.push({ rule: p.name, fingerprint: f });
      }
    }
  }
  return out;
}

/** Findings in `text`, minus any whose fingerprint a human has allowed. */
export function scanSecrets(
  text: string,
  allowed: ReadonlySet<string> = new Set(),
): SecretFinding[] {
  return scan(text).filter((f) => !allowed.has(f.fingerprint));
}

/** Names of the secret kinds found in `text` (never the secret itself). */
export function findSecrets(text: string, allowed: ReadonlySet<string> = new Set()): string[] {
  return [...new Set(scanSecrets(text, allowed).map((f) => f.rule))];
}

export function assertNoSecrets(text: string, where: string): void {
  const found = findSecrets(text);
  if (found.length > 0) {
    throw new Error(
      `Refusing to write ${where}: content looks like a secret (${found.join(', ')})`,
    );
  }
}

/**
 * The one place the secret allow-list is read (G-09): state push, outbox and init all call this.
 * A missing file is an empty list. Only a human writes `.arima/secret-allowlist.txt`.
 */
export function readAllowlistFile(file: string): Set<string> {
  return existsSync(file) ? parseAllowlist(readFileSync(file, 'utf8')) : new Set<string>();
}

/** The allow-list of a project (`<project>/.arima/secret-allowlist.txt`). */
export function loadSecretAllowlist(projectDir: string): Set<string> {
  return readAllowlistFile(path.join(projectDir, '.arima', 'secret-allowlist.txt'));
}

/** Parses an allowlist file: one `sha256:<16 hex>` per line, `#` comments allowed. */
export function parseAllowlist(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(sha256:[0-9a-f]{16})\s*(?:#.*)?$/i.exec(line);
    if (m) out.add((m[1] as string).toLowerCase());
  }
  return out;
}
