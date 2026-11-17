// Bundles every CLI entry point in plugins/arima/scripts/src/bin/*.ts into
// plugins/arima/scripts/dist/<name>.mjs (ADR-0001). Output must be reproducible.
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, 'plugins/arima/scripts/src/bin');
const outDir = path.join(root, 'plugins/arima/scripts/dist');

const entries = readdirSync(binDir).filter((f) => f.endsWith('.ts'));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: entries.map((f) => path.join(binDir, f)),
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  // Bundled ESM that needs require() (CommonJS deps) keeps working.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

console.log(`built ${entries.length} bundle(s) -> ${path.relative(root, outDir)}`);
