import type { PortMapping } from '../sessionRunner.js';
import { setupHostError, SETUP_HOST_PORT } from '../sandboxSetupHosts.js';
import { checkPort, PUBLISH_HOST, publishSpec, SANDBOX_HOST_ALIAS } from '../sandboxPorts.js';

export { isPortTakenError } from '../sandboxPorts.js';

/** `sbx ports <name> --publish 127.0.0.1:<host>:<sandbox>` (ST2 exp 8). */
export function sbxPublishArgs(name: string, m: PortMapping): string[] {
  return ['ports', name, '--publish', publishSpec(m)];
}

export function sbxUnpublishArgs(name: string, m: PortMapping): string[] {
  return ['ports', name, '--unpublish', publishSpec(m)];
}

/**
 * `sbx ports <name>` table → the mappings published on 127.0.0.1 over tcp. Any
 * other row is not one karst made, so it never counts as a recorded mapping.
 */
export function parseSbxPorts(stdout: string): PortMapping[] {
  const rows: PortMapping[] = [];
  for (const line of stdout.split('\n')) {
    const [ip, host, sandbox, proto] = line.trim().split(/\s+/);
    if (ip !== PUBLISH_HOST || !proto?.startsWith('tcp')) continue;
    const hostPort = Number(host);
    const sandboxPort = Number(sandbox);
    if (Number.isInteger(hostPort) && Number.isInteger(sandboxPort)) rows.push({ hostPort, sandboxPort });
  }
  return rows;
}

/** A per-sandbox network rule for exactly the given host ports (baseline services). */
export function sbxPolicyArgs(verb: 'allow' | 'rm', name: string, ports: readonly number[]): string[] {
  if (ports.length === 0) throw new Error('karst: sbx policy: no ports');
  const resources = ports.map((p) => `${SANDBOX_HOST_ALIAS}:${checkPort(p)}`).join(',');
  return ['policy', verb, 'network', '--sandbox', name, resources];
}

/** The `<host>:443` resource of one setup host; a separate form from the port-only baseline rule. */
export function setupHostResource(host: string): string {
  const bad = setupHostError(host);
  if (bad) throw new Error(`karst: sbx policy: ${bad}`);
  return `${host}:${SETUP_HOST_PORT}`;
}

/** A per-sandbox network rule for exactly the given setup hosts. */
export function sbxHostPolicyArgs(verb: 'allow' | 'rm', name: string, hosts: readonly string[]): string[] {
  if (hosts.length === 0) throw new Error('karst: sbx policy: no hosts');
  return ['policy', verb, 'network', '--sandbox', name, hosts.map(setupHostResource).join(',')];
}

/** Every `<host>:<port>` resource a `sbx policy ls` listing shows (lower-cased); the shape of the rest is not relied on. */
export function parseSbxAllowed(stdout: string): Set<string> {
  return new Set((stdout.toLowerCase().match(/[a-z0-9*][a-z0-9.*-]*:\d+/g) ?? []));
}
