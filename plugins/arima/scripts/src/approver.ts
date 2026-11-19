import type { TeamConfig } from './config.js';
import type { GateId, Profile } from './profiles.js';

/**
 * The approver check (03-contracts 3.5; D-40, S1 deferred). Every gate decision goes through this
 * ONE function, so the real check (GitHub-style "last edited by" proof, WP-330) replaces the
 * placeholder in one place. The placeholder trusts Notion's `Decided by` person and accepts it
 * only if that person fills one of the profile's approver roles for the gate in `team.yaml`.
 */

export interface ApproverCheck {
  method: 'placeholder' | 'last_edited_by';
  /** Names of the people who may decide this gate. */
  approvers: string[];
  ok: boolean;
}

export interface Decider {
  id?: string;
  name?: string;
}

export function checkApprover(o: {
  gate: GateId;
  decidedBy: readonly Decider[];
  team: Pick<TeamConfig, 'people' | 'roles'>;
  profile: Pick<Profile, 'gates'>;
}): ApproverCheck {
  const roles = o.profile.gates[o.gate]?.approvers ?? [];
  const people = roles
    .map((r) => o.team.roles[r]?.person)
    .filter((p): p is string => p !== undefined)
    .map((p) => o.team.people[p])
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  const ok =
    o.decidedBy.length > 0 &&
    o.decidedBy.some((d) =>
      people.some(
        (p) =>
          (d.id !== undefined && d.id === p.notion_user) ||
          (d.name !== undefined && d.name === p.name),
      ),
    );
  return { method: 'placeholder', approvers: [...new Set(people.map((p) => p.name))], ok };
}
