// Detached entry of the host OAuth proxy, bundled to dist/oauth-proxy/oauth-proxy.mjs.
// Env: KARST_OAUTH_PORT_FILE, KARST_OAUTH_CONTROL_DIR. It writes one line per request
// (method, checked path, status) to stdout, which the spawner points at a log file.
import { startProxyHost } from './proxyHost.js';

const portFile = process.env['KARST_OAUTH_PORT_FILE'];
const controlDir = process.env['KARST_OAUTH_CONTROL_DIR'];
if (!portFile || !controlDir) { process.stderr.write('KARST_OAUTH_PORT_FILE and KARST_OAUTH_CONTROL_DIR are required.\n'); process.exit(2); }

startProxyHost({ portFile, controlDir, log: (line) => process.stdout.write(`${line}\n`) }).then((running) => {
  if (!running) return;
  const stop = (): void => { void running.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}, (e: unknown) => { process.stderr.write(`oauth proxy failed: ${e instanceof Error ? e.name : 'error'}\n`); process.exit(1); });
