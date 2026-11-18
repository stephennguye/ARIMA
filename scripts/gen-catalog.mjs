// One-off generator (re-runnable): spec section 8.1 table -> plugins/arima/catalog/artifacts.yaml,
// plus DRAFT templates for document artifacts that have none. Templates are drafted by the builder for
// the owner's later review; the catalog file is the source of truth after this runs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const spec = readFileSync(path.join(root, 'docs/spec/ARIMA-Master-Spec.md'), 'utf8');
const a = spec.indexOf('### 8.1 Catalog');
const b = spec.indexOf('### 8.2');
const rows = spec
  .slice(a, b)
  .split('\n')
  .filter((l) => l.startsWith('|'))
  .slice(2)
  .map((l) =>
    l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim()),
  );

const SLUGS =
  `project-brief charter budget-plan feasibility-note compliance-screen sow risk-register prd urs srs nfr glossary
personas-journeys-sitemap wireframes security-requirements dpia backlog requirement-review-log sad adrs openapi data-model
infra-diagram prototype threat-model master-test-plan env-matrix milestone-plan dor-dod conventions test-cases code-tests
pull-requests bug-reports milestone-review digest decision-log questions meeting-minutes lessons test-reports security-report
pentest-report uat go-no-go-minutes runbook-rollback release-record user-guide-faq support-kb hypercare-closure ops-manual
incidents change-requests slo-cost-reports sbom rtm changelog ledger-events`.split(/\s+/);
if (SLUGS.length !== rows.length) throw new Error(`slugs ${SLUGS.length} vs rows ${rows.length}`);

// Existing templates (spec 8.2) and the sections the spec requires of them.
const EXISTING = {
  'project-brief': [
    'project-brief.md',
    [
      'Problem',
      'Target users',
      'Goals and KPIs',
      'Must-have features',
      'Out of scope',
      'Constraints',
      'Known risks',
    ],
  ],
  prd: [
    'prd.md',
    [
      'Summary',
      'Problem',
      'Users and personas',
      'Goals and KPIs',
      'Scope',
      'Feature list',
      'Assumptions',
      'Dependencies',
      'Release criteria',
      'Open questions',
    ],
  ],
  backlog: ['user-story.md', null],
  adrs: ['adr.md', null],
  'bug-reports': ['bug.md', null],
  'meeting-minutes': ['meeting-minutes.md', null],
  incidents: ['postmortem.md', null],
  'change-requests': ['change-request.md', null],
  digest: ['digest.md', null],
};
// Artifacts that are records, generated, code or external: no document template.
const NOT_DOC = {
  sow: 'external',
  'risk-register': 'record',
  nfr: 'record',
  backlog: 'record',
  'requirement-review-log': 'record',
  openapi: 'code',
  'milestone-plan': 'record',
  'test-cases': 'record',
  'code-tests': 'code',
  'pull-requests': 'code',
  'bug-reports': 'record',
  'milestone-review': 'record',
  digest: 'record',
  'decision-log': 'record',
  questions: 'record',
  'meeting-minutes': 'record',
  lessons: 'record',
  uat: 'record',
  'go-no-go-minutes': 'record',
  'release-record': 'record',
  incidents: 'record',
  'change-requests': 'record',
  sbom: 'generated',
  rtm: 'generated',
  changelog: 'generated',
  'ledger-events': 'generated',
  adrs: 'code',
  wireframes: 'code',
};
const SECTIONS = {
  charter: [
    'Purpose and scope',
    'Objectives and success measures',
    'Stakeholders and approvers',
    'Milestones and budget summary',
    'Constraints and assumptions',
    'Risks',
    'Approval',
  ],
  'budget-plan': ['Budget summary', 'Allocation by phase', 'Caps and alerts', 'Assumptions'],
  'feasibility-note': [
    'Question',
    'Options',
    'Technical feasibility',
    'Cost and schedule estimate',
    'Risks',
    'Recommendation',
  ],
  'compliance-screen': [
    'Data handled',
    'Applicable regulations',
    'Findings',
    'Required controls',
    'Open questions for legal',
  ],
  urs: ['Business needs', 'User requirements', 'Priorities', 'Out of scope', 'Open questions'],
  srs: [
    'Functional requirements',
    'Non-functional requirements',
    'External interfaces',
    'Constraints',
    'Traceability to requirements',
  ],
  glossary: ['Terms and definitions', 'Abbreviations'],
  'personas-journeys-sitemap': ['Personas', 'Journeys', 'Sitemap', 'Open questions'],
  'security-requirements': [
    'Assets',
    'Requirements',
    'Authentication and authorisation',
    'Data protection',
    'Logging and monitoring',
  ],
  dpia: [
    'Processing description',
    'Necessity and proportionality',
    'Risks to people',
    'Mitigations',
    'Outcome and sign-off',
  ],
  sad: [
    'Context and goals',
    'Architecture overview',
    'Components',
    'Data and integrations',
    'Quality attributes',
    'Deployment',
    'Decisions',
    'Risks',
  ],
  'data-model': ['Entities', 'Relationships', 'Constraints', 'Migrations'],
  'infra-diagram': ['Diagram', 'Hosting choices', 'Cost estimate', 'Assumptions'],
  prototype: ['Scope', 'Design tokens', 'Screens', 'Interaction notes'],
  'threat-model': ['Assets', 'Trust boundaries', 'Threats', 'Mitigations', 'Residual risk'],
  'master-test-plan': [
    'Scope',
    'Strategy',
    'Environments',
    'Entry and exit criteria',
    'Test types and tools',
    'Risks',
    'Schedule',
  ],
  'env-matrix': ['Environments', 'Configuration', 'Access', 'Pipeline design'],
  'dor-dod': ['Definition of Ready', 'Definition of Done'],
  conventions: ['Code style', 'Branching and commits', 'Review rules', 'Testing rules'],
  'test-reports': ['Scope', 'Results summary', 'Failures and defects', 'Coverage', 'Sign-off'],
  'security-report': ['Scope', 'Findings by severity', 'Fixed and open', 'Recommendation'],
  'pentest-report': ['Scope', 'Method', 'Findings', 'Retest'],
  'runbook-rollback': [
    'Service overview',
    'Deploy steps',
    'Rollback steps',
    'Health checks',
    'Contacts',
  ],
  'user-guide-faq': ['Getting started', 'Common tasks', 'FAQ', 'Getting help'],
  'support-kb': ['Common issues', 'Escalation matrix', 'Contacts'],
  'hypercare-closure': [
    'Period and scope',
    'Incidents',
    'SLO results',
    'Open items',
    'Closure statement',
  ],
  'ops-manual': [
    'Architecture summary',
    'Monitoring and alerts',
    'Routine tasks',
    'Incident handling',
    'Backups',
  ],
  'slo-cost-reports': ['Period', 'SLO results', 'Cost', 'Actions'],
};

