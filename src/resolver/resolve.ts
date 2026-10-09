import type { Manifest } from '../manifest/types.js';
import { nonRunnableNames, resolveTarget, serviceUnits, unitsOfRepos, type ServiceUnit } from '../manifest/runnable.js';
import type { PortAllocator } from './allocator.js';
import type { ResolveResult, ResolvedService, ServiceMode } from './types.js';

export type { ResolveResult, ResolvedService } from './types.js';

export class DependencyCycleError extends Error {
  constructor(services: string[]) {
    super(`dependency cycle among hot services: ${services.join(' → ')}`);
    this.name = 'DependencyCycleError';
  }
}

/** Render a bind template, substituting {host} and {port}. */
function renderTemplate(template: string, host: string, port: number): string {
  return template
    .replaceAll('{host}', host)
    .replaceAll('{port}', String(port));
}

/**
 * The unit a `dependsOn.target` (`repo` or `repo/service`) names. Graph
 * validation guarantees it resolves; throw loudly anyway so a hand-built
 * manifest fails here, not as a silent mis-wire.
 */
function targetUnit(manifest: Manifest, target: string): ServiceUnit {
  const r = resolveTarget(manifest.repositories, target);
  if ('error' in r) throw new Error(`dependsOn target "${target}" ${r.error}`);
  return r.unit;
}

/**
 * The effective port a dependent should reference for `target`:
 * hot target → its allocated port; baseline target → the slot's default.
 */
function effectivePort(
  target: ServiceUnit,
  portName: string,
  hotPorts: Record<string, Record<string, number>>,
): number {
  const allocated = hotPorts[target.key]?.[portName];
  if (allocated !== undefined) return allocated;
  const slot = target.def.ports.find((p) => p.name === portName);
  if (!slot) {
    throw new Error(`service "${target.key}" has no runnable port slot "${portName}"`);
  }
  return slot.default;
}

/**
 * Topological order over hot units, edges = hot→hot dependencies only
 * (dependency before dependent). Throws DependencyCycleError on a cycle.
 */
function topoSort(hot: string[], units: Record<string, ServiceUnit>, manifest: Manifest): string[] {
  const hotSet = new Set(hot);
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const order: string[] = [];

  function visit(key: string): void {
    if (visited.has(key)) return;
    if (onStack.has(key)) {
      throw new DependencyCycleError([...onStack, key]);
    }
    onStack.add(key);
    for (const dep of units[key]!.def.dependsOn) {
      const depKey = targetUnit(manifest, dep.target).key;
      if (hotSet.has(depKey)) visit(depKey); // only hot→hot edges gate order
    }
    onStack.delete(key);
    visited.add(key);
    order.push(key); // dependencies pushed before dependents
  }

  for (const key of hot) visit(key);
  return order;
}

/**
 * Resolve a manifest + hot set into per-service port allocations and fully
 * resolved env (§7.2). Pure: the allocator is injected. This is the
 * silent-failure surface — misconfig here produces a stack wired to the wrong
 * port with no error, so it is covered hard.
 */
export function resolve(
  manifest: Manifest,
  hot: string[],
  allocator: PortAllocator,
  ticketId: number,
): ResolveResult {
  // A hot repository that declares no service is a legitimate scope member — it
  // gets a worktree so the agent can edit it — but there is nothing to allocate
  // a port for or to start. Narrow once, here, so no step below has to re-ask.
  for (const name of hot) {
    if (!manifest.repositories[name]) {
      throw new Error(`hot repository "${name}" not in manifest`);
    }
  }
  // The hot set is REPOSITORIES (scope); the runtime addresses UNITS — a repo
  // with a `services:` map contributes one per service, all in its one worktree.
  const hotUnits = unitsOfRepos(manifest, hot);
  const hotSet = new Set(hotUnits.map((u) => u.key));

  // Step 1: allocate alt ports for each hot unit's owned slots. A service with
  // its own portRange allocates ONLY from that window; the rest use the
  // manifest-global range. The allocator's shared used-set keeps every window
  // unique against every other, so overlapping ranges (and sibling services of
  // one repo) cannot double-book.
  const hotPorts: Record<string, Record<string, number>> = {};
  for (const unit of hotUnits) {
    hotPorts[unit.key] = allocator.allocate(
      ticketId,
      unit.key,
      unit.def.ports.map((p) => p.name),
      unit.def.portRange ?? manifest.portRange,
    );
  }

  const services: Record<string, ResolvedService> = {};
  const units: Record<string, ServiceUnit> = {};

  for (const unit of serviceUnits(manifest)) {
    const key = unit.key;
    units[key] = unit;
    const mode: ServiceMode = hotSet.has(key) ? 'hot' : 'baseline';
    const ports: Record<string, number> = {};
    const env: Record<string, string> = {};
    const baselineDeps: string[] = [];

    // own ports: hot → allocated, baseline → default
    for (const slot of unit.def.ports) {
      const port = mode === 'hot' ? hotPorts[key]![slot.name]! : slot.default;
      ports[slot.name] = port;
      if (mode === 'hot') env[slot.env] = String(port); // only hot svcs get injected env
    }

    // peer-reference env from dependsOn edges (only meaningful for hot services;
    // a baseline service runs from develop and isn't repointed by us)
    if (mode === 'hot') {
      for (const dep of unit.def.dependsOn) {
        const target = targetUnit(manifest, dep.target);
        const port = effectivePort(target, dep.port, hotPorts);
        for (const b of dep.bind) {
          env[b.env] = renderTemplate(b.template, manifest.host, port);
        }
        if (!hotSet.has(target.key)) baselineDeps.push(target.key);
      }
    }

    services[key] = { mode, ports, env, baselineDeps };
  }

  // startOrder is runnable-only BY CONSTRUCTION, so spin's start loop can never
  // reach a repository with no start command.
  const startOrder = topoSort([...hotSet], units, manifest);

  return { services, nonRunnable: nonRunnableNames(manifest), startOrder };
}
