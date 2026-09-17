import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { isRunnable } from '../manifest/runnable.js';
import { resolve } from '../resolver/resolve.js';
import { makeRecordedPortAllocator } from '../resolver/recordedAllocator.js';
import { startResolvedService } from './startService.js';
import { getEnvOverrides } from '../store/ticketEnvOverrides.js';
import { stopServer, type ServerRecord } from './supervisor.js';

/**
 * Start exactly one already-spun service of a ticket — the host-agnostic
 * operation behind the dashboard Servers panel's per-row Start/Restart.
 *
 * Three invariants this path preserves:
 *
 *  - No other service is stopped. Only the named repo's own `running` row is
 *    retired; every peer's row and process is left exactly as it was.
 *  - No port is reallocated. `resolve` is replayed over the ticket's whole hot
 *    set with `makeRecordedPortAllocator`, so the service and its peers keep the
 *    ports already recorded in `port_allocations`. Re-resolving with fresh ports
 *    would repoint one service while its peers keep the old URL in their env.
 *  - No worktree is created or removed. The service starts in its recorded
 *    worktree; a missing one is a typed failure telling the user to spin.
 *
 * `spinTicket` is deliberately NOT reused: it stops EVERY server of the ticket,
 * releases and reallocates every port, and re-creates worktrees. Calling it with
 * a single-element hot set would still stop the user's other running services
 * and re-port them.
 */
export class StartServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartServiceError';
  }
}

export interface StartTicketServiceOpts {
  signal?: AbortSignal;
  onReclaim?: (pid: number) => void;
  debug?: (message: string) => void;
}

export async function startTicketService(
  store: Store,
  manifest: Manifest,
  ticketId: number,
  repoName: string,
  opts: StartTicketServiceOpts = {},
): Promise<ServerRecord> {
  opts.debug?.(`[runtime] ticket ${ticketId}: row-start requested for ${repoName}`);
  const repo = manifest.repositories[repoName];
  if (repo === undefined) {
    throw new StartServiceError(`"${repoName}" is no longer in the manifest — re-spin the ticket.`);
  }
  if (!isRunnable(repo)) {
    throw new StartServiceError(`"${repoName}" declares no service — there is nothing to start.`);
  }

  const wtRows = store.db
    .prepare('SELECT repo, path FROM worktrees WHERE ticket_id = ?')
    .all(ticketId) as { repo: string; path: string }[];
  // `worktrees.repo` stores the repository PATH (see `createWorktree`), while
  // the manifest is keyed by NAME — so map the name to its repoPath before the
  // lookup, or every start would report "no worktree".
  const pathByRepo = new Map(wtRows.map((r) => [r.repo, r.path]));
  const cwd = pathByRepo.get(repo.repoPath);
  if (cwd === undefined) {
    throw new StartServiceError(
      `"${repoName}" has no worktree for this ticket — spin the ticket first.`,
    );
  }

  // The hot set is the ticket's RECORDED allocations, not its worktree rows:
  // `port_allocations.repo` is the manifest name, and a port that was released
  // is not one we may reuse. Requiring an allocation for a peer that no longer
  // has one would block starting the target for no reason; a peer that still
  // has its recording keeps its exact port in every dependent's env. Only the
  // TARGET's own missing allocation is fatal (the allocator throws below).
  const allocatedRepos = store.db
    .prepare('SELECT DISTINCT repo FROM port_allocations WHERE ticket_id = ?')
    .all(ticketId) as { repo: string }[];
  const hot = allocatedRepos
    .map((r) => r.repo)
    .filter((name) => manifest.repositories[name] !== undefined);
  if (!hot.includes(repoName)) hot.push(repoName);

  const runningRow = store.db
    .prepare("SELECT id FROM servers WHERE ticket_id = ? AND repo = ? AND status = 'running'")
    .get(ticketId, repoName) as { id: number } | undefined;
  if (runningRow) {
    opts.debug?.(
      `[runtime] ticket ${ticketId}: stopping ${repoName} (server ${runningRow.id}) before restart`,
    );
    await stopServer(store, runningRow.id);
  }

  const allocator = makeRecordedPortAllocator(store, ticketId);
  const resolved = resolve(manifest, hot, allocator, ticketId);
  const envOverrides = getEnvOverrides(store, ticketId);
  const rec = await startResolvedService({
    store,
    manifest,
    ticketId,
    name: repoName,
    resolved,
    cwd,
    envOverrides,
    signal: opts.signal,
    onReclaim: opts.onReclaim,
    debug: opts.debug,
  });
  opts.debug?.(`[runtime] ticket ${ticketId}: ${repoName} healthy (pid ${rec.pid})`);
  return rec;
}
