// Sidecar entry, bundled alone to dist/sandbox/opencode/allowlist-proxy.mjs
// and mounted read-only into the proxy container (proxySidecar.ts).
import { createAllowlistProxy, parseAllowlist, parseHostPorts, PROXY_PORT } from './allowlistProxy.js';

const allow = parseAllowlist(process.env.ALLOW);
createAllowlistProxy({ allow, hostPorts: parseHostPorts(process.env.ALLOW_HOSTPORTS), log: (line) => process.stdout.write(`${line}\n`) }).listen(PROXY_PORT, '0.0.0.0');
