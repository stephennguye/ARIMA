import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the plugin root. Prefers CLAUDE_PLUGIN_ROOT (set by Claude Code), otherwise walks up
 * from this module until it finds .claude-plugin/plugin.json. Works from src/ and from dist/.
 */
export function pluginRoot(): string {
  const fromEnv = process.env['CLAUDE_PLUGIN_ROOT'];
  if (fromEnv) return path.resolve(fromEnv);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot locate the ARIMA plugin root');
    dir = parent;
  }
}
