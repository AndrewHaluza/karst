// Copy non-TS runtime assets (the webview HTML) next to the compiled output,
// mirroring the src tree so `readFileSync(join(HERE, 'ui/dashboard/webview.html'))`
// resolves at runtime. Kept tiny and dependency-free.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
      console.log(`copied .agents/skills/karst-graph-engineering/${entry}`);
    }
  }
}

const packageRel = join('.agents', 'skills', 'karst-graph-engineering');
copyTree(join(root, packageRel), join(root, 'dist', packageRel));
