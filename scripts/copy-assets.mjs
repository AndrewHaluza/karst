// Copy non-TS runtime assets (the webview HTML) next to the compiled output,
// mirroring the src tree so `readFileSync(join(HERE, 'ui/dashboard/webview.html'))`
// resolves at runtime. Kept tiny and dependency-free.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const assets = [
  'ui/dashboard/webview.html',
  'ui/diffs/webview.html',
  'ui/ticketForm/webview.html',
  'ui/settings/webview.html',
  'ui/sidebar/webview.html',
  'ui/usage/webview.html',
  'ui/resources/webview.html',
  'ui/gettingStarted/webview.html',
  'ui/serverLogs/webview.html',
  'store/schema.sql',
  'model/icons/agent/claude-code.svg',
  'model/icons/agent/codex.svg',
  'model/icons/agent/antigravity-cli.svg',
  'model/icons/agent/opencode.svg',
  // Webview CSS/JS that lives as a real sibling source file (see
  // agentPicker.ts/designComponents.ts/designRuntime.ts/tablerIcons.ts) rather
  // than a TS template-literal string; read at runtime via `readFileSync(join(HERE, …))`
  // exactly like the webview.html documents above.
  'model/agentPicker.webview.css',
  'model/agentPicker.webview.js',
  'model/serverLogsView.webview.css',
  'model/serverLogsView.webview.js',
  'model/designComponents.webview.css',
  'model/designRuntime.webview.js',
  'model/tablerIcons.webview.css',
  'model/tablerIcons.webview.js',
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

// The built-in approach package: the canonical shipped prompt tree must travel
// into the VSIX byte-for-byte so the parity test can prove the shipped bytes
// equal what reviewers see in Git. Walk the tree recursively; the package root
// itself is authored under `.agents/skills/karst-graph-engineering`.
function copyTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir)) {
    const from = join(fromDir, entry);
    const to = join(toDir, entry);
    if (statSync(from).isDirectory()) {
      copyTree(from, to);
    } else {
      copyFileSync(from, to);
      // The recursive walk visits files of the SAME basename (SKILL.md) at
      // distinct paths (the package root, graph-planner/, graph-node/) — log
      // the real path relative to the repo root, not just the basename, or a
      // build log misleadingly reads as the same file copied three times.
      console.log(`copied ${relative(root, to)}`);
    }
  }
}

const packageRel = join('.agents', 'skills', 'karst-graph-engineering');
copyTree(join(root, packageRel), join(root, 'dist', packageRel));

// Vendored webview libraries (xterm.js): npm devDependencies are build-time
// asset SOURCES only — the extension never requires them at runtime. The
// runtime reads dist/vendor/xterm/* (inlined into the dashboard webview by
// src/model/xtermAssets.ts), and .vscodeignore excludes node_modules/@xterm.
//
// Resolved through Node's own resolution, never by a path relative to this
// file: a build run from a linked worktree (empty local node_modules) must
// walk up to the main checkout, exactly like every import in the test suite.
const vendorAssets = [
  [require.resolve('@xterm/xterm/lib/xterm.js'), 'vendor/xterm/xterm.js'],
  [require.resolve('@xterm/xterm/css/xterm.css'), 'vendor/xterm/xterm.css'],
  [require.resolve('@xterm/addon-fit/lib/addon-fit.js'), 'vendor/xterm/addon-fit.js'],
];

for (const [from, rel] of vendorAssets) {
  const to = join(root, 'dist', rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${rel}`);
}
