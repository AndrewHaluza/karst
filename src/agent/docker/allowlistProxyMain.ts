// Sidecar entry, bundled alone to dist/sandbox/opencode/allowlist-proxy.mjs
// and mounted read-only into the proxy container (proxySidecar.ts).
import { createAllowlistProxy, parseAllowlist, PROXY_PORT } from './allowlistProxy.js';

const allow = parseAllowlist(process.env.ALLOW);
createAllowlistProxy({ allow, log: (line) => process.stdout.write(`${line}\n`) }).listen(PROXY_PORT, '0.0.0.0');
