import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { pluginRoot } from './lib/paths.js';
import { requiredArtifacts } from './profiles.js';
import type { Profile } from './profiles.js';

export type ArtifactKind = 'document' | 'record' | 'generated' | 'code' | 'external';

export interface CatalogArtifact {
  id: string;
  name: string;
  phase: string;
  owner: string;
  approver: string;
  master: string;
  consumers: string;
  required_in: string;
  required: { solo_lite: boolean; client_project: boolean; regulated: boolean };
  kind: ArtifactKind;
  template: string | null;
  sections?: string[];
}

export function loadCatalog(root: string = pluginRoot()): CatalogArtifact[] {
  const file = path.join(root, 'catalog', 'artifacts.yaml');
  const doc = parse(readFileSync(file, 'utf8')) as {
    schema_version: number;
    artifacts: CatalogArtifact[];
  };
  if (doc.schema_version !== 1 || !Array.isArray(doc.artifacts)) {
    throw new Error(`Invalid catalog ${file}`);
  }
  const seen = new Set<string>();
  for (const a of doc.artifacts) {
    if (seen.has(a.id)) throw new Error(`Duplicate catalog id ${a.id}`);
    seen.add(a.id);
    if (a.kind === 'document' && (a.template === null || a.sections === undefined)) {
      throw new Error(`Catalog artifact ${a.id} is a document but has no template or sections`);
    }
  }
  return doc.artifacts;
}

/** H2 headings of a Markdown document, lower-cased. */
export function headingsOf(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
}

export interface DocumentCheck {
  ok: boolean;
  missing: string[];
}

/** A document passes when every required section of its template is present as an H2 heading. */
export function validateDocument(
  markdown: string,
  artifactId: string,
  catalog: CatalogArtifact[] = loadCatalog(),
): DocumentCheck {
  const a = catalog.find((x) => x.id === artifactId);
  if (a === undefined) throw new Error(`Unknown artifact "${artifactId}"`);
  const have = new Set(headingsOf(markdown));
  const missing = (a.sections ?? []).filter((s) => !have.has(s.toLowerCase()));
  return { ok: missing.length === 0, missing };
}

export interface ProfileStatus {
  profile: string;
  required: string[];
  present: string[];
  missing: string[];
}

/**
 * What a profile requires and which of it is present (the base of gate-check). `present` is a list of
 * artifact ids the caller found; ids unknown to the catalog are an error.
 */
export function profileStatus(
  profile: Profile,
  present: string[],
  opts: { personalData: boolean },
  catalog: CatalogArtifact[] = loadCatalog(),
): ProfileStatus {
  const ids = new Set(catalog.map((a) => a.id));
  for (const p of present) if (!ids.has(p)) throw new Error(`Unknown artifact "${p}"`);
  const required = requiredArtifacts(profile, opts).filter(
    (id) => !profile.artifacts.human_only.includes(id),
  );
  const have = new Set(present);
  return {
    profile: profile.name,
    required,
    present: required.filter((r) => have.has(r)),
    missing: required.filter((r) => !have.has(r)),
  };
}

/** Whether the template file named by a catalog artifact exists in the plugin. */
export function templateExists(a: CatalogArtifact, root: string = pluginRoot()): boolean {
  return a.template !== null && existsSync(path.join(root, 'templates', a.template));
}
