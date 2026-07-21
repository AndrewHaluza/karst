import type { Manifest } from '../manifest/types.js';
import { isRunnable, nonRunnableNames, runnableEntries, runnableSubset, type RunnableRepo } from '../manifest/runnable.js';
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
 * The effective port a dependent should reference for `target`:
 * hot target → its allocated port; baseline target → the slot's default.
 */
function effectivePort(
  target: string,
  portName: string,
  hotPorts: Record<string, Record<string, number>>,
  manifest: Manifest,
): number {
  const allocated = hotPorts[target]?.[portName];
  if (allocated !== undefined) return allocated;
  const slot = manifest.repositories[target]?.service?.ports.find((p) => p.name === portName);
  // Graph validation guarantees the target is runnable and owns this slot;
  // guard defensively anyway so a hand-built manifest fails loudly, not silently.
  if (!slot) {
    throw new Error(`repository "${target}" has no runnable port slot "${portName}"`);
  }
  return slot.default;
}

/**
 * Topological order over hot services, edges = hot→hot dependencies only
 * (dependency before dependent). Throws DependencyCycleError on a cycle.
 */
function topoSort(hot: string[], services: Record<string, RunnableRepo>): string[] {
  const hotSet = new Set(hot);
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const order: string[] = [];

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (onStack.has(name)) {
      throw new DependencyCycleError([...onStack, name]);
    }
    onStack.add(name);
    const repo = services[name]!;
    for (const dep of repo.service.dependsOn) {
      if (hotSet.has(dep.target)) visit(dep.target); // only hot→hot edges gate order
    }
    onStack.delete(name);
    visited.add(name);
    order.push(name); // dependencies pushed before dependents
  }

  for (const name of hot) visit(name);
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
  const hotRunnable = runnableSubset(manifest, hot);
  const hotSet = new Set(hotRunnable);

  // Step 1: allocate alt ports for each hot service's owned slots.
  const hotPorts: Record<string, Record<string, number>> = {};
  for (const name of hotRunnable) {
    const repo = manifest.repositories[name]!;
    if (!isRunnable(repo)) continue; // unreachable: runnableSubset already filtered
    const slots = repo.service.ports.map((p) => p.name);
    hotPorts[name] = allocator.allocate(ticketId, name, slots);
  }

  const services: Record<string, ResolvedService> = {};
  const runnable: Record<string, RunnableRepo> = {};

  for (const [name, repo] of runnableEntries(manifest)) {
    runnable[name] = repo;
    const mode: ServiceMode = hotSet.has(name) ? 'hot' : 'baseline';
    const ports: Record<string, number> = {};
    const env: Record<string, string> = {};
    const baselineDeps: string[] = [];

    // own ports: hot → allocated, baseline → default
    for (const slot of repo.service.ports) {
      const port =
        mode === 'hot' ? hotPorts[name]![slot.name]! : slot.default;
      ports[slot.name] = port;
      if (mode === 'hot') env[slot.env] = String(port); // only hot svcs get injected env
    }

    // peer-reference env from dependsOn edges (only meaningful for hot services;
    // a baseline service runs from develop and isn't repointed by us)
    if (mode === 'hot') {
      for (const dep of repo.service.dependsOn) {
        const port = effectivePort(dep.target, dep.port, hotPorts, manifest);
        for (const b of dep.bind) {
          env[b.env] = renderTemplate(b.template, manifest.host, port);
        }
        if (!hotSet.has(dep.target)) baselineDeps.push(dep.target);
      }
    }

    services[name] = { mode, ports, env, baselineDeps };
  }

  // startOrder is runnable-only BY CONSTRUCTION, so spin's start loop can never
  // reach a repository with no start command.
  const startOrder = topoSort(hotRunnable, runnable);

  return { services, nonRunnable: nonRunnableNames(manifest), startOrder };
}
