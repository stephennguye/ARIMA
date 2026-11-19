import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pluginRoot } from './lib/paths.js';

/**
 * Renders templates/<name>.md, replacing {{key}} with the given values. A placeholder with no value
 * is an error (so a template and the code that fills it cannot drift apart), and so is an unused value.
 */
export function renderTemplate(
  name: string,
  vars: Record<string, string>,
  root: string = pluginRoot(),
): string {
  const text = readFileSync(path.join(root, 'templates', `${name}.md`), 'utf8');
  const used = new Set<string>();
  const out = text.replace(/\{\{([a-z_]+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`template ${name}: no value for {{${key}}}`);
    used.add(key);
    return v;
  });
  const extra = Object.keys(vars).filter((k) => !used.has(k));
  if (extra.length > 0) throw new Error(`template ${name}: unused values ${extra.join(', ')}`);
  return out;
}
