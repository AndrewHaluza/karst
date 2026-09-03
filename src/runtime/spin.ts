import { join } from 'node:path';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { resolvePlannedBaseRef } from '../workflow/baseRef.js';
import { makePortAllocator, type PortAllocator } from '../resolver/allocator.js';
import { resolve } from '../resolver/resolve.js';
import { createWorktree, removeWorktree, type WorktreeRecord } from './worktree.js';
import { buildSpawnEnv } from './env.js';
import { ensureBaseline, addBaselineRef } from './baseline.js';
import {
  startHot,
  stopServer,
  stopTicketServers,
  pruneOrphanServers,
  type ServerRecord,
} from './supervisor.js';
import { renderHealthUrl } from './healthUrl.js';
import { serverLogPath } from './serverLog.js';
import { preflightSpin } from './preflight.js';
import { portsToAvoid } from './portProbe.js';
import { getTicket } from '../store/tickets.js';
import { ticketWorktreeNames } from './ticketBranch.js';
import { isRunnable } from '../manifest/runnable.js';

export interface SpinResult {
  servers: ServerRecord[];
  /**
   * Pids of processes karst killed to free the allocated ports — conflicting
   * dev servers of the repository, or karst-recorded servers of other tickets.
   * The caller REPORTS these: a killed dev server is the user's own process.
   */
  reclaimedPids: number[];
}

