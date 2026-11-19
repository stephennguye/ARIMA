/**
 * Work-unit kinds (03-contracts 3.1). The list is the `kind` enum of work-unit.schema.json and the
 * list in the contract; contracts.test.ts keeps all three equal. Add a kind to the contract first.
 */
export const UNIT_KINDS = [
  'develop',
  'skeleton',
  'review',
  'adr-review',
  'conventions',
  'rc-freeze',
  'deprecation-check',
  'debt-review',
  'qa',
  'test-write',
  'e2e-skeleton',
  'regression',
  'perf-test',
  'a11y-test',
  'design-qa',
  'author',
  'release-docs',
  'env-plan',
  'preview-diagnose',
  'security-scan',
  'scan-triage',
  'verify-finding',
  'screen',
  'deploy-staging',
  'hotfix',
  'fix',
  'triage',
  'runbook',
  'uat-script',
  'digest',
  'meeting',
  'gate-pack',
  'retro',
] as const;

export type UnitKind = (typeof UNIT_KINDS)[number];

export const isUnitKind = (value: string): value is UnitKind =>
  (UNIT_KINDS as readonly string[]).includes(value);
