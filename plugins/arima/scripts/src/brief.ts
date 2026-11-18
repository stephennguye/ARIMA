/** Required sections of a project brief (spec §8.2, templates/project-brief.md). */
export const BRIEF_SECTIONS = [
  'Problem',
  'Target users',
  'Goals and KPIs',
  'Must-have features',
  'Out of scope',
  'Constraints',
  'Known risks',
] as const;

export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export interface BriefCheck {
  ok: boolean;
  /** Required sections with no heading at all. */
  missing: BriefSection[];
  /** Headings present but with nothing under them (write "None" rather than leaving it blank). */
  empty: BriefSection[];
  /** Text under each required section, trimmed. */
  sections: Partial<Record<BriefSection, string>>;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Splits a brief into its `##` sections and checks the required ones are present and filled. */
export function checkBrief(markdown: string): BriefCheck {
  const bodies = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^##\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      current = norm(h[1] as string);
      if (!bodies.has(current)) bodies.set(current, []);
    } else if (/^#\s/.test(line)) {
      current = undefined;
    } else if (current !== undefined) {
      bodies.get(current)?.push(line);
    }
  }
  const missing: BriefSection[] = [];
  const empty: BriefSection[] = [];
  const sections: BriefCheck['sections'] = {};
  for (const name of BRIEF_SECTIONS) {
    const body = bodies.get(norm(name));
    if (body === undefined) {
      missing.push(name);
      continue;
    }
    const text = body
      .join('\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (text === '') empty.push(name);
    else sections[name] = text;
  }
  return { ok: missing.length === 0 && empty.length === 0, missing, empty, sections };
}

/** Human-readable list of what is wrong, for the init skill to turn into questions. */
export function describeGaps(c: BriefCheck): string[] {
  return [
    ...c.missing.map((s) => `Section "${s}" is missing`),
    ...c.empty.map((s) => `Section "${s}" is empty (write "None" if there is nothing to say)`),
  ];
}
