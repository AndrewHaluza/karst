import { join } from 'node:path';

import type { Store } from '../../store/db.js';
import { sweepHookSettings } from '../../agent/settingsSweep.js';
import { reapStaleServers, describeReap } from '../../runtime/worktreeServers.js';
import { reconcileStageRuns, describeStaleStageRun } from '../../store/stageRuns.js';
import { reconcileProcessRuns, describeStaleProcessRun } from '../../store/processRuns.js';
import { reconcileShipRuns, describeStaleShipRun } from '../../store/shipRuns.js';
import { reconcileStrandedFixRounds, describeStrandedFixRound } from '../../store/recoveryRounds.js';
import { compactArchivedWorktrees } from '../../runtime/archiveBulk.js';
import { reapClosedGraphSubtrees, describeGraphReap } from '../../approaches/graph/retention.js';
import { reapOrphanedArtifactDirs, describeArtifactReap } from '../../runtime/artifactOrphans.js';
import { getProjectBySlug } from '../../store/projects.js';
import { getTicket } from '../../store/tickets.js';
import { allGraphRunsClosed } from '../../store/graph/graphRuns.js';
import { defaultGitRunner } from '../../integrations/git.js';
import { pidAlive } from '../../runtime/pidAlive.js';
import { reconcileOnStart } from '../../recovery/reconcile.js';
import { isPortOpen } from '../../runtime/portConflict.js';
import { removeContainer } from '../../runtime/dockerContainer.js';

export interface BootSweepDeps {
  store: Store;
  /** `context.globalStorageUri.fsPath` — already a plain string at the call site. */
  globalStorageRoot: string;
  info: (message: string) => void;
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
}

export interface BootSweepResult {
  /**
   * Tickets whose stranded `fixing` round this sweep interrupted. The
   * activation-sweep drive in `extension.ts` reopens these within budget.
   */
  strandedFixResumes: Set<number>;
}

