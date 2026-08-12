// Copy non-TS runtime assets (the webview HTML) next to the compiled output,
// mirroring the src tree so `readFileSync(join(HERE, 'ui/dashboard/webview.html'))`
// resolves at runtime. Kept tiny and dependency-free.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const assets = [
  'ui/dashboard/webview.html',
  'ui/diffs/webview.html',
  'ui/ticketForm/webview.html',
  'ui/settings/webview.html',
  'ui/sidebar/webview.html',
  'ui/usage/webview.html',
  'ui/gettingStarted/webview.html',
  'store/schema.sql',
  'model/icons/agent/claude-code.svg',
  'model/icons/agent/codex.svg',
  'model/icons/agent/antigravity-cli.svg',
  'model/icons/agent/opencode.svg',
]; // sourced from src/
// Sourced from the repo root. The setup runbook travels the same way the
// manifest template does: it is written into the TARGET project at scaffold
// time (src/manifest/setupGuide.ts), so it must exist next to the compiled
// output — it is not documentation for this repository.
const rootAssets = ['karst.example.yml', 'karst.uat-review-setup.md'];

for (const rel of assets) {
  const from = join(root, 'src', rel);
  const to = join(root, 'dist', rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${rel}`);
}

for (const rel of rootAssets) {
  const to = join(root, 'dist', rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, rel), to);
  console.log(`copied ${rel}`);
}

// Vendored webview libraries (xterm.js): npm devDependencies are build-time
// asset SOURCES only — the extension never requires them at runtime. The
// runtime reads dist/vendor/xterm/* (inlined into the dashboard webview by
// src/model/xtermAssets.ts), and .vscodeignore excludes node_modules/@xterm.
// The packages resolve through Node's ancestor walk (createRequire) so a
// build inside a karst worktree — which has no node_modules of its own, see
// the resolution note in rebuild-better-sqlite3.mjs — still copies the main
// checkout's bundles.
const require = createRequire(import.meta.url);
const xtermRoot = join(dirname(require.resolve('@xterm/xterm/package.json')), '..');

const vendorAssets = [
  [join(xtermRoot, 'xterm', 'lib', 'xterm.js'), 'vendor/xterm/xterm.js'],
  [join(xtermRoot, 'xterm', 'css', 'xterm.css'), 'vendor/xterm/xterm.css'],
  [join(xtermRoot, 'addon-fit', 'lib', 'addon-fit.js'), 'vendor/xterm/addon-fit.js'],
];

for (const [from, rel] of vendorAssets) {
  const to = join(root, 'dist', rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${rel}`);
}
