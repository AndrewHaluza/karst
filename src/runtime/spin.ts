import { join } from 'node:path';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { makePortAllocator, type PortAllocator } from '../resolver/allocator.js';
import { resolve } from '../resolver/resolve.js';
import { createWorktree, removeWorktree, type WorktreeRecord } from './worktree.js';
import { buildSpawnEnv } from './env.js';
import { ensureBaseline, addBaselineRef } from './baseline.js';
import { startHot, stopServer, stopTicketServers, type ServerRecord } from './supervisor.js';
import { preflightSpin } from './preflight.js';
import { getTicket } from '../store/tickets.js';
import { worktreeSlug } from './slug.js';

export interface SpinResult {
  servers: ServerRecord[];
}

export interface SpinOptions {
  /** Abort a running spin (cancel button); triggers teardown of this run's work. */
  signal?: AbortSignal;
}

/**
 * A spin the user cancelled. Distinct from `SpinError` (a precondition failure)
 * so the UI can treat it quietly — no red error toast.
 */
export class SpinCancelledError extends Error {
  constructor(ticketId: number) {
    super(`spin cancelled for #${ticketId}`);
    this.name = 'SpinCancelledError';
  }
}

/**
 * Expand `${VAR}` / `$VAR` tokens in a start command against the resolved env
 * BEFORE the whitespace split, so a manifest can write the allocated port into
 * the command itself — e.g. `npm run dev -- --port ${PORT} --strictPort`. This
 * makes port binding independent of the worktree's own config: a hot worktree
 * branched before an app-side config fix still binds its allocated port. An
 * unknown token expands to empty string (mirrors shell behaviour).
 */
export function expandEnvTokens(start: string, env: Record<string, string>): string {
  return start.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, braced, bare) => env[braced ?? bare] ?? '');
}

function splitCommand(start: string): { command: string; args: string[] } {
  const parts = start.trim().split(/\s+/);
  return { command: parts[0]!, args: parts.slice(1) };
}

function renderHealth(template: string, host: string, httpPort: number): string {
  return template.replaceAll('{host}', host).replaceAll('{http}', String(httpPort));
}

/**
 * Undo what THIS spin run created (cancel or mid-way failure): stop every server
 * it started, remove only the worktrees it freshly created — an adopted leftover
 * from a prior spin is left intact — and release the ticket's port allocations.
 * Best-effort: each teardown step is isolated so one failure can't strand the rest.
 */
function teardownRun(
  store: Store,
  allocator: PortAllocator,
  ticketId: number,
  created: WorktreeRecord[],
  servers: ServerRecord[],
): void {
  for (const s of servers) {
    try {
      stopServer(store, s.id);
    } catch {
      /* best-effort */
    }
  }
  for (const wt of created) {
    if (wt.adopted) continue; // never remove a leftover the user may still want
    try {
      removeWorktree(store, wt, allocator);
    } catch {
      /* best-effort */
    }
  }
  // removeWorktree releases ports too, but call once more in case no fresh
  // worktree existed (adopted-only run) — release is idempotent (delete-by-ticket).
  try {
    allocator.release(ticketId);
  } catch {
    /* best-effort */
  }
}

/**
 * Turn a scoped ticket into a running, wired stack (§7.2 full algorithm):
 *   resolve → create hot worktrees → ensure baseline deps up → build spawn env →
 *   start hot services in topological (startOrder) order, health-gating each
 *   before the next.
 *
 * The registry is the source of truth throughout: worktrees, port_allocations,
 * baseline_refs, and servers are all written as each step completes.
 */