export async function runBootSweeps(deps: BootSweepDeps): Promise<BootSweepResult> {
  // Each launch writes a hook-settings file named after this window's ephemeral
  // port, so stale ones pile up. Best-effort, never fatal.
  try {
    const swept = sweepHookSettings(deps.globalStorageRoot);
    if (swept > 0) deps.info(`karst: swept ${swept} stale hook-settings file(s)`);
  } catch (err) {
    deps.logError('karst: hook-settings sweep failed', err);
  }
  // Stale-server sweep: a hot service whose working directory is gone cannot be
  // serving anything valid, yet it keeps its port bound and its memory held —
  // detached, reparented to init, unreachable by any hangup (869ed2n50).
  // `removeWorktree` reaps the servers it removes the tree out from under, so
  // this covers only what that cannot see: an already-leaked process from an
  // older build, and a worktree removed by something other than karst (a hand-run
  // `git worktree remove`, the IDE's git extension, an `rm -rf`). Reported, never
  // silent — waste nothing surfaces is how two ~1 GB servers ran for three days.
  //
  // GLOBAL, not project-scoped, for the same reason `reconcileOnStart`'s server
  // pass is: the registry is shared by every window, and a server serving a
  // deleted tree is wrong in whichever project owns it — scoping the sweep would
  // leave it running until that project's window happened to open, which for an
  // abandoned project is never. What makes that safe is not the scope but the
  // attribution: `serverIdentity.ts` requires evidence that the live pid is
  // still the recorded server, so this can never signal another window's live
  // process, let alone a stranger's. Rows it cannot attribute are cleared, not
  // killed, and every line says which path it acted on.
  try {
    for (const s of reapStaleServers(deps.store, {
      debug: (message) => deps.debug(message),
    })) deps.info(describeReap(s));
  } catch (err) {
    deps.logError('karst: stale-server sweep failed', err);
  }
  // Boot reconcile — deliberately AFTER the stale-server sweep above. It
  // re-derives every ticket's cached `stage_current` from its stage rows (the
  // invariant this restores) and retires a `servers` row that is only claiming
  // to run.
  //
  // Retirement is not "the recorded pid is gone", though — a recorded pid is a
  // recollection, never proof. A launcher that daemonises (`docker compose up
  // -d`, `spawn(..., { detached: true }).unref()`) exits 0 and records ITS pid
  // while the process it left behind — in a group of its own — keeps serving;
  // retiring that row would report a live service dead and flip it offline on
  // every activation. So a pid whose port is still bound is treated as alive and
  // left for the attributed paths (`reapStaleServers` above, `stopServer`).
  //
  // Running this AFTER the stale-server sweep matters for the container half: a
  // retired row is invisible to `reapStaleServers` (it selects `running` rows
  // only), so the directory-gone sweep must get its chance first, and every row
  // this retires has its container removed here — the name is still a valid
  // handle when the pid no longer is.
  //
  // The stage half of this pass is GLOBAL too, so it must not park a `running`
  // confirm stage another live window is executing: a `ship` a `ship_runs` row
  // still claims is left for the pid-attributed run sweeps below, not healed
  // here (`recovery/reconcile.ts:hasRunningRun`).
  //
  // Reported, never silent — a server that died while the window was closed is
  // a fact the user needs, and it comes back as an offline, restartable row.
  try {
    const serving = await pidsStillServing(deps.store);
    const isAlive = (pid: number): boolean => pidAlive(pid) || serving.has(pid);
    for (const s of reconcileOnStart(deps.store, isAlive).deadServers) {
      const container = containerOf(deps.store, s.id);
      if (container) removeContainer(container);
      deps.info(
        `karst: '${s.service}' is no longer running (pid ${s.pid ?? 'unknown'})` +
          `${s.ticketId === null ? '' : ` on ticket #${s.ticketId}`} — marked offline.`,
      );
    }
  } catch (err) {
    deps.logError('karst: boot reconcile failed', err);
  }
  // Stale gate-run sweep (F3). A gate run is now opened durably before its first
  // gate starts, so a run whose extension host died mid-flight is still on
  // record as `running` — a state nothing can leave on its own, since process
  // death fires no abort signal and the `stopped` path therefore never ran.
  // Marking it `stale` is what turns "a stage that has been running for 37
  // minutes with nothing to show" into "the previous run was destroyed; this is
  // a fresh one", with the destroyed run's partial gate rows still readable.
  //
  // GLOBAL for the same reason as the server pass above, and safe for the same
  // reason: attribution, not scope. A run opened by ANOTHER LIVE window has a
  // live pid and is left strictly alone; a run with no recorded pid is left
  // alone too, because absence of evidence is not evidence that it died.
  //
  // Reported, never silent — an invisibly discarded run is the whole failure
  // this closes, and a sweep that quietly corrected the data would repeat it.
  try {
    for (const s of reconcileStageRuns(deps.store, pidAlive)) {
      deps.info(describeStaleStageRun(s));
    }
  } catch (err) {
    deps.logError('karst: stale gate-run sweep failed', err);
  }
  // Stale process-run sweep (inside redesign). The inside view renders a stage
  // as processes opened durably before they start, so a process whose
  // extension host died mid-flight is still on record as `running` — a state
  // nothing can leave on its own, since process death fires no abort signal.
  // Marking it `stale` is what turns a process that will never finish into the
  // record that it was destroyed, with its identity snapshot still readable.
  //
  // GLOBAL for the same reason as the gate-run pass above, and safe for the
  // same reason: attribution, not scope. A run opened by ANOTHER LIVE window
  // has a live pid and is left strictly alone; a run with no recorded pid is
  // left alone too, because absence of evidence is not evidence that it died.
  //
  // Reported, never silent — an invisibly-discarded run is the whole failure
  // this closes, and a sweep that quietly corrected the data would repeat it.
  try {
    for (const r of reconcileProcessRuns(deps.store, pidAlive)) {
      deps.info(describeStaleProcessRun(r));
    }
  } catch (err) {
    deps.logError('karst: stale process-run sweep failed', err);
  }
  // Stale ship-run sweep (869egdr2u-fu1 follow-up). A ship run killed by
  // process death mid-saga — the host died between opening the run and closing
  // it — is a state nothing can leave on its own: the saga's crash-and-retry
  // reconciliation only runs at the start of the next `shipTicket` invocation,
  // and a ticket at `ship` `running` with no block offers no retry anywhere
  // (the Now line shows no button for a running ship, and the driver only
  // auto-runs gates). Marking the dead run `interrupted` and parking the
  // stage `failed` is what turns that stuck state into the one that already
  // has a recovery path: the failed-ship surface's "Retry ship".
  //
  // GLOBAL for the same reason as the gate-run pass above, and safe for the
  // same reason: attribution, not scope. A run opened by ANOTHER LIVE window
  // has a live pid and is left strictly alone; a run with no recorded pid is
  // left alone too, because absence of evidence is not evidence that it died.
  //
  // Reported, never silent — an invisibly-discarded run is the whole failure
  // this closes, and a sweep that quietly corrected the data would repeat it.
  try {
    for (const s of reconcileShipRuns(deps.store, pidAlive, new Date().toISOString())) {
      deps.info(describeStaleShipRun(s));
    }
  } catch (err) {
    deps.logError('karst: stale ship-run sweep failed', err);
  }
  // Stranded fix-execution sweep. Runs AFTER the process-run pass above, which
  // is what turns a destroyed Fix run into a non-`running` row this can read:
  // a `fixing` recovery round whose execution is gone is a round nothing can
  // ever leave, and the driver answers it with "already in flight; leaving it"
  // on every trigger. Interrupting it puts the ticket back where a human can
  // act on it instead of watching a fix elapse for hours.
  //
  // Tickets whose round this sweep just interrupted are collected for the
  // activation-sweep drive below: the driver reopens the round within budget
  // and resumes the fix instead of leaving the ticket parked at fix forever.
  const strandedFixResumes = new Set<number>();
  try {
    for (const s of reconcileStrandedFixRounds(deps.store, new Date().toISOString())) {
      deps.info(describeStrandedFixRound(s));
      if (s.kind === 'execution') strandedFixResumes.add(s.ticketId);
    }
  } catch (err) {
    deps.logError('karst: stranded fix-round sweep failed', err);
  }
  // Auto-compact: compact archived worktrees older than 7 days and sweep
  // orphan branches/refs. Rides the activation sweep like autoArchiveDoneTickets
  // — once per activation, no second interval to dispose. The compact function
  // includes the orphan-ref sweep internally.
  try {
    const compactResult = await compactArchivedWorktrees(defaultGitRunner, deps.store, 7 * 24 * 60 * 60 * 1000);
    if (compactResult.compacted > 0 || compactResult.sweep.prunedBranches > 0 || compactResult.sweep.prunedArchiveRefs > 0) {
      deps.info(
        `karst: auto-compact compacted ${compactResult.compacted} archive(s), ` +
          `swept ${compactResult.sweep.prunedBranches} orphan branch(es), ` +
          `${compactResult.sweep.prunedArchiveRefs} orphan ref(s)`,
      );
    }
  } catch (err) {
    deps.logError('karst: auto-compact failed', err);
  }
  // Graph byte-subtree and artifact-dir orphan sweeps. A ticket's graph
  // subtree and gate console-log dir are removed on hard delete, but bytes can
  // outlive the delete that should have removed them: a delete that predates
  // this wiring, an unbound project at delete time, or a foreign removal. Both
  // live in global storage OUTSIDE every worktree, so — like `reapStaleServers`
  // and for the same reason — the net is an activation sweep, GLOBAL across
  // projects, and its predicate is a READ over state the registry already
  // keeps current. A subtree whose ticket is gone (or whose every graph run is
  // `closed`) and a console dir whose ticket no longer exists are removed;
  // anything whose ticket still exists is left strictly alone. Reported, never
  // silent — unreported removal of evidence bytes is the failure this closes.
  try {
    for (const r of reapClosedGraphSubtrees(
      join(deps.globalStorageRoot, 'graph'),
      {
        ticketExists: (projectSlug, ticketId) => {
          const project = getProjectBySlug(deps.store, projectSlug);
          if (!project) return false;
          try {
            return getTicket(deps.store, ticketId).projectId === project.id;
          } catch {
            return false;
          }
        },
        allGraphRunsClosed: (ticketId) => allGraphRunsClosed(deps.store.db, ticketId),
      },
    ).removed) {
      deps.info(describeGraphReap(r));
    }
  } catch (err) {
    deps.logError('karst: graph byte-subtree sweep failed', err);
  }
  try {
    for (const ticketId of reapOrphanedArtifactDirs(
      join(deps.globalStorageRoot, 'artifacts'),
      {
        ticketExists: (ticketId) => {
          try {
            getTicket(deps.store, ticketId);
            return true;
          } catch {
            return false;
          }
        },
      },
    ).removed) {
      deps.info(describeArtifactReap(ticketId));
    }
  } catch (err) {
    deps.logError('karst: artifact-dir orphan sweep failed', err);
  }
  return { strandedFixResumes };
}

