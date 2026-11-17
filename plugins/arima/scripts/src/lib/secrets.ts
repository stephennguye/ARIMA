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
];

/** Names of the secret kinds found in `text` (never the secret itself). */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

export function assertNoSecrets(text: string, where: string): void {
  const found = findSecrets(text);
  if (found.length > 0) {
    throw new Error(
      `Refusing to write ${where}: content looks like a secret (${found.join(', ')})`,
    );
  }
}
