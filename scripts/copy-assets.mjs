// Copy non-TS runtime assets (the webview HTML) next to the compiled output,
// mirroring the src tree so `readFileSync(join(HERE, 'ui/dashboard/webview.html'))`
// resolves at runtime. Kept tiny and dependency-free.
import { copyFileSync, mkdirSync } from 'node:fs';
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
