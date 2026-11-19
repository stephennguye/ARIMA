/**
 * Reason codes (03-contracts 9b): one list for ledger rows, events and reports. A run result is
 * one of pass, fail, error, paused, blocked; the reason code explains fail, blocked and paused.
 * New codes are added to the contract first; contracts.test.ts keeps the list and the schemas equal.
 */
export const REASON_CODES = [
  'report_invalid',
  'report_missing',
  'evidence_missing',
  'secret_in_output',
  'protected_path',
  'template_invalid',
  'cap_turns',
  'cap_budget',
  'usage_limit',
  'kill_switch',
  'budget_exhausted',
  'story_budget',
  'credential_missing',
  'notion_deferred',
  'notion_conflict',
  'notion_refused',
  'state_not_saved',
  'merge_refused_ci',
  'merge_refused_qa',
  'merge_refused_review',
  'guard_blocked',
  'unknown_kill_switch',
  'database_not_allowed',
  'phase_refused',
  'remote_unchecked',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const isReasonCode = (value: string): value is ReasonCode =>
  (REASON_CODES as readonly string[]).includes(value);
