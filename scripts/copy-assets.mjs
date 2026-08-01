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
  'ui/onboarding/webview.html',
  'ui/settings/webview.html',
  'ui/sidebar/webview.html',
  'ui/usage/webview.html',
  'ui/welcome/webview.html',
  'store/schema.sql',
]; // sourced from src/
const rootAssets = ['karst.example.yml']; // sourced from the repo root

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
