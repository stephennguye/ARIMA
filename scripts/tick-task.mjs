// Ticks a task in docs/BUILD-PLAN.md and appends notes.
// Usage (repo root): node scripts/tick-task.mjs T-03 "note one" "note two"
import { readFileSync, writeFileSync } from 'node:fs';

const [, , id, ...notes] = process.argv;
const file = 'docs/BUILD-PLAN.md';
const text = readFileSync(file, 'utf8');
const start = text.indexOf(`### ${id} `);
if (start < 0) throw new Error(`task ${id} not found in ${file}`);
const ends = [text.indexOf('\n### ', start + 5), text.indexOf('\n---', start)].filter((n) => n > 0);
const end = ends.length > 0 ? Math.min(...ends) : text.length;
let block = text
  .slice(start, end)
  .replace(/- \[ \]/g, '- [x]')
  .trimEnd();
const today = new Date().toISOString().slice(0, 10);
block += `\n- **Notes (done ${today}):**\n${notes.map((n) => `  - ${n}`).join('\n')}\n`;
writeFileSync(file, text.slice(0, start) + block + text.slice(end));
console.log(`ticked ${id}`);
