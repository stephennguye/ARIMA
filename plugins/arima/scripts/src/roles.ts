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

/** `Bash(cmd)` and `Bash(cmd *)`, so a command with and without arguments both match. */
const bash = (cmd: string): string[] => [`Bash(${cmd})`, `Bash(${cmd} *)`];

/** Read-only git. No push, no config, no reset: those are never granted to a role by pattern. */
const GIT_READ = [
  ...bash('git status'),
  ...bash('git diff'),
  ...bash('git log'),
  ...bash('git show'),
  ...bash('git rev-parse'),
  ...bash('git ls-files'),
  ...bash('git branch --list'),
  ...bash('git fetch'),
];

/** Read-only GitHub CLI. There is deliberately no `gh pr merge`, `gh api`, `gh workflow run`. */
const GH_READ = [
  ...bash('gh pr view'),
  ...bash('gh pr list'),
  ...bash('gh pr diff'),
  ...bash('gh pr checks'),
  ...bash('gh run list'),
  ...bash('gh run view'),
];

/** Running the app's own tests. No `npx` (it downloads and runs arbitrary packages). */
const NPM_TEST = [...bash('npm test'), ...bash('npm run'), ...bash('npm ci')];

/**
 * Per-role tool allow-list for headless runs (spec §5 "Tools", §11.2 permissions matrix).
 * Rules use Claude Code permission syntax. Anything not listed is denied (dontAsk mode).
 * `scriptsDir` is the plugin's scripts/dist directory. A role may run only the named ARIMA scripts
 * through `node`, never the whole directory: `arima-pause` (the kill switch) and `arima-init` are
 * never granted to a role.
 *
 * Merging and pushing to the default branch are not here on purpose: they belong to one merge
 * script (v0.2, step 1.7) and the guard hook blocks them for every agent.
 */
export function allowedTools(role: Role, scriptsDir: string): string[] {
  const read = ['Read', 'Glob', 'Grep'];
  const script = (name: string): string[] => bash(`node ${scriptsDir}/${name}.mjs`);
  switch (role) {
    case 'orchestrator':
      return [
        ...read,
        // G-06: events, ledger, mirror, runs, items and findings are written by scripts only.
        OUTBOX,
        'Write(./.arima/overrides/**)',
        'Edit(./.arima/overrides/**)',
        'Write(./docs/spec/**)',
        'Edit(./docs/spec/**)',
        ...GIT_READ,
        ...GH_READ,
        ...[
          'arima-config',
          'arima-preflight',
          'arima-ids',
          'arima-notion',
          'arima-state',
          'arima-status',
        ].flatMap(script),
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
        ...GIT_READ,
        ...GH_READ,
        ...bash('gh pr review'),
        ...bash('gh pr comment'),
        ...NPM_TEST,
        'WebFetch',
      ];
    case 'developer':
      return [
        ...read,
        'Edit',
        'Write',
        ...GIT_READ,
        ...bash('git add'),
        ...bash('git commit'),
        ...bash('git switch'),
        ...bash('git checkout'),
        // The guard hook limits pushes to the story's own branch; the default branch is blocked.
        ...bash('git push'),
        ...bash('gh pr create'),
        ...bash('gh pr view'),
        ...NPM_TEST,
        'WebFetch',
      ];
    case 'qa':
      return [
        ...read,
        'Write(./tests/**)',
        'Edit(./tests/**)',
        OUTBOX,
        ...NPM_TEST,
        ...bash('npx playwright'),
        'mcp__playwright__*',
      ];
    case 'security':
      return [...read, OUTBOX, ...GIT_READ, ...bash('npm audit'), 'WebFetch'];
    case 'devops':
      return [
        ...read,
        'Write(./infra/**)',
        'Edit(./infra/**)',
        'Write(./.github/**)',
        'Edit(./.github/**)',
        'Write(./docs/ops/**)',
        'Edit(./docs/ops/**)',
        ...GIT_READ,
        ...bash('git add'),
        ...bash('git commit'),
        ...bash('git push'),
        ...GH_READ,
        ...bash('gh workflow list'),
        ...bash('gh workflow view'),
        'WebFetch',
      ];
  }
}

/**
 * Denied for the role even if an allow rule would match. No Notion MCP at all (ADR-0003), no
 * secret-bearing files (spec §11.3), no editing of the files that decide who may approve or what
 * the hooks do, and none of the GitHub commands that merge, publish or change settings. The guard
 * hook repeats these as a second layer because rule matching is only as good as its patterns.
 */
export function deniedTools(role?: Role): string[] {
  const out = [
    'mcp__*notion*',
    'Read(./.env)',
    'Read(./.env.*)',
    'Read(**/*.pem)',
    'Read(**/*.key)',
    'Edit(./.env*)',
    'Write(./.env*)',
    'Edit(./arima.yaml)',
    'Write(./arima.yaml)',
    'Edit(./team.yaml)',
    'Write(./team.yaml)',
    'Edit(./.claude/**)',
    'Write(./.claude/**)',
    'Edit(./.githooks/**)',
    'Write(./.githooks/**)',
    'Edit(./.arima/PAUSE)',
    'Write(./.arima/PAUSE)',
    'Edit(./.arima/run.lock)',
    'Write(./.arima/run.lock)',
    ...bash('gh pr merge'),
    ...bash('gh api'),
    ...bash('gh workflow run'),
    ...bash('gh release'),
    ...bash('gh secret'),
    ...bash('gh repo'),
    ...bash('gh auth'),
  ];
  if (role !== 'devops') out.push('Edit(./.github/**)', 'Write(./.github/**)');
  return out;
}

/** Roles that may hold the machine-account GitHub token (spec §10.3, §11.3). */
export function mayHoldGithubToken(role: Role): boolean {
  return role === 'developer' || role === 'tech-lead' || role === 'devops';
}

/** Only the orchestrator talks to Notion (spec principle 6, D-07). */
export function mayHoldNotionToken(role: Role): boolean {
  return role === 'orchestrator';
}