export interface SpinOptions {
  /** Abort a running spin (cancel button); triggers teardown of this run's work. */
  signal?: AbortSignal;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[runtime]`.
   * Absent → no debug lines; the host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on).
   */
  debug?: (message: string) => void;
  /**
   * Live-listener discovery for the allocator, injected so tests never depend on
   * this machine's open ports. Defaults to `runtime/portProbe.ts`.
   */
  probeBusyPorts?: (
    host: string,
    ranges: readonly (readonly [number, number])[],
    repoPaths: readonly string[],
  ) => Promise<Set<number>>;
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

/**
 * Every port window this spin's allocator may draw from: the manifest range,
 * plus the per-service `portRange` override of each hot runnable repo. Probing
 * only the manifest range would leave an overriding service allocating blind —
 * exactly the service most likely to have a range of its own because something
 * else lives near it.
 */
export function allocationRanges(manifest: Manifest, hot: readonly string[]): [number, number][] {
  const ranges: [number, number][] = [manifest.portRange];
  for (const name of hot) {
    const repo = manifest.repositories[name];
    if (repo && isRunnable(repo) && repo.service.portRange) ranges.push(repo.service.portRange);
  }
  return ranges;
}

/**
 * The repository roots this spin may reclaim a port inside — deduped, since
 * entries sharing a `repoPath` are one checkout. A dev server under any of them
 * is `startHot`'s to kill, which is what makes its port allocatable.
 */
export function hotRepoPaths(manifest: Manifest, hot: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const name of hot) {
    const repo = manifest.repositories[name];
    if (repo) paths.add(repo.repoPath);
  }
  return [...paths];
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
  const debug = opts.debug;
  const bail = (): void => {
    if (signal?.aborted) throw new SpinCancelledError(ticketId);
  };

  // One rename-invariant slug per ticket (key-or-id + title) and one rendered
  // branch name; all worktrees for this ticket share both, so the worktree loop
  // below dedups by repo.
  const ticket = getTicket(store, ticketId);
  const { slug, branch } = ticketWorktreeNames(ticket, manifest);

  // Validate every hot repo (git repo + has baselineBranch) before any mutation,
  // so a bad branch/path fails fast with a friendly SpinError and nothing partial.
  preflightSpin(manifest, slug, hot, branch, ticket);

  // Ports something is LISTENING on cannot be allocated, whatever the registry
  // says: a leaked server from a worktree nobody will spin again, or a process
  // started outside karst, holds a port `port_allocations` calls free, and the
  // spin that draws it dies of EADDRINUSE inside the child — where the only
  // symptom is a health check that never passes. Every window the allocator may
  // draw from is probed: the manifest range plus each hot service's own
  // override. Best-effort and bounded (`runtime/portProbe.ts`) — a probe that
  // cannot answer must never be the reason a spin does not start.
  const probe =
    opts.probeBusyPorts ??
    ((host, ranges, repoPaths) => portsToAvoid(store, host, ranges, repoPaths, { debug }));
  const busy = await probe(manifest.host, allocationRanges(manifest, hot), hotRepoPaths(manifest, hot));
  if (busy.size > 0) {
    debug?.(
      `[runtime] ticket ${ticketId}: ${busy.size} occupied port(s) excluded from allocation`,
    );
  }
  const allocator = makePortAllocator(store, manifest.portRange, { busy });
  // Stop any servers a prior spin left running for this ticket BEFORE releasing
  // ports. Otherwise the old process keeps its port bound while release() frees
  // the row, re-resolve re-picks the same port, and startHot spawns a second
  // server fighting the first — the "retry makes a duplicate on the same port"
  // bug. killTree reaps the whole tree (launcher + Vite grandchild).
  stopTicketServers(store, ticketId);
  // Then drop the rows whose repository the manifest no longer declares. A
  // rename re-keys the registry (servers are keyed by repository NAME), so the
  // pre-rename row is unreachable — no spin can start a manifest key that is
  // gone — yet it kept rendering as an offline server beside the new name. Runs
  // AFTER the stop above so a row is never deleted out from under a live pid.
  pruneOrphanServers(store, ticketId, Object.keys(manifest.repositories));
  // Clean-slate the ticket's transient allocations so a retry (a prior spin that
  // died mid-way) re-resolves fresh instead of double-inserting ports — the
  // worktree it already created is adopted by createWorktree, baseline_refs is
  // INSERT OR IGNORE, so ports are the only leftover that needs releasing here.
  allocator.release(ticketId);
  const resolved = resolve(manifest, hot, allocator, ticketId);

  // Track what this run creates so cancel / mid-way failure can undo exactly it.
  const created: WorktreeRecord[] = [];
  const servers: ServerRecord[] = [];
  const reclaimedPids: number[] = [];

  try {
    bail();

    // 1. one worktree per hot REPOPATH — INCLUDING repositories that declare no
    //    service. A non-runnable repo is still edited by the agent, so it needs
    //    its branch; it just never reaches step 3. Repository entries may share
    //    a repoPath (a monorepo with several runnable processes), and the
    //    worktree slug is per-TICKET, so those entries intentionally map to one
    //    worktree — dedup here, or the second `createWorktree` call would just
    //    redundantly adopt what the first created.
    const worktreePath: Record<string, string> = {};
    const worktreeByRepo = new Map<string, WorktreeRecord>();
    for (const name of hot) {
      bail();
      const repo = manifest.repositories[name]!;
      let wt = worktreeByRepo.get(repo.repoPath);
      if (!wt) {
        wt = createWorktree(store, {
          ticketId,
          repoPath: repo.repoPath,
          slug,
          branch,
          baseRef: resolvePlannedBaseRef(ticket, manifest, name),
        });
        worktreeByRepo.set(repo.repoPath, wt);
        created.push(wt);
        debug?.(
          `[runtime] ticket ${ticketId}: created worktree for ${name} at ${wt.path} ` +
            `(${wt.adopted ? 'adopted existing' : 'fresh'})`,
        );
      } else {
        debug?.(`[runtime] ticket ${ticketId}: ${name} shares worktree ${wt.path} — deduped`);
      }
      worktreePath[name] = wt.path;
    }

    // 2. ensure every baseline dependency is up + record the ref edge.
    const baselineDeps = new Set<string>();
    for (const name of hot) {
      // Non-runnable repos have no resolver entry and therefore no dependencies.
      for (const dep of resolved.services[name]?.baselineDeps ?? []) baselineDeps.add(dep);
    }
    debug?.(
      `[runtime] ticket ${ticketId}: resolved ${hot.length} repo(s) into ` +
        `${Object.keys(worktreePath).length} worktree(s); ${baselineDeps.size} baseline dep(s)`,
    );
    for (const dep of baselineDeps) {
      bail();
      debug?.(`[runtime] ticket ${ticketId}: ensuring baseline dep ${dep}`);
      await ensureBaseline(store, manifest, dep);
      addBaselineRef(store, ticketId, dep);
    }

    // 3. start hot services in dependency-first order, health-gating each.
    for (const name of resolved.startOrder) {
      bail();
      const repo = manifest.repositories[name]!;
      // startOrder is built from runnable repos only, so this never fires; the
      // guard is what lets the compiler drop the old `!` on start/ports.
      if (!isRunnable(repo)) continue;
      const service = repo.service;
      const cwd = worktreePath[name]!;
      const resolvedSvc = resolved.services[name]!;

      const spawnEnv = buildSpawnEnv(join(repo.repoPath, '.env'), resolvedSvc.env);
      // Expand ${PORT}-style tokens against the resolved env so a manifest can
      // pin the port in the command (independent of the worktree's own config).
      const { command, args } = splitCommand(expandEnvTokens(service.start, spawnEnv));
      const httpSlot = service.ports.find((p) => p.name === 'http') ?? service.ports[0]!;
      const ownPort = resolvedSvc.ports[httpSlot.name]!;
      const healthUrl = service.health
        ? renderHealthUrl(service.health, manifest.host, ownPort)
        : `http://${manifest.host}:${ownPort}/health`;

      debug?.(
        `[runtime] ticket ${ticketId}: starting ${name} (port ${ownPort}, cwd ${cwd})`,
      );
      const rec = await startHot(store, {
        ticketId,
        service: name,
        command,
        args,
        cwd,
        env: spawnEnv,
        host: manifest.host,
        port: ownPort,
        healthUrl,
        logPath: serverLogPath(cwd, name),
        repoPath: repo.repoPath,
        signal,
        onReclaim: (pid) => reclaimedPids.push(pid),
        debug,
      });
      servers.push(rec);
      debug?.(`[runtime] ticket ${ticketId}: ${name} healthy (pid ${rec.pid})`);
    }

    return { servers, reclaimedPids };
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
