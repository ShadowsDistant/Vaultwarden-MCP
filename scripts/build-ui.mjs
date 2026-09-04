// Bundles ui/card.ts into a single self-contained HTML file at dist/ui/card.html, and copies
// assets/ and the dialog and clipboard helpers into dist/ so a packed build is complete.
// Run from the build tree (it needs node_modules).

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'ui');
fs.mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'ui', 'card.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  write: false,
  logLevel: 'warning',
});

// Escaping </script inside the bundle, and using a function replacement so that $& and $1
// sequences in minified code are not treated as replacement patterns.
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = fs.readFileSync(path.join(root, 'ui', 'card.html'), 'utf8');
if (!template.includes('/*__BUNDLE__*/')) throw new Error('ui/card.html is missing the /*__BUNDLE__*/ placeholder');
const html = template.replace('/*__BUNDLE__*/', () => js);
fs.writeFileSync(path.join(outDir, 'card.html'), html, 'utf8');
console.error(`ui: wrote ${path.join(outDir, 'card.html')} (${(html.length / 1024).toFixed(0)} KB)`);

const assets = path.join(root, 'assets');
if (fs.existsSync(assets)) {
  fs.cpSync(assets, path.join(root, 'dist', 'assets'), { recursive: true });
  console.error('ui: copied assets');
}

// The native dialog and clipboard helpers are resolved relative to dist/, so they travel
// with the compiled output rather than only existing in the source tree.
const distScripts = path.join(root, 'dist', 'scripts');
fs.mkdirSync(distScripts, { recursive: true });
for (const f of ['secure-prompt.ps1', 'secure-prompt-mac.mjs', 'secure-prompt-linux.mjs', 'clip.ps1', 'clip-mac.mjs', 'clip-linux.mjs']) {
  const from = path.join(root, 'scripts', f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(distScripts, f));
}
console.error('ui: copied helper scripts');
