const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

/** One request line from the serve supervisor (arch:UATHOST-08): `ping`, or `run` a probe script on this live host. */
exports.handleHostLine = async function handleHostLine(line, deps) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, error: 'bad request: not JSON' };
  }
  const op = req !== null && typeof req === 'object' ? req.op : undefined;
  if (op === 'ping') return { ok: true };
  if (op === 'run') {
    const { scriptPath, outDir } = req;
    if (typeof scriptPath !== 'string' || typeof outDir !== 'string' || !path.isAbsolute(scriptPath) || !path.isAbsolute(outDir)) {
      return { ok: false, error: 'bad request: scriptPath and outDir must be absolute paths' };
    }
    try {
      return { ok: true, results: await deps.runProbe({ scriptPath, outDir }) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, error: `bad request: unknown op "${op}"` };
};

/** Unix-socket server: one JSON line in, one JSON line out, one connection per request. */
exports.listenHostChannel = function listenHostChannel(socketPath, deps) {
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((conn) => {
    conn.on('error', () => { /* the client hung up */ });
    let buf = '';
    let handled = false;
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0 || handled) return;
      handled = true;
      exports.handleHostLine(buf.slice(0, nl), deps).then(
        (reply) => conn.end(`${JSON.stringify(reply)}\n`),
        (err) => conn.end(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
};
