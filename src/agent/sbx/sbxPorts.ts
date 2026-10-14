import type { PortMapping } from '../sessionRunner.js';
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
