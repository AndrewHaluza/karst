import { createServer, connect } from 'node:net';

/** Exact host or a subdomain of an allowed host. Anything else (github.com, raw hosts, IPs) is refused. */
export function hostAllowed(host, allowed) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

/** Parses `CONNECT host:port HTTP/1.1`; returns null for anything else (plain-HTTP proxying is refused). */
export function parseConnect(line) {
  const m = /^CONNECT ([^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(line.trim());
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

/**
 * Hostname-allowlist CONNECT proxy. Started by the eval entrypoint as an unprivileged user that
 * the iptables rule lets out; every other uid is rejected, so ignoring the proxy env gets nothing.
 * Hostnames are logged (not secrets); request bodies are tunnelled blind.
 */
export function startProxy({ allowed, port, onDecision = () => {} }) {
  const server = createServer((client) => {
    client.once('data', (buf) => {
      const head = buf.toString('latin1');
      const target = parseConnect(head.split('\r\n')[0] ?? '');
      if (!target || target.port !== 443 || !hostAllowed(target.host, allowed)) {
        onDecision({ host: target?.host ?? '(non-CONNECT)', allowed: false });
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      onDecision({ host: target.host, allowed: true });
      const upstream = connect(target.port, target.host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream);
        upstream.pipe(client);
      });
      const drop = () => { client.destroy(); upstream.destroy(); };
      upstream.on('error', drop);
      client.on('error', drop);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const allowed = (process.env.EVAL_ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
  const port = Number(process.env.EVAL_PROXY_PORT ?? 3128);
  await startProxy({ allowed, port, onDecision: (d) => console.error(`eval-proxy: ${d.allowed ? 'allow' : 'DENY'} ${d.host}`) });
}
