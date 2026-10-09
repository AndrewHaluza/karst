/**
 * Orphaned ticket containers: docker containers named for a ticket whose
 * `servers` row is gone, or whose ticket is done or archived.
 *
 * Containers are removed by NAME (see dockerContainer.ts). A container that
 * outlives its row keeps its published ports bound and its memory held, with
 * nothing pointing at it. This module finds those containers by listing docker
 * and removes the ones no live server row claims. The baseline container is
 * never a candidate: its name does not parse as a ticket container.
 */

import { spawn } from 'node:child_process';
import type { Store } from '../store/db.js';
import { commandOutput } from './asyncProcess.js';
import { removeContainerVerified, type CommandExecutor } from './dockerContainer.js';

export type { CommandExecutor } from './dockerContainer.js';

/** How long to wait for a `docker ps` listing before treating docker as silent. */
const LIST_TIMEOUT_MS = 5_000;

const TICKET_CONTAINER = /^karst-t(\d+)-.+$/;
const HOST_PORT = /:(\d+)->/g;

export interface OrphanContainerOptions {
  /** Verbose decision-point logging, prefixed `[runtime]`. */
  debug?: (message: string) => void;
  /** Injected spawner, so tests never touch a real docker daemon. */
  spawnFn?: typeof spawn;
  /** Injected command executor for testing; defaults to commandOutput. */
  commandOutput?: CommandExecutor;
}

export interface TicketContainer {
  name: string;
  ports: number[];
}

export interface OrphanRemovalResult {
  removed: string[];
  failed: string[];
}

/** The ticket a karst container belongs to, or null for any other name. */
export function parseTicketContainerName(name: string): { ticketId: number } | null {
  const match = TICKET_CONTAINER.exec(name);
  if (match === null || match[1] === undefined) return null;
  return { ticketId: Number(match[1]) };
}

/** Distinct host ports from a docker `Ports` column, e.g. `0.0.0.0:8084->80/tcp`. */
export function parseHostPorts(portsText: string): number[] {
  const ports = new Set<number>();
  for (const match of portsText.matchAll(HOST_PORT)) {
    ports.add(Number(match[1]));
  }
  return [...ports];
}

/**
 * Running ticket containers, with their host ports. Null when docker did not
 * answer. Names that are not ticket containers (the baseline) are dropped.
 */
export async function listTicketContainers(
  opts: OrphanContainerOptions = {},
): Promise<TicketContainer[] | null> {
  const spawnFn = opts.spawnFn ?? spawn;
  const exec = opts.commandOutput ?? ((...args) => commandOutput(...args));
  const out = await exec(
    'docker',
    ['ps', '--filter', 'name=^karst-t', '--format', '{{.Names}}\t{{.Ports}}'],
    LIST_TIMEOUT_MS,
    spawnFn,
  );
  if (out === null) {
    opts.debug?.('[runtime] docker did not list ticket containers');
    return null;
  }
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [name = '', ports = ''] = line.split('\t');
      return { name: name.trim(), ports: parseHostPorts(ports) };
    })
    .filter((c) => parseTicketContainerName(c.name) !== null);
}

/** Names of containers whose ticket is not live. Pure. */
export function findOrphanContainers(
  containers: TicketContainer[],
  isLive: (ticketId: number, name: string) => boolean,
): string[] {
  return containers
    .filter((c) => {
      const parsed = parseTicketContainerName(c.name);
      return parsed !== null && !isLive(parsed.ticketId, c.name);
    })
    .map((c) => c.name);
}

/**
 * Container names claimed by a running server row whose ticket is still open.
 * A row with no ticket is treated as live: nothing says it is finished.
 */
function liveContainerNames(store: Store): Set<string> {
  const rows = store.db
    .prepare(
      `SELECT s.container AS container FROM servers s
         LEFT JOIN tickets t ON t.id = s.ticket_id
        WHERE s.status = 'running' AND s.container IS NOT NULL
          AND (t.id IS NULL OR (t.archived_at IS NULL AND (t.stage_current IS NULL OR t.stage_current <> 'done')))`,
    )
    .all() as { container: string }[];
  return new Set(rows.map((r) => r.container));
}

/**
 * Remove every ticket container no live server row claims. A failed removal is
 * recorded and the sweep continues. Empty result when docker did not answer.
 */
export async function removeOrphanContainers(
  store: Store,
  opts: OrphanContainerOptions = {},
): Promise<OrphanRemovalResult> {
  const result: OrphanRemovalResult = { removed: [], failed: [] };
  const containers = await listTicketContainers(opts);
  if (containers === null) return result;

  const live = liveContainerNames(store);
  const orphans = findOrphanContainers(containers, (_ticketId, name) => live.has(name));
  opts.debug?.(`[runtime] ${orphans.length} orphan ticket container(s) of ${containers.length}`);

  for (const name of orphans) {
    try {
      await removeContainerVerified(name, opts);
      result.removed.push(name);
    } catch (err) {
      opts.debug?.(`[runtime] orphan container ${name} not removed: ${String(err)}`);
      result.failed.push(name);
    }
  }
  return result;
}

/**
 * Host port → orphan container holding it. The port probe reclaims these
 * instead of steering around them. Empty when docker did not answer.
 */
export async function orphanContainersByPort(
  store: Store,
  opts: OrphanContainerOptions = {},
): Promise<Map<number, string>> {
  const byPort = new Map<number, string>();
  const containers = await listTicketContainers(opts);
  if (containers === null) return byPort;
  const live = liveContainerNames(store);
  for (const c of containers) {
    if (live.has(c.name)) continue;
    for (const port of c.ports) byPort.set(port, c.name);
  }
  return byPort;
}

/**
 * Is `name` a running container? `undefined` when docker did not answer —
 * absence of evidence is not evidence the container is gone.
 */
export async function isContainerRunning(
  name: string,
  opts: OrphanContainerOptions = {},
): Promise<boolean | undefined> {
  const spawnFn = opts.spawnFn ?? spawn;
  const exec = opts.commandOutput ?? ((...args) => commandOutput(...args));
  const out = await exec(
    'docker',
    ['ps', '-q', '--filter', `name=^/${name}$`],
    LIST_TIMEOUT_MS,
    spawnFn,
  );
  if (out === null) return undefined;
  return out.trim() !== '';
}
