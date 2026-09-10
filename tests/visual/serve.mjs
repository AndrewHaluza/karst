import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4317;
const ROOT = new URL('./.tmp/', import.meta.url).pathname;

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`visual sweep server on http://127.0.0.1:${PORT}`);
});
