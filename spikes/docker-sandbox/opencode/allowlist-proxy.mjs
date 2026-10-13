// Minimal CONNECT allowlist proxy (spike only). ALLOW=comma-separated host suffixes.
import http from 'node:http';
import net from 'node:net';
const allow = (process.env.ALLOW ?? '').split(',').filter(Boolean);
const ok = (h) => allow.some((a) => h === a || h.endsWith('.' + a));
const srv = http.createServer((q, r) => { r.writeHead(403); r.end('plain http denied'); });
srv.on('connect', (req, sock, head) => {
  const [host, port] = req.url.split(':');
  if (!ok(host)) { console.log('DENY', host); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  console.log('ALLOW', host);
  const up = net.connect(Number(port) || 443, host, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
srv.listen(3128, () => console.log('listening'));