/**
 * Recorded pids whose PORT is still bound even though the pid itself is gone.
 *
 * A launcher that daemonises (`docker compose up -d`, `spawn(..., { detached:
 * true }).unref()`) exits 0 and records its own pid, while the process it left
 * behind — in a group of its own — keeps serving. `reconcileOnStart` retires a
 * row whose pid is not alive, so without this a live service would be reported
 * dead and flipped offline on every activation. A bound port is evidence the
 * service is still up; absence of a pid is not evidence it is down.
 */
async function pidsStillServing(store: Store): Promise<Set<number>> {
  const rows = store.db
    .prepare("SELECT pid, host, port FROM servers WHERE status = 'running' AND pid IS NOT NULL")
    .all() as { pid: number; host: string | null; port: number | null }[];
  const serving = new Set<number>();
  for (const row of rows) {
    if (pidAlive(row.pid)) continue;
    // Not every `running` row is a service with an address: a graph agent
    // session shares this table and records no host or port. `net.connect`
    // rejects synchronously on a null port, so probing one would throw out of
    // this loop — taking the whole dead-pid reconcile with it, which is the
    // pass this ticket exists to wire. A row with no address cannot be probed;
    // its dead pid is retired by the reconcile exactly like any other.
    if (row.host === null || row.port === null) continue;
    if (await isPortOpen(row.host, row.port)) serving.add(row.pid);
  }
  return serving;
}

/** The container a server row names, if any — removed when its row is retired. */
function containerOf(store: Store, id: number): string | null {
  const row = store.db.prepare('SELECT container FROM servers WHERE id = ?').get(id) as
    | { container: string | null }
    | undefined;
  return row?.container ?? null;
}
