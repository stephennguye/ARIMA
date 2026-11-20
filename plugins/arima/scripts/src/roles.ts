import type { DbKey } from './notion/schema.js';
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

/** Top-level outbox files only (G-07); the sub-folders are written by `arima-notion push`. */
const OUTBOX = 'Write(./.arima/outbox/*.json)';

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
export function allowedTools(role: Role, scriptsDir: string, kind?: string): string[] {
  const read = ['Read', 'Glob', 'Grep'];
  // The agent files quote the path (`node "${CLAUDE_PLUGIN_ROOT}/..."`), which a rule matches only if it
  // is spelled the same way, so both spellings are granted (found by the devops real-agent evals).
  const nodeScript = (name: string, rest = ''): string[] => [
    ...bash(`node ${scriptsDir}/${name}.mjs${rest}`),
    ...bash(`node "${scriptsDir}/${name}.mjs"${rest}`),
  ];
  const script = (name: string): string[] => nodeScript(name);
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
    case 'tech-lead': {
      // A review reads a diff and writes nothing: the verdict and findings are in its report and the
      // host posts them (D-49). No outbox (proposals travel in the report) and no `npm`: a review does
      // not run the author's code, CI does (WP-212, judge rule "no role runs code from another role").
      const base = [...read, ...GIT_READ, 'WebFetch'];
      // Scoped grants for the kinds that edit a document (WP-212 acceptance; their agent sections are WP-312 and WP-219).
      if (kind === 'adr-review')
        return [
          ...base,
          'Edit(./docs/architecture/adr/**)',
          ...bash('git add'),
          ...bash('git commit'),
        ];
      if (kind === 'conventions')
        return [
          ...base,
          'Write(./docs/engineering/**)',
          'Edit(./docs/engineering/**)',
          ...bash('git add'),
          ...bash('git commit'),
        ];
      return base;
    }
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
        OUTBOX,
        ...GIT_READ,
        ...bash('git add'),
        ...bash('git commit'),
        // `npm test`, `npm run` and `npm ci` are not granted: they run code (a test runner config, a
        // --node-options require, a package script), and a devops run writes files (infra/**) that such
        // code could be pointed at (judge J-agent:devops, blocker 1). outdated, audit and sbom run none.
        ...bash('npm outdated'),
        ...bash('npm audit'),
        ...bash('npm sbom'),
        // No `docker` at all (WP-213): a container is started, stopped or inspected only through
        // arima-env, which knows staging and preview and nothing else. `docker inspect` on a
        // production container would read its environment, so the read-only Docker commands the
        // card listed are not granted. backup and restore-test are host jobs.
        ...nodeScript('arima-env', ' check'),
        // Only the read-side subcommands: the host runs `up` and `down` (judge blocker 2 and major 1: a
        // run that could `up` could deploy its own unreviewed files; `down` clears the failure record).
        ...['status', 'logs', 'smoke'].flatMap((sub) => [
          ...nodeScript('arima-env', ` ${sub} staging`),
          ...nodeScript('arima-env', ` ${sub} preview-*`),
        ]),
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
export function deniedTools(role?: Role, kind?: string): string[] {
  void kind;
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
    // D-49: no role pushes or runs gh. The host publish script pushes, opens PRs and posts comments.
    ...bash('git push'),
    ...bash('gh'),
    ...bash('gh pr merge'),
    ...bash('gh api'),
    ...bash('gh workflow run'),
    ...bash('gh release'),
    ...bash('gh secret'),
    ...bash('gh repo'),
    ...bash('gh auth'),
    // WP-213: host scripts, and Docker itself, are never an agent's (the guard repeats this).
    ...['arima-release', 'arima-merge', 'arima-publish', 'arima-worktree', 'arima-dispatch'].map(
      (n) => `Bash(node */${n}.mjs *)`,
    ),
    ...['docker', 'docker compose', 'docker-compose', 'podman', 'kubectl'].flatMap((c) => bash(c)),
    'Read(~/.config/arima/**)',
  ];
  if (role !== 'devops') out.push('Edit(./.github/**)', 'Write(./.github/**)');
  // QA's end-to-end tests are not the developer's to weaken (card decision 7, WP-210).
  if (role === 'developer')
    out.push('Edit(./tests/e2e/**)', 'Write(./tests/e2e/**)', 'MultiEdit(./tests/e2e/**)');
  return out;
}

/**
 * No role holds a GitHub token (D-49, G-05): the host reads pull requests, CI and review threads
 * into the run packet and posts each role's comments, and only the host publish and merge scripts
 * push, open PRs and merge. The scope of a role's GitHub credential is therefore always `none`.
 */
export const githubTokenScope = (): 'none' => 'none';

/** Roles that may hold a GitHub token: none (see `githubTokenScope`). */
export function mayHoldGithubToken(role: Role): boolean {
  void role;
  return githubTokenScope() !== 'none';
}

/** Only the orchestrator talks to Notion (spec principle 6, D-07). */
export function mayHoldNotionToken(role: Role): boolean {
  return role === 'orchestrator';
}

/**
 * Databases a role may write through the outbox (RD-F03-2, 09 section 1: tools match the whole job,
 * no more). Enforced at push; a violation is rejected with reason `database_not_allowed`. The
 * orchestrator may write every database (human-only fields stay refused). Never for a non-
 * orchestrator role: gates, digests, cost_log, milestones (releases only for devops).
 */
export const OUTBOX_DATABASES: Record<Role, readonly DbKey[]> = {
  orchestrator: [
    'gates',
    'requirements',
    'epics',
    'stories',
    'test_cases',
    'bugs',
    'milestones',
    'documents',
    'decisions',
    'questions',
    'meetings',
    'digests',
    'releases',
    'incidents',
    'change_requests',
    'risks',
    'lessons',
    'cost_log',
    'human_tasks',
  ],
  ba: ['requirements', 'epics', 'stories', 'documents', 'risks', 'questions', 'decisions'],
  ux: ['documents', 'stories', 'questions', 'decisions'],
  architect: ['documents', 'requirements', 'risks', 'questions', 'decisions'],
  'tech-lead': ['documents', 'risks', 'questions', 'decisions'],
  developer: ['stories', 'bugs', 'questions', 'decisions'],
  qa: ['test_cases', 'bugs', 'documents', 'questions', 'decisions'],
  security: ['risks', 'documents', 'questions', 'decisions'],
  devops: [
    'documents',
    'releases',
    'incidents',
    'bugs',
    'lessons',
    'risks',
    'human_tasks',
    'questions',
    'decisions',
  ],
};

/** Properties a role may not write even in a database it may write (priority is the PO's call). */
export const OUTBOX_FORBIDDEN_PROPERTIES: Partial<Record<Role, readonly string[]>> = {
  ba: ['Priority'],
  ux: ['Priority'],
};
