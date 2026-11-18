import type { GateId } from './profiles.js';

/** Phase each gate closes (spec §6). */
export const GATE_PHASE: Record<GateId, number> = { G0: 0, G1: 1, G2: 2, G3: 5, G4: 7 };

/** What a gate's evidence pack must show (spec §6.0-6.7 exit criteria). */
export const GATE_CRITERIA: Record<GateId, string[]> = {
  G0: [
    'Brief complete (checked against the brief template)',
    'Charter',
    'Feasibility note',
    'Compliance screen',
    'Budget plan',
  ],
  G1: [
    'Every Must requirement has at least one story',
    'Every story in the first milestone meets the Definition of Ready',
    'No open blocking questions',
    'All non-functional requirements are measurable',
    'DPIA signed by Legal, if required',
  ],
  G2: [
    'Every NFR has a design response and a verification method',
    'The API spec covers the first milestone',
    'No unmitigated high threat',
    'The prototype covers every first-milestone UI story',
    'Any stack deviation has an approved ADR',
  ],
  G3: [
    '0 open S1/S2 bugs',
    'Every open S3 has an accepted workaround',
    'RTM coverage rule met',
    'Performance targets met',
    'No open critical or high security finding without accepted risk',
    'UAT signed',
    'Runbook and rollback plan ready',
  ],
  G4: [
    'No open P1/P2 incidents',
    'Availability at or above the SLO for 7 consecutive days',
    'Operations documentation complete',
    'Closure report accepted',
  ],
};

/** The phase that starts once the given gate is approved (spec §6). */
export const PHASE_AFTER_GATE: Record<GateId, string> = {
  G0: '1 Discovery and requirements',
  G1: '2 Design',
  G2: '3 Setup and 4 Build',
  G3: '6 Release',
  G4: '8 Operations and maintenance',
};
