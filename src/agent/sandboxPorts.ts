import type { PortMapping } from './sessionRunner.js';

/** The only host interface a sandbox port is ever published on (arch:AC-32). */
export const PUBLISH_HOST = '127.0.0.1';
/** How a sandbox names the host; a baseline allow rule targets it and nothing else. */
export const SANDBOX_HOST_ALIAS = 'host.docker.internal';

export function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`karst: invalid port ${JSON.stringify(port)}`);
  }
  return port;
}

export function publishSpec(m: PortMapping): string {
  return `${PUBLISH_HOST}:${checkPort(m.hostPort)}:${checkPort(m.sandboxPort)}`;
}

/** A publish failure that a different host port could fix. */
export function isPortTakenError(text: string): boolean {
  return /address already in use|port is already allocated|bind: .*in use/i.test(text);
}
