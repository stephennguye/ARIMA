/**
 * The canonical hard-stop ids (spec section 11.1, owner decision D-42 / S2). They are fixed in
 * code and cannot be switched off by configuration. `autonomy.hard_stops` in arima.yaml is
 * documentation only; the validator warns when it differs from this list.
 */
export const HARD_STOPS = [
  'G0',
  'G1',
  'G2',
  'G3',
  'G4',
  'prod_deploy',
  'secrets_change',
  'budget_exceeded',
  'story_budget',
  'notion_delete',
  'prod_data_migration',
  'new_paid_service',
  'licence',
  'critical_finding',
  'kill_switch',
  'missing_credential',
] as const;

export type HardStopId = (typeof HARD_STOPS)[number];

export const isHardStop = (id: string): id is HardStopId =>
  (HARD_STOPS as readonly string[]).includes(id);
