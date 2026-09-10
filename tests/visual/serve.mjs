import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = 4317;
const ROOT = join(__dirname, '.tmp');

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
