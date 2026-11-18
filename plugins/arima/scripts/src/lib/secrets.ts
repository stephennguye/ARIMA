/**
 * Detects strings that look like credentials, so they can never reach the event log, the ledger,
 * Notion or a commit (spec §11.3). Heuristic by design: it prefers false alarms to leaks.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'notion token', re: /\b(?:ntn_|secret_)[A-Za-z0-9]{20,}/ },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'google api key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'json web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
  {
    // key = "long random-looking value" for names that usually hold credentials
    name: 'credential assignment',
    re: /(?<![A-Za-z])(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token|passwd|password|private[_-]?key)["']?\s*[:=]\s*["']?[A-Za-z0-9/+_=.-]{20,}/i,
  },
];

/** Names of the secret kinds found in `text` (never the secret itself). */
export function findSecrets(text: string): string[] {
  // Text is often scanned after JSON.stringify, where a newline is the two characters \n. That
  // would glue a secret to the letter "n" and defeat word-boundary patterns, so scan a copy with
  // JSON escapes turned back into spaces as well.
  const unescaped = text.replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"');
  return SECRET_PATTERNS.filter((p) => p.re.test(text) || p.re.test(unescaped)).map((p) => p.name);
}

export function assertNoSecrets(text: string, where: string): void {
  const found = findSecrets(text);
  if (found.length > 0) {
    throw new Error(
      `Refusing to write ${where}: content looks like a secret (${found.join(', ')})`,
    );
  }
}
