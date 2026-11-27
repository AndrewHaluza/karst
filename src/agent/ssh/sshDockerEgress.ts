import { PROXY_PORT } from '../docker/allowlistProxy.js';
import type { StepResult } from '../docker/dockerClone.js';
import { OPENCODE_IMAGE } from '../docker/dockerImage.js';
import { detail, DOCKER_BIN } from '../docker/dockerPreflight.js';
import type { DockerProcess } from '../docker/dockerProcess.js';
import type { DockerNames } from '../docker/dockerNames.js';
import { HARDENING, userArgs, type LinuxUser } from '../docker/dockerRunArgs.js';
import { PROXY_ALIAS } from '../docker/proxySidecar.js';

/**
 * The egress probe of `mode: docker` (`@arch:AC-53` (d), D822 edit 7).
 *
 * `enforcesSandbox: true` is only honest when the remote daemon really isolates
 * the container: the ticket network is `--internal`, its only exit is the
 * allowlist proxy, and IPv6 has no second way out. A remote Docker install can
 * differ from the local one (a daemon with `ip6tables` off, a bridged default
 * network, a proxy that failed to start), so the fact is MEASURED in one
 * hardened one-shot container before the launch is allowed to be autonomous.
 *
 * Three checks, all inside the same container:
 *
 * 1. a direct TCP connect to a blocked public IPv4 address must FAIL;
 * 2. a direct TCP connect to a blocked public IPv6 address must FAIL;
 * 3. `karst-proxy:<port>` must answer a `CONNECT blocked.invalid:443` with an
 *    HTTP `403` — proving the proxy is alive, listening, and enforcing the
 *    allowlist rather than merely being reachable.
 *
 * Only then does the probe print `KARST_EGRESS_OK`. Every other outcome names
 * the failing check; the caller prefixes `ssh docker egress not enforced: …`
 * and falls back to a prompted host run.
 */

export const EGRESS_PROBE_OK = 'KARST_EGRESS_OK';

/** A public address that must not be reachable: neither is in any allowlist. */
const BLOCKED_IPV4 = '1.1.1.1';
const BLOCKED_IPV6 = '2606:4700:4700::1111';
/** A host the proxy's allowlist can never hold, so the CONNECT must be refused. */
const BLOCKED_HOST = 'blocked.invalid';
/** Every check is bounded; a hung connect must not hang the launch. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * The in-container program (`node -e`). Node builtins only, so it works in the
 * pinned sandbox image with no extra tool. Fixed literals plus the proxy alias
 * and port from the modules that own them.
 */
export const EGRESS_PROBE_SCRIPT = [
  "const net = require('node:net');",
  "const fail = (reason) => { process.stdout.write(reason + '\\n'); process.exit(1); };",
  'const connects = (host, port) => new Promise((resolve) => {',
  '  let done = false;',
  '  let socket = null;',
  `  const finish = (open) => { if (done) return; done = true; if (socket) socket.destroy(); resolve(open); };`,
  '  socket = net.connect({ host: host, port: port });',
  `  socket.setTimeout(${String(PROBE_TIMEOUT_MS)});`,
  '  socket.once("connect", () => finish(true));',
  '  socket.once("timeout", () => finish(false));',
  '  socket.once("error", () => finish(false));',
  '});',
  'const proxyRefusal = () => new Promise((resolve) => {',
  '  let buffer = "";',
  '  let done = false;',
  '  let socket = null;',
  '  const finish = (value) => { if (done) return; done = true; if (socket) socket.destroy(); resolve(value); };',
  `  socket = net.connect({ host: '${PROXY_ALIAS}', port: ${String(PROXY_PORT)} });`,
  `  socket.setTimeout(${String(PROBE_TIMEOUT_MS)});`,
  '  socket.once("connect", () => {',
  `    socket.write(['CONNECT ${BLOCKED_HOST}:443 HTTP/1.1', 'Host: ${BLOCKED_HOST}:443', '', ''].join('\\r\\n'));`,
  '  });',
  '  socket.on("data", (chunk) => {',
  '    buffer += chunk.toString("utf8");',
  '    const match = /^HTTP\\/1\\.[01] (\\d{3})/.exec(buffer);',
  '    if (match) finish(match[1] === "403" ? "refused" : "other");',
  '  });',
  '  socket.once("timeout", () => finish("silent"));',
  '  socket.once("error", () => finish("silent"));',
  '  socket.once("close", () => finish("silent"));',
  '});',
  '(async () => {',
  `  if (await connects('${BLOCKED_IPV4}', 443)) fail('direct IPv4 egress succeeded');`,
  `  if (await connects('${BLOCKED_IPV6}', 443)) fail('direct IPv6 egress succeeded');`,
  '  const proxy = await proxyRefusal();',
  `  if (proxy !== 'refused') fail(proxy === 'other' ? 'proxy did not refuse blocked host' : 'proxy did not answer');`,
  `  process.stdout.write('${EGRESS_PROBE_OK}\\n');`,
  '})().catch((err) => fail(String((err && err.message) || err)));',
].join('\n');

/**
 * Run the probe on the ticket's internal network. `ok` only on exit 0 AND the
 * exact marker: any other exit, a missing marker or a transport failure means
 * the isolation was not proven, so the sandbox is not used.
 */
export async function probeSshDockerEgress(
  proc: DockerProcess,
  names: DockerNames,
  user: LinuxUser | undefined,
  debug?: (message: string) => void,
): Promise<StepResult> {
  let out;
  try {
    out = await proc.run(DOCKER_BIN, [
      'run', '--rm', '--network', names.network, ...HARDENING, ...userArgs(user),
      OPENCODE_IMAGE, 'node', '-e', EGRESS_PROBE_SCRIPT,
    ]);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (out.transport === true) {
    return { ok: false, reason: `the probe did not reach the remote daemon: ${detail(out)}` };
  }
  if (out.code !== 0) {
    const said = out.stdout.trim() || detail(out);
    return { ok: false, reason: said === '' ? `the probe exited ${String(out.code)}` : said };
  }
  if (out.stdout.trim() !== EGRESS_PROBE_OK) {
    return { ok: false, reason: `the probe printed no ${EGRESS_PROBE_OK} marker` };
  }
  debug?.('[ssh docker] egress probe passed: no direct IPv4/IPv6 egress, proxy refuses a blocked host');
  return { ok: true };
}
