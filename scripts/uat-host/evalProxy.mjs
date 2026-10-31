import { createServer, connect } from 'node:net';

/** Exact host or a subdomain of an allowed host. Anything else (github.com, raw hosts, IPs) is refused. */
export function hostAllowed(host, allowed) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

const MAX_HEADER_BYTES = 8192;

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
    let pending = Buffer.alloc(0);
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) {
        if (pending.length > MAX_HEADER_BYTES) client.destroy();
        return; // header not complete yet: keep buffering
      }
      client.off('data', onData);
      client.pause();
      const target = parseConnect(pending.subarray(0, end).toString('latin1').split('\r\n')[0] ?? '');
      if (!target || target.port !== 443 || !hostAllowed(target.host, allowed)) {
        onDecision({ host: target?.host ?? '(non-CONNECT)', allowed: false });
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      onDecision({ host: target.host, allowed: true });
      const early = pending.subarray(end + 4); // bytes pipelined behind the CONNECT header
      const upstream = connect(target.port, target.host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (early.length > 0) upstream.write(early);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      const drop = () => { client.destroy(); upstream.destroy(); };
      upstream.on('error', drop);
      client.on('error', drop);
    };
    client.on('data', onData);
    client.on('error', () => client.destroy());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const allowed = (process.env.EVAL_ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
  const port = Number(process.env.EVAL_PROXY_PORT ?? 3128);
  await startProxy({ allowed, port, onDecision: (d) => console.error(`eval-proxy: ${d.allowed ? 'allow' : 'DENY'} ${d.host}`) });
}
