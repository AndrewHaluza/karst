import type { PortMapping } from '../sessionRunner.js';
import { setupHostError, SETUP_HOST_PORT } from '../../manifest/sandboxSetupHosts.js';
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

/** The `localhost` name the sbx forward proxy checks an HTTP request to the host as (policy log: `net:domain:localhost:<port>`). */
const PROXY_HOST_NAME = 'localhost';

/** Both host forms of one baseline port: HTTP is matched as `localhost`, raw TCP as the alias. One helper for allow and rm. */
export function hostPortResources(ports: readonly number[]): string[] {
  return ports.flatMap((p) => [`${PROXY_HOST_NAME}:${checkPort(p)}`, `${SANDBOX_HOST_ALIAS}:${checkPort(p)}`]);
}

/** `sbx policy rm network` takes no positional resource: removal is `--resource <list>`, `--force` skips the prompt. */
function policyArgs(verb: 'allow' | 'rm', name: string, resources: readonly string[]): string[] {
  const list = resources.join(',');
  return verb === 'allow' ? ['policy', 'allow', 'network', '--sandbox', name, list] : ['policy', 'rm', 'network', '--sandbox', name, '--resource', list, '--force'];
}

/** A per-sandbox network rule for exactly the given host ports (baseline services), on both host forms. */
export function sbxPolicyArgs(verb: 'allow' | 'rm', name: string, ports: readonly number[]): string[] {
  if (ports.length === 0) throw new Error('karst: sbx policy: no ports');
  return policyArgs(verb, name, hostPortResources(ports));
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
  return policyArgs(verb, name, hosts.map(setupHostResource));
}

/** The `sbx policy ls <sandbox>` listing (global and sandbox rules that apply); the v0.48.0 form `policy ls network --sandbox` is an unknown flag. */
export function sbxPolicyListArgs(name: string): string[] {
  return ['policy', 'ls', name, '--json'];
}

/** `--json` rules → the resources of the ALLOW network rules; undefined when the text is not that shape. */
function allowedFromJson(stdout: string): string[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return undefined; }
  const rules = (parsed as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) return undefined;
  return rules.flatMap((r: { decision?: unknown; resource_type?: unknown; resources?: unknown }) =>
    r.decision === 'allow' && r.resource_type === 'network' && Array.isArray(r.resources) ? r.resources.filter((x): x is string => typeof x === 'string') : []);
}

/** Every allowed `<host>:<port>` resource a `sbx policy ls` listing shows (lower-cased); a non-JSON listing is scanned for the shape only. */
export function parseSbxAllowed(stdout: string): Set<string> {
  const fromJson = allowedFromJson(stdout);
  if (fromJson) return new Set(fromJson.map((r) => r.toLowerCase()));
  return new Set((stdout.toLowerCase().match(/[a-z0-9*][a-z0-9.*-]*:\d+/g) ?? []));
}

/** Conservative: sbx's `*.` depth is not confirmed, so one label is the narrow reading; a host wrongly judged uncovered only gets a redundant rule that rm removes. True when `resource` is an allowed entry, or lies under an allowed `**.suffix:<port>` (any depth) or `*.suffix:<port>` (one label) wildcard. */
export function isResourceAllowed(allowed: ReadonlySet<string>, resource: string): boolean {
  const target = resource.toLowerCase();
  if (allowed.has(target)) return true;
  const at = target.lastIndexOf(':');
  const host = target.slice(0, at);
  const port = target.slice(at);
  for (const entry of allowed) {
    const m = /^(\*{1,2})\.(.+)(:\d+)$/.exec(entry);
    if (!m || m[3] !== port || !host.endsWith(`.${m[2]}`)) continue;
    const prefix = host.slice(0, host.length - m[2]!.length - 1);
    if (m[1] === '**' || !prefix.includes('.')) return true;
  }
  return false;
}