const flags = (s) => ({
  solo_lite: /\bS\b/.test(s),
  client_project: /\bC\b/.test(s),
  regulated: /\bR\b/.test(s),
});
const artifacts = rows.map((r, i) => {
  const slug = SLUGS[i];
  const kind = NOT_DOC[slug] ?? 'document';
  const existing = EXISTING[slug];
  const template = existing ? existing[0] : kind === 'document' ? `${slug}.md` : null;
  const sections = existing?.[1] ?? SECTIONS[slug] ?? null;
  return {
    id: slug,
    name: r[0],
    phase: r[1],
    owner: r[2],
    approver: r[3],
    master: r[4],
    consumers: r[5],
    required_in: r[6],
    required: flags(r[6]),
    kind,
    template,
    ...(sections ? { sections } : {}),
  };
});

const dir = path.join(root, 'plugins/arima/catalog');
mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(dir, 'artifacts.yaml'),
  `# ARIMA artifact catalog (spec section 8.1), 58 artifacts. Source of truth for ids, owners, master locations,\n# which profiles require each artifact and which template (if any) it uses. Generated once from the spec by\n# scripts/gen-catalog.mjs; edit this file from now on. Templates marked DRAFT are awaiting the owner's review.\n${stringify({ schema_version: 1, artifacts })}`,
);

let made = 0;
for (const x of artifacts) {
  if (!x.template || EXISTING[x.id] || !x.sections) continue;
  const file = path.join(root, 'plugins/arima/templates', x.template);
  if (existsSync(file)) continue;
  const body = [
    `# ${x.name}`,
    '',
    `<!-- arima-template: ${x.id}; DRAFT for the owner's review. The H2 headings below are the required sections. Owner: ${x.owner}. Master location: ${x.master}. -->`,
    '',
    ...x.sections.flatMap((s) => [
      `## ${s}`,
      '',
      '_Fill in. Cite sources (file:line or item id); mark guesses as guesses._',
      '',
    ]),
  ].join('\n');
  writeFileSync(file, body);
  made++;
}
console.log(`catalog: ${artifacts.length} artifacts; new draft templates: ${made}`);
