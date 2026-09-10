import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const PORT = 4317;
const HERE = new URL('./', import.meta.url).pathname;
const ROOT = join(HERE, '.tmp');

// Write fixtures before starting the server.
try {
  execSync(`npx tsx ${join(HERE, 'writeFixtures.ts')}`, {
    cwd: HERE,
    stdio: 'inherit',
  });
} catch {
  console.error('Failed to write fixtures');
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
  // Strip query string and decode.
  const pathname = decodeURIComponent(url.split('?')[0]);
  // Resolve against ROOT and ensure it stays inside ROOT.
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
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
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