export async function spinTicket(
  store: Store,
  manifest: Manifest,
  ticketId: number,
  hot: string[],
  opts: SpinOptions = {},
): Promise<SpinResult> {
  const { signal } = opts;
  const bail = (): void => {
    if (signal?.aborted) throw new SpinCancelledError(ticketId);
  };

  // One rename-invariant slug per ticket (key-or-id + title); all worktrees for
  // this ticket share it, so the worktree loop below dedups by repo.
  const slug = worktreeSlug(getTicket(store, ticketId));

  // Validate every hot repo (git repo + has baselineBranch) before any mutation,
  // so a bad branch/path fails fast with a friendly SpinError and nothing partial.
  preflightSpin(manifest, slug, hot);

  const allocator = makePortAllocator(store, manifest.portRange);
  // Stop any servers a prior spin left running for this ticket BEFORE releasing
  // ports. Otherwise the old process keeps its port bound while release() frees
  // the row, re-resolve re-picks the same port, and startHot spawns a second
  // server fighting the first — the "retry makes a duplicate on the same port"
  // bug. killTree reaps the whole tree (launcher + Vite grandchild).
  stopTicketServers(store, ticketId);
  // Clean-slate the ticket's transient allocations so a retry (a prior spin that
  // died mid-way) re-resolves fresh instead of double-inserting ports — the
  // worktree it already created is adopted by createWorktree, baseline_refs is
  // INSERT OR IGNORE, so ports are the only leftover that needs releasing here.
  allocator.release(ticketId);
  const resolved = resolve(manifest, hot, allocator, ticketId);

  // Track what this run creates so cancel / mid-way failure can undo exactly it.
  const created: WorktreeRecord[] = [];
  const servers: ServerRecord[] = [];

  try {
    bail();

    // 1. create one worktree per hot repo (services sharing a repo share the
    //    worktree — one slug per ticket, deduped by repoPath).
    const worktreePath: Record<string, string> = {};
    const worktreeByRepo = new Map<string, WorktreeRecord>();
    for (const service of hot) {
      bail();
      const svc = manifest.services[service]!;
      let wt = worktreeByRepo.get(svc.repoPath);
      if (!wt) {
        wt = createWorktree(store, {
          ticketId,
          repoPath: svc.repoPath,
          slug,
          baseRef: manifest.baselineBranch,
        });
        worktreeByRepo.set(svc.repoPath, wt);
        created.push(wt);
      }
      worktreePath[service] = wt.path;
    }

    // 2. ensure every baseline dependency is up + record the ref edge.
    const baselineDeps = new Set<string>();
    for (const service of hot) {
      for (const dep of resolved.services[service]!.baselineDeps) baselineDeps.add(dep);
    }
    for (const dep of baselineDeps) {
      bail();
      await ensureBaseline(store, manifest, dep);
      addBaselineRef(store, ticketId, dep);
    }

    // 3. start hot services in dependency-first order, health-gating each.
    for (const service of resolved.startOrder) {
      bail();
      const svc = manifest.services[service]!;
      const cwd = worktreePath[service]!;
      const resolvedSvc = resolved.services[service]!;

      const spawnEnv = buildSpawnEnv(join(svc.repoPath, '.env'), resolvedSvc.env);
      // Expand ${PORT}-style tokens against the resolved env so a manifest can
      // pin the port in the command (independent of the worktree's own config).
      const { command, args } = splitCommand(expandEnvTokens(svc.start, spawnEnv));
      const httpSlot = svc.ports.find((p) => p.name === 'http') ?? svc.ports[0]!;
      const ownPort = resolvedSvc.ports[httpSlot.name]!;
      const healthUrl = svc.health
        ? renderHealth(svc.health, manifest.host, ownPort)
        : `http://${manifest.host}:${ownPort}/health`;

      const rec = await startHot(store, {
        ticketId,
        service,
        command,
        args,
        cwd,
        env: spawnEnv,
        host: manifest.host,
        port: ownPort,
        healthUrl,
        logPath: join(cwd, `${service}.log`),
        signal,
      });
      servers.push(rec);
    }

    return { servers };
  } catch (err) {
    // On cancel, undo this run's work so the ticket returns to un-spun. Other
    // errors leave partial state as-is (the caller surfaces it; a retry resumes
    // via the adopt path) — only a user cancel triggers the full teardown.
    if (err instanceof SpinCancelledError || signal?.aborted) {
      teardownRun(store, allocator, ticketId, created, servers);
      throw err instanceof SpinCancelledError ? err : new SpinCancelledError(ticketId);
    }
    throw err;
  }
}
