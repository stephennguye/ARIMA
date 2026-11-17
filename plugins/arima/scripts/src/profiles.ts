import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { pluginRoot } from './lib/paths.js';
import { describeError, getValidator } from './lib/schema.js';

export type GateId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4';
export type ApproverRole = 'sponsor' | 'po' | 'legal';
export type ProfileName = 'solo-lite' | 'client-project' | 'regulated';

export interface Profile {
  schema_version: 1;
  name: ProfileName;
  gates: Partial<Record<GateId, { approvers: ApproverRole[]; require: 'all' }>>;
  rules: {
    urs_separate: boolean;
    srs: 'inside_prd' | 'separate' | 'separate_formally_reviewed';
    dpia: 'if_personal_data' | 'always';
    master_test_plan: boolean;
    rtm_coverage_at_g3: 'none' | 'must_requirements' | 'all_requirements';
    code_review: { reviewers: number; mode: string; human_pr_approval: true };
    security_signoff_g3: string;
    human_pentest: 'none' | 'recommended' | 'required';
    evidence_pack: string;
    change_requests: string;
  };
  artifacts: {
    required: string[];
    conditional: Record<string, 'personal_data'>;
    recommended: string[];
    human_only: string[];
  };
}

export const PROFILE_NAMES: readonly ProfileName[] = ['solo-lite', 'client-project', 'regulated'];

export function profilesDir(root: string = pluginRoot()): string {
  return path.join(root, 'profiles');
}

/** Loads and schema-validates one profile from profiles/<name>.yaml. Throws listing all problems. */
export function loadProfile(name: string, root: string = pluginRoot()): Profile {
  if (!(PROFILE_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown profile "${name}". Expected one of: ${PROFILE_NAMES.join(', ')}`);
  }
  const file = path.join(profilesDir(root), `${name}.yaml`);
  const data: unknown = parse(readFileSync(file, 'utf8'));
  const validate = getValidator('profile', root);
  if (!validate(data)) {
    const problems = (validate.errors ?? []).map(describeError).join('; ');
    throw new Error(`Invalid profile ${file}: ${problems}`);
  }
  const profile = data as Profile;
  if (profile.name !== name) {
    throw new Error(`Profile ${file} declares name "${profile.name}", expected "${name}"`);
  }
  return profile;
}

export function loadAllProfiles(root: string = pluginRoot()): Profile[] {
  return readdirSync(profilesDir(root))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => loadProfile(f.replace(/\.yaml$/, ''), root));
}

/** Gates the profile enforces, in order. */
export function enforcedGates(profile: Profile): GateId[] {
  return (['G0', 'G1', 'G2', 'G3', 'G4'] as const).filter((g) => profile.gates[g] !== undefined);
}

/** Roles that must be human for this profile's gates (spec §4.2). */
export function requiredApproverRoles(profile: Profile): ApproverRole[] {
  const set = new Set<ApproverRole>();
  for (const g of Object.values(profile.gates)) for (const r of g?.approvers ?? []) set.add(r);
  return [...set];
}

/** Whether a DPIA is mandatory, given whether the project handles personal data. */
export function dpiaRequired(profile: Profile, handlesPersonalData: boolean): boolean {
  return profile.rules.dpia === 'always' || handlesPersonalData;
}

/** Artifacts required in this profile, including conditional ones that apply. */
export function requiredArtifacts(profile: Profile, opts: { personalData: boolean }): string[] {
  const out = new Set(profile.artifacts.required);
  for (const [slug, cond] of Object.entries(profile.artifacts.conditional)) {
    if (cond === 'personal_data' && opts.personalData) out.add(slug);
  }
  return [...out];
}
