import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = 4317;
const ROOT = join(__dirname, '.tmp');

// Ensure fixtures exist before serving.  On a clean checkout .tmp/ is absent
// and every request would 404 without this step.
if (!existsSync(ROOT) || readdirSync(ROOT).length === 0) {
  console.log('Generating fixture pages...');
  try {
    execSync(`npx tsx ${join(__dirname, 'writeFixtures.ts')}`, {
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 60_000,
    });
  } catch (err) {
    console.error('Failed to generate fixtures:', err);
    process.exit(1);
  }
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
