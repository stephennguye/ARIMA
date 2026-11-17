import { describe, expect, it } from 'vitest';
import {
  dpiaRequired,
  enforcedGates,
  loadAllProfiles,
  loadProfile,
  requiredApproverRoles,
  requiredArtifacts,
} from '../src/profiles.js';

describe('profiles (spec §4.3)', () => {
  it('loads and validates all three shipped profiles', () => {
    expect(
      loadAllProfiles()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['client-project', 'regulated', 'solo-lite']);
  });

  it('client-project enforces G0-G4', () => {
    expect(enforcedGates(loadProfile('client-project'))).toEqual(['G0', 'G1', 'G2', 'G3', 'G4']);
  });

  it('solo-lite enforces only G1 and G3', () => {
    expect(enforcedGates(loadProfile('solo-lite'))).toEqual(['G1', 'G3']);
  });

  it('regulated enforces G0-G4 with a named compliance (legal) sign-off', () => {
    const p = loadProfile('regulated');
    expect(enforcedGates(p)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4']);
    expect(requiredApproverRoles(p)).toContain('legal');
  });

  it('regulated requires a pentest and a DPIA always; others do not', () => {
    const reg = loadProfile('regulated');
    expect(reg.rules.human_pentest).toBe('required');
    expect(dpiaRequired(reg, false)).toBe(true);
    expect(requiredArtifacts(reg, { personalData: false })).toContain('dpia');
    expect(requiredArtifacts(reg, { personalData: false })).toContain('pentest-report');

    const client = loadProfile('client-project');
    expect(client.rules.human_pentest).toBe('recommended');
    expect(dpiaRequired(client, false)).toBe(false);
    expect(dpiaRequired(client, true)).toBe(true);
    expect(requiredArtifacts(client, { personalData: false })).not.toContain('dpia');
    expect(requiredArtifacts(client, { personalData: true })).toContain('dpia');
  });

  it('applies RTM coverage per profile', () => {
    expect(loadProfile('solo-lite').rules.rtm_coverage_at_g3).toBe('none');
    expect(loadProfile('client-project').rules.rtm_coverage_at_g3).toBe('must_requirements');
    expect(loadProfile('regulated').rules.rtm_coverage_at_g3).toBe('all_requirements');
  });

  it('requires human PR approval everywhere (D-21)', () => {
    for (const p of loadAllProfiles()) expect(p.rules.code_review.human_pr_approval).toBe(true);
  });

  it('rejects an unknown profile name', () => {
    expect(() => loadProfile('nope')).toThrow(/Unknown profile/);
  });
});
