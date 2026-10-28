import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  WEBVIEW_BUNDLE_ENTRIES,
  buildWebviewBundles,
} from '../../scripts/build-webview-send.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = 4317;
const ROOT = join(__dirname, '.tmp');

// The webview sender bundles (esbuild output of *.webviewSend.entry.ts /
// app/main.tsx) are gitignored build products.  vitest's globalSetup rebuilds
// them for the unit suite, but nothing rebuilds them for a checkout that goes
// straight to the sweep — CI, `npm run test:visual:docker`, a fresh clone.  The
// fixture writer hydrates each webview.html through the real injector chain,
// which readFileSync's those bundles, so a missing one kills fixture
// generation and with it the whole webServer (ENOENT webviewSend.webview.js,
// NDL-218). Rebuild before anything else runs: an existing bundle can belong
// to an older checkout and silently make the visual sweep exercise stale
// markup/styles.
console.log(
  `Building ${WEBVIEW_BUNDLE_ENTRIES.length} webview bundle(s) for the visual sweep`,
);
try {
  await buildWebviewBundles();
} catch (err) {
  console.error('Failed to build webview bundles:', err);
  process.exit(1);
}

// Regenerate fixtures before serving. They are gitignored build products too;
// reusing an existing catalog can make a sweep exercise stale markup after a
// checkout changes the fixture writer or its injected bundles.
console.log('Generating fixture pages...');
try {
  execSync(`npx tsx ${join(__dirname, 'writeFixtures.ts')}`, {
    cwd: __dirname,
    stdio: 'inherit',
    // tsx creates an IPC socket below TMPDIR; macOS limits its path length.
    env: { ...process.env, TMPDIR: '/tmp' },
    timeout: 60_000,
  });
} catch (err) {
  console.error('Failed to generate fixtures:', err);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function safePath(url) {
  const pathname = decodeURIComponent(url.split('?')[0]);
  const resolved = resolve(ROOT, '.' + pathname);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  const filePath = safePath(req.url);
  const exists = filePath ? existsSync(filePath) : false;
  const isFile = filePath && exists ? statSync(filePath).isFile() : false;
  if (!filePath || !exists || !isFile) {
    console.error(`404: ${req.url} -> ${filePath} (exists=${exists}, isFile=${isFile})`);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { 'content-type': mime });
    res.end(data);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`visual sweep server on http://127.0.0.1:${PORT}`);
});
