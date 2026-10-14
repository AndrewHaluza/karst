import { isPortTakenError, publishSpec } from '../sandboxPorts.js';
import type { PortMapping, PublishResult } from '../sessionRunner.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import type { DockerNames } from './dockerNames.js';
import { detail, DOCKER_BIN } from './dockerPreflight.js';
import type { DockerProcess } from './dockerProcess.js';
import { HARDENING } from './dockerRunArgs.js';

/**
 * Docker ignores `-p` on an `--internal` network, and a routable network on
 * the agent container would give it egress. So each declared port gets a
 * relay: a container on the default bridge that publishes ONLY that port on
 * 127.0.0.1, joins the internal ticket network, and forwards every connection
 * to `<agent container>:<sandboxPort>` — and nowhere else (arch:AC-32).
 */
const RELAY_LABEL = 'karst.relay';
const PORTS_LABEL = 'karst.ports';

/** Node builtins only, fixed text: the target comes from env, never from a connection. */
export const RELAY_SCRIPT = [
  "const net=require('node:net');",
  'const host=process.env.TARGET_HOST,port=Number(process.env.TARGET_PORT);',
  'net.createServer((c)=>{const u=net.connect(port,host);c.pipe(u);u.pipe(c);',
  "u.on('error',()=>c.destroy());c.on('error',()=>u.destroy());})",
  ".listen(Number(process.env.LISTEN_PORT),'0.0.0.0');",
].join('');

export function relayName(names: DockerNames, m: PortMapping): string {
  return `${names.container}-port-${m.hostPort}`;
}

export function relayRunArgs(names: DockerNames, m: PortMapping): string[] {
  return [
    'run', '--detach', '--name', relayName(names, m),
    '--publish', publishSpec(m), ...HARDENING,
    '--label', `${RELAY_LABEL}=${names.container}`, '--label', `${PORTS_LABEL}=${m.hostPort}:${m.sandboxPort}`,
    '--env', `TARGET_HOST=${names.container}`, '--env', `TARGET_PORT=${m.sandboxPort}`,
    '--env', `LISTEN_PORT=${m.sandboxPort}`,
    OPENCODE_IMAGE, 'node', '-e', RELAY_SCRIPT,
  ];
}

export async function publishRelay(proc: DockerProcess, names: DockerNames, m: PortMapping): Promise<PublishResult> {
  const relay = relayName(names, m);
  await proc.run(DOCKER_BIN, ['rm', '--force', relay]);
  const run = await proc.run(DOCKER_BIN, relayRunArgs(names, m));
  if (run.code !== 0) {
    return { ok: false, reason: `docker port relay ${m.hostPort} failed: ${detail(run)}`, portTaken: isPortTakenError(run.stderr) };
  }
  const joined = await proc.run(DOCKER_BIN, ['network', 'connect', names.network, relay]);
  if (joined.code !== 0) {
    await proc.run(DOCKER_BIN, ['rm', '--force', relay]);
    return { ok: false, reason: `docker port relay ${m.hostPort} cannot reach the sandbox: ${detail(joined)}`, portTaken: false };
  }
  return { ok: true };
}

export async function unpublishRelay(proc: DockerProcess, names: DockerNames, m: PortMapping): Promise<void> {
  await proc.run(DOCKER_BIN, ['rm', '--force', relayName(names, m)]);
}

export function parseRelayPorts(stdout: string): PortMapping[] {
  const rows: PortMapping[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(\d{1,5}):(\d{1,5})$/.exec(line.trim());
    if (match) rows.push({ hostPort: Number(match[1]), sandboxPort: Number(match[2]) });
  }
  return rows;
}

/** Running relays only: a stopped one publishes nothing. */
export async function listRelayPorts(proc: DockerProcess, names: DockerNames): Promise<PortMapping[] | null> {
  const ps = await proc.run(DOCKER_BIN, ['ps', '--filter', `label=${RELAY_LABEL}=${names.container}`, '--format', `{{.Label "${PORTS_LABEL}"}}`]);
  return ps.code === 0 ? parseRelayPorts(ps.stdout) : null;
}

export async function removeAllRelays(proc: DockerProcess, names: DockerNames): Promise<void> {
  const ps = await proc.run(DOCKER_BIN, ['ps', '--all', '--quiet', '--filter', `label=${RELAY_LABEL}=${names.container}`]);
  const ids = ps.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (ids.length > 0) await proc.run(DOCKER_BIN, ['rm', '--force', ...ids]);
}
