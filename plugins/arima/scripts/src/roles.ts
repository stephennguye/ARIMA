import type { Role } from './ledger.js';

export const ROLES: readonly Role[] = [
  'orchestrator',
  'ba',
  'ux',
  'architect',
  'tech-lead',
  'developer',
  'qa',
  'security',
  'devops',
];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Role name as used in arima.yaml (models.by_role) and team.yaml. */
export function configKey(role: Role): string {
  return role.replace('-', '_');
}

const OUTBOX = 'Write(./.arima/outbox/**)';

/**
 * Per-role tool allow-list for headless runs (spec §5 "Tools", §11.2 permissions matrix).
 * Rules use Claude Code permission syntax. Anything not listed is denied (dontAsk mode).
 * `scriptsGlob` is the plugin's dist directory, so a role may run ARIMA scripts and nothing else
 * through `node`.
 */
export function allowedTools(role: Role, scriptsGlob: string): string[] {
  const read = ['Read', 'Glob', 'Grep'];
  const arimaScripts = `Bash(node ${scriptsGlob}/*)`;
  switch (role) {
    case 'orchestrator':
      return [
        ...read,
        'Write(./.arima/**)',
        'Edit(./.arima/**)',
        'Write(./docs/spec/**)',
        'Edit(./docs/spec/**)',
        'Bash(git *)',
        'Bash(gh pr view *)',
        'Bash(gh pr list *)',
        'Bash(gh run list *)',
        'Bash(gh run view *)',
        arimaScripts,
        'WebFetch',
      ];
    case 'ba':
      return [
        ...read,
        'Write(./docs/spec/drafts/**)',
        'Edit(./docs/spec/drafts/**)',
        OUTBOX,
        'WebFetch',
      ];
    case 'ux':
      return [
        ...read,
        'Write(./design/**)',
        'Edit(./design/**)',
        OUTBOX,
        'Bash(npx serve *)',
        'mcp__playwright__*',
        'WebFetch',
      ];
    case 'architect':
      return [
        ...read,
        'Write(./docs/architecture/**)',
        'Edit(./docs/architecture/**)',
        'Write(./api/**)',
        'Edit(./api/**)',
        OUTBOX,
        'WebFetch',
      ];
    case 'tech-lead':
      return [
        ...read,
        OUTBOX,
        'Bash(git *)',
        'Bash(gh pr *)',
        'Bash(npm *)',
        'Bash(npx *)',
        'WebFetch',
      ];
    case 'developer':
      return [
        ...read,
        'Edit',
        'Write',
        'Bash(git *)',
        'Bash(gh pr create *)',
        'Bash(gh pr view *)',
        'Bash(npm *)',
        'Bash(npx *)',
        'WebFetch',
      ];
    case 'qa':
      return [
        ...read,
        'Write(./tests/**)',
        'Edit(./tests/**)',
        OUTBOX,
        'Bash(npm *)',
        'Bash(npx *)',
        'mcp__playwright__*',
      ];
    case 'security':
      return [...read, OUTBOX, 'Bash(git *)', 'Bash(npm audit *)', 'Bash(npx *)', 'WebFetch'];
    case 'devops':
      return [
        ...read,
        'Write(./infra/**)',
        'Edit(./infra/**)',
        'Write(./.github/**)',
        'Edit(./.github/**)',
        'Write(./docs/ops/**)',
        'Edit(./docs/ops/**)',
        'Bash(git *)',
        'Bash(gh *)',
        'WebFetch',
      ];
  }
}

/**
 * Denied for every role. No Notion MCP at all (ADR-0003: Notion goes through ARIMA scripts), and
 * no reading or writing secret-bearing files (spec §11.3; the T-13 hook is the second layer).
 */
export function deniedTools(): string[] {
  return [
    'mcp__*notion*',
    'Read(./.env)',
    'Read(./.env.*)',
    'Read(**/*.pem)',
    'Read(**/*.key)',
    'Edit(./.env*)',
    'Write(./.env*)',
  ];
}

/** Roles that may hold the machine-account GitHub token (spec §10.3, §11.3). */
export function mayHoldGithubToken(role: Role): boolean {
  return role === 'developer' || role === 'tech-lead' || role === 'devops';
}

/** Only the orchestrator talks to Notion (spec principle 6, D-07). */
export function mayHoldNotionToken(role: Role): boolean {
  return role === 'orchestrator';
}
