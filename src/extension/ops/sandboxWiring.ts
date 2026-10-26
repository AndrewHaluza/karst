import { findStrays, removeStrays } from './sandboxStrays.js';
import { NODE_DOCKER_PROCESS } from '../../agent/docker/dockerProcess.js';
import { createSandboxSessionEnder } from './sandboxSessionEnd.js';
import { readClonedWorktree } from '../../agent/clonedWorktree.js';
import type { Store } from '../../store/db.js';
import { parseDbTimeMs } from '../../doctor/applyFixes.js';
import { STUCK_IDLE_MINUTES } from '../../doctor/stuckCheck.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { resumeBlockedStage } from '../../workflow/stageResume.js';
import { getTicket, listTickets, setSessionId } from '../../store/tickets.js';
import type { AgentProvider } from '../../manifest/types.js';
import { backfillPlacement, getPlacement, recordPlacement, type TicketPlacement } from '../../store/placement.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { doneMergedTicketIds, isDoneMerged } from '../../store/doneMerged.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import type { SbxProcess } from '../../agent/sbx/sbxProcess.js';
import type { DockerProcess } from '../../agent/docker/dockerProcess.js';
import type { Notify } from './notify.js';
import { disposeSandboxOp, ensureSandboxInSync, ensureSandboxSynced, sandboxRunnerFor, stashSandboxAndUpdate, syncSandboxOp, type SandboxSyncTarget } from './sandboxSyncOps.js';
import type { SandboxInventory } from '../../agent/sandboxInventory.js';
import { pickTicketSandbox } from '../../agent/sandboxLookup.js';
import type { QueuedMarker } from '../../agent/bridge/markerFlow.js';
import { diffSandboxOp } from './sandboxDiffOp.js';
import { carrySandboxOp } from './sandboxCarryOp.js';
import { recreateSandboxNoSync, sandboxHasUnsynced } from './sandboxRebaseOps.js';
import { runSandboxReconcile } from './bootSweeps.js';
import {
  backendKindOf, cleanupOrphansOp, idleSandboxes, inventoryOf, onDoneOp, removeDoneMergedSandboxes, removeSandboxGuarded, stopSandboxOp, switchProviderOp, type Choose, type SandboxLifecycleDeps,
} from './sandboxLifecycleOps.js';

export interface SandboxWiringInput {
  readonly store: Store;
  readonly notify: Notify;
  readonly choose: Choose;
  /** `undefined` = no sandbox backend configured: every hook is a no-op. */
  readonly projectRoot: () => string | undefined;
  readonly backendOn: () => boolean;
  readonly projectId: () => number | undefined;
  readonly owned: ReadonlySet<number>;
  readonly bridges: () => {
    dispose(ticketId: number): Promise<void>;
    detach?(ticketId: number): Promise<void>;
    retryPending?(ticketId: number): Promise<void>;
    markerStatus?(ticketId: number): QueuedMarker | undefined;
  } | undefined;
  readonly openSyncDiff: (ticketId: number) => Promise<void>;
  /** Opens a unified diff in a read-only editor. */
  readonly showDiff: (title: string, diff: string) => Promise<void>;
  readonly debug?: (m: string) => void;
  readonly info: (m: string) => void;
  readonly logError: (m: string, err: unknown) => void;
  /** A ticket's terminal/session is open (never stopped under it). */
  readonly sessionOpen: (ticketId: number) => boolean;
  /** Quick pick over this project's sandboxed tickets (Command Palette); `undefined` = dismissed. */
  readonly pickTicket?: (picks: readonly { label: string; description: string; ticketId: number }[], placeHolder: string) => Promise<number | undefined>;
  /** Every listing the boot reconcile reads (after a reload the in-memory ticket→core cache is empty). */
  readonly onInventory?: (inventory: SandboxInventory) => void;
  /** Test seams; default to the real async spawns and clock. */
  readonly now?: () => number;
  readonly setInterval?: (fn: () => void, ms: number) => { dispose(): void };
  readonly proc?: SbxProcess;
  readonly dockerProc?: DockerProcess;
  /** The host-side bridge dir of a ticket (sbx hands the host's bundle through its `xfer/`, F8). */
  readonly bridgeDirOf?: (ticketId: number) => string | undefined;
  /** The ticket's current launch generation (ends an accepted sandbox session, arch:AC-37). */
  readonly launchIdFor?: (ticketId: number) => string | undefined;
  /** Reopen a ticket's sandbox session (after "Carry sandbox commits" recreated the clone). */
  readonly reopen?: (ticketId: number) => Promise<void>;
  /** Drives the ticket on after a successful Stash & update cleared its parked `sandbox-sync` block. */
  readonly redrive?: (ticketId: number) => void;
}

/** arch:AC-32 lifecycle bindings for `extension.ts`: only with a sandbox backend, only this window's tickets. */
/** How often the idle sweep looks; the threshold itself is STUCK_IDLE_MINUTES. */
export const IDLE_SWEEP_INTERVAL_MS = 10 * 60_000;

export function makeSandboxWiring(w: SandboxWiringInput) {
  /** Tickets whose last refused sync was a host rewrite (rebase/amend): the only ones offered "Carry sandbox commits". */
  const rewrittenTickets = new Set<number>();
  const onRewritten = (id: number, rewritten: boolean): void => { if (rewritten) rewrittenTickets.add(id); else rewrittenTickets.delete(id); };
  /** A recorded conflict's base branch: the refresh bundle carries it while the conflict is open (arch:AC-39). */
  const conflictBaseRef = (ticketId: number): string | null => {
    const worktrees = listWorktreesByTicket(w.store, ticketId);
    for (const c of listMergeChecksByTicket(w.store, ticketId)) {
      if (c.state === 'conflicted') return c.baseRef ?? worktrees.find((wt) => wt.repo === c.repo)?.baseRef ?? null;
    }
    return null;
  };
  const syncTrack = { onRewritten, conflictBaseRef, ...(w.bridgeDirOf ? { evidenceDirOf: w.bridgeDirOf } : {}) };
  const target = (ticketId: number): SandboxSyncTarget => {
    const t = getTicket(w.store, ticketId);
    const worktrees = listWorktreesByTicket(w.store, ticketId);
    // The recorded placement is the source of truth: host = no sandbox core at all, so nothing is ever spawned (arch:AC-32).
    const placement = getPlacement(w.store, ticketId);
    const core = placement ? (placement.backend === 'host' ? null : placement.core) : (t.sessionProvider ?? null);
    return { ticketId, ticketLabel: t.key ?? String(ticketId), core, worktree: readClonedWorktree(w.bridgeDirOf?.(ticketId), worktrees) ?? worktrees[0] };
  };
  const deps = (): SandboxLifecycleDeps | undefined => {
    const projectRoot = w.projectRoot();
    if (!w.backendOn() || projectRoot === undefined) return undefined;
    const bridges = w.bridges();
    return {
      notify: w.notify, projectRoot, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}), choose: w.choose, owns: controls, ...(bridges ? { bridges } : {}),
      openSyncDiff: (t) => w.openSyncDiff(t.ticketId),
      worktreeOf: (id) => { try { return target(id).worktree?.path; } catch { return undefined; } },
      debug: w.debug,
    };
  };
  /** Dashboard Stop / Remove: explicit user actions, independent of the configured backend (ownership and the unsynced-commit guard still apply). */
  const manualDeps = async (ticketId: number): Promise<{ d: SandboxLifecycleDeps; t: SandboxSyncTarget }> => {
    const { t, projectRoot } = await manual(ticketId);
    const bridges = w.bridges();
    return {
      t,
      d: {
        notify: w.notify, projectRoot, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}), choose: w.choose, owns: controls,
        ...(bridges ? { bridges } : {}), openSyncDiff: (target) => w.openSyncDiff(target.ticketId),
      },
    };
  };
  /**
   * This window controls a ticket's sandbox when it holds the session, or when
   * the ticket is in this window's project and NO window runs a session for it
   * (closed terminal, idle, done, archive). A ticket running here-not / elsewhere
   * (agent_state running, no session in this window) belongs to another window.
   */
  const controls = (id: number): boolean => {
    if (w.owned.has(id)) return true;
    const t = getTicket(w.store, id);
    if (t.projectId === null || t.projectId !== w.projectId()) return false;
    return w.sessionOpen(id) || t.agentState !== 'running';
  };
  /** Recorded host: there is no sandbox to stop, sync or remove, so lifecycle hooks never list a runner for it (arch:AC-32). */
  const recordedHost = (id: number): boolean => getPlacement(w.store, id)?.backend === 'host';
  /** A verified removal ends the recorded sandbox: the ticket now runs on host until a launch records otherwise. */
  const markRemoved = (id: number): void => {
    const p = getPlacement(w.store, id);
    if (p && p.backend !== 'host') recordPlacement(w.store, id, { backend: 'host', core: p.core, sandboxName: null, reason: 'sandbox removed' }, getTicket(w.store, id).sessionProvider ?? null);
  };
  const removeGuarded = async (d: SandboxLifecycleDeps, t: SandboxSyncTarget, opts?: { readonly skipSync?: boolean }): Promise<boolean> => {
    const ok = await removeSandboxGuarded(d, t, opts);
    if (ok) markRemoved(t.ticketId);
    return ok;
  };
  const clearSession = (id: number): void => setSessionId(w.store, id, null, null);
  const liveTickets = () => {
    const projectId = w.projectId();
    // A done+merged ticket is not live: a sandbox it still has is an orphan to clean up (arch:AC-37).
    const merged = doneMergedTicketIds(w.store);
    return projectId === undefined ? [] : listTickets(w.store, { projectId }).filter((t) => t.archivedAt === null && !merged.has(t.id));
  };
  /** The target with its core read from the runners' listing (sessionProvider is only a hint: null after a reload). */
  const resolved = async (ticketId: number, projectRoot: string): Promise<SandboxSyncTarget> => {
    const t = target(ticketId);
    // Recorded: no listing guess. The runner's tri-state probe later confirms the sandbox exists (arch:AC-39).
    if (getPlacement(w.store, ticketId)) return t;
    try {
      const inv = await inventoryOf({ notify: w.notify, projectRoot, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}) });
      const found = pickTicketSandbox(inv.sandboxes, ticketId, t.core, (m) => w.info(`karst: ${m}`));
      return found ? { ...t, core: found.core } : t;
    } catch (err) {
      w.logError(`karst: sandbox lookup failed for ticket ${ticketId}`, err);
      return t;
    }
  };
  const manual = async (ticketId: number) => {
    const t0 = target(ticketId);
    const projectRoot = w.projectRoot() ?? t0.worktree?.path ?? '';
    return { t: await resolved(ticketId, projectRoot), projectRoot };
  };
  /**
   * A palette command has no ticket argument: choose one of THIS project's tickets that has a
   * sandbox (from the runners' listing). Never returns silently: no backend / no sandbox is said.
   */
  const commandTarget = async (arg: number | undefined, verb: string): Promise<number | undefined> => {
    if (arg !== undefined) return arg;
    const projectRoot = w.projectRoot();
    if (projectRoot === undefined) {
      w.notify.info('Karst: no sandbox backend is configured for this project.');
      return undefined;
    }
    const inv = await inventoryOf({ notify: w.notify, projectRoot, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}) });
    const live = new Map(liveTickets().map((t) => [t.id, t]));
    const seen = new Set<number>();
    const picks = inv.sandboxes.flatMap((box) => {
      const t = live.get(box.ticketId);
      if (box.invalidCore === true || t === undefined || seen.has(box.ticketId)) return [];
      seen.add(box.ticketId);
      return [{ label: t.key ?? String(t.id), description: `${box.runner} ${box.core} (${box.state}) \u00b7 ${t.title}`, ticketId: t.id }];
    });
    if (picks.length === 0) {
      w.notify.info(`Karst: no ticket in this project has a sandbox to ${verb}.`);
      return undefined;
    }
    return w.pickTicket?.(picks, `Ticket whose sandbox to ${verb}`);
  };
  /** Both directions (F8/F12): before gates, and before a session resumes in an existing sandbox. Dirty clone or divergence = refused. */
  const ensureInSync = async (ticketId: number, refresh = true, allowDirtyClone = false) => {
    if (!w.backendOn()) return { ok: true as const };
    const { t, projectRoot } = await manual(ticketId);
    return ensureSandboxInSync({
      notify: w.notify, projectRoot, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}),
      ...syncTrack,
    }, t, { refresh, allowDirtyClone });
  };
  const stopTicket = async (ticketId: number): Promise<void> => {
    const { d, t } = await manualDeps(ticketId);
    if (await stopSandboxOp(d, t)) w.notify.info(`Karst: ${t.ticketLabel} sandbox stopped.`);
  };
  /**
   * A closed terminal does not mean a closed sandbox: sbx keeps it running, and
   * an agent that got a `retrying` done-marker still has work the host owes it.
   * Keep the bridge poller attached while the sandbox is live (or a queued
   * marker is still waiting), so the next marker is read and answered instead of
   * sitting in events.ndjson until a reload (T801).
   */
  const onSessionClosed = async (ticketId: number): Promise<void> => {
    const bridges = w.bridges();
    if (!bridges?.detach) return;
    if (bridges.markerStatus?.(ticketId) !== undefined) return;
    const d = deps();
    // No backend here: a host session ends with its terminal, so detach.
    if (!d) { await bridges.detach(ticketId); return; }
    let core: string | null = null;
    try {
      core = target(ticketId).core;
    } catch {
      core = null;
    }
    if (backendKindOf(core) === 'host') { await bridges.detach(ticketId); return; }
    let inv;
    try {
      inv = await inventoryOf(d);
    } catch (err) {
      // Cannot prove the sandbox is gone: a failed listing must never detach a live agent.
      w.logError(`karst: bridge session-close check failed for ticket ${ticketId}`, err);
      return;
    }
    // A failed listing proves neither presence nor absence (arch:AC-39): keep the poller.
    if (inv.errors.length > 0) return;
    if (inv.sandboxes.some((s) => s.ticketId === ticketId && s.state === 'running')) return;
    await bridges.detach(ticketId);
  };
  /** Running sandboxes this window controls: their bridge must survive a reload even without a live terminal (T801). */
  const liveSandboxTicketIds = async (): Promise<ReadonlySet<number>> => {
    const d = deps();
    if (!d || w.projectId() === undefined) return new Set();
    try {
      const inv = await inventoryOf(d);
      if (inv.errors.length > 0) return new Set();
      return new Set(inv.sandboxes
        .filter((s) => s.state === 'running' && s.invalidCore !== true && controls(s.ticketId))
        .map((s) => s.ticketId));
    } catch (err) {
      w.logError('karst: sandbox listing for the bridge sweep failed', err);
      return new Set();
    }
  };
  const wiring = {
    /** A terminal closed: stop the poller only when no live sandbox still needs it (T801). */
    onSessionClosed,
    /** Boot sweep: attach the bridge of a running sandbox even when no terminal ownership was persisted. */
    liveSandboxTicketIds,
    /** An accepted done marker + `session.idle` ends the sandbox session (arch:AC-37). */
    sessionEnder: createSandboxSessionEnder({
      launchIdFor: w.launchIdFor ?? (() => undefined),
      boundSessionId: (id) => getTicket(w.store, id).sessionId ?? undefined,
      stop: (id) => stopTicket(id),
      log: w.info,
    }),
    /** Palette entry for `karst.sandbox.sync` / `.dispose`: the given ticket, else a picker (F5). */
    commandTarget,
    /** `karst.sandbox.sync` / `.dispose`: explicit user actions, independent of the configured backend. */
    sync: async (ticketId: number): Promise<void> => {
      const { t, projectRoot } = await manual(ticketId);
      await syncSandboxOp({ notify: w.notify, projectRoot, ...syncTrack, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}) }, t);
    },
    /** The choke point before any host step that reads a sandboxed ticket's worktree, incl. the done marker (arch:AC-32). */
    ensureSynced: async (ticketId: number) => {
      // Like ensureInSync: a project with no sandbox backend has nothing to sync, so never spawn a CLI for it.
      if (!w.backendOn()) return { ok: true as const };
      const { t, projectRoot } = await manual(ticketId);
      return ensureSandboxSynced({ notify: w.notify, projectRoot, ...syncTrack, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}) }, t);
    },
    ensureInSync,
    /** F12: throws instead of returning a blocker (the ship saga's choke point). */
    assertInSync: async (ticketId: number, refresh = true): Promise<void> => {
      const r = await ensureInSync(ticketId, refresh);
      if (!r.ok) throw new Error(`sandbox not in sync: ${r.reason}`);
    },
    /** F17: the parent's sandbox commits reach the host before a sub-task forks from them; throws on a blocker. */
    syncParentOf: async (ticketId: number): Promise<void> => {
      const parentId = getTicket(w.store, ticketId).subtaskParentId;
      const r = parentId === null ? { ok: true as const } : await ensureInSync(parentId, false);
      if (!r.ok) throw new Error(`parent ticket sandbox not in sync: ${r.reason}`);
    },
    /** Dashboard "Stash sandbox changes and update": the user-clicked recovery for a sandbox with uncommitted work behind the host. */
    stashUpdate: async (ticketId: number): Promise<void> => {
      const { t, projectRoot } = await manual(ticketId);
      const r = await stashSandboxAndUpdate({ notify: w.notify, projectRoot, ...syncTrack, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}) }, t);
      if (!r.ok) await w.notify.error(`Karst: ${t.ticketLabel} sandbox not updated: ${r.reason}`);
      else {
        for (const k of ['uat', 'review'] as const) if (stageBlock(w.store, ticketId, k)?.kind === 'sandbox-sync') resumeBlockedStage(w.store, ticketId, ticketId, k);
        w.redrive?.(ticketId);
      }
    },
    /** Dashboard "Open sync diff": what a sync would bring in, nothing merged. */
    diff: async (ticketId: number): Promise<void> => {
      const { t, projectRoot } = await manual(ticketId);
      await diffSandboxOp({ notify: w.notify, projectRoot, showDiff: w.showDiff, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}) }, t);
    },
    /** Dashboard "Carry sandbox commits onto host branch": shown only while the last refused sync was a host rewrite. */
    isRewritten: (ticketId: number): boolean => rewrittenTickets.has(ticketId),
    carry: async (ticketId: number): Promise<void> => {
      const { d, t } = await manualDeps(ticketId);
      if (!w.reopen) { await w.notify.error('Karst: cannot carry the sandbox commits yet: reopening is not available.'); return; }
      const done = await carrySandboxOp({ ...d, ...syncTrack, reopen: w.reopen }, t);
      if (done) rewrittenTickets.delete(ticketId);
    },
    /** "Rebase on base": does the sandbox hold commits the host branch lacks? Unreadable counts as yes. */
    hasUnsynced: async (ticketId: number): Promise<boolean> => {
      const { d, t } = await manualDeps(ticketId);
      return sandboxHasUnsynced({ ...d, reopen: async () => {} }, t);
    },
    /**
     * "Deliver to PR" counts: fetch the sandbox clone's branch into the host worktree `cwd` and name the ref
     * it landed on. Null for a host ticket, another repo's worktree, or a clone that cannot be read.
     */
    cloneRef: async (ticketId: number, cwd: string): Promise<string | null> => {
      const { d, t } = await manualDeps(ticketId);
      const branch = t.worktree?.branch;
      if (t.worktree?.path !== cwd || !branch) return null;
      const runner = sandboxRunnerFor(d, t.core, ticketId);
      if (!runner?.diff) return null;
      const result = await runner.diff({ hostWorktreePath: cwd, branch });
      return result.ok ? result.ref : null;
    },
    /** "Rebase on base": recreate the clone from the rebased branch (no pre-remove sync), then reopen. Throws on failure. */
    recreateNoSync: async (ticketId: number): Promise<void> => {
      const { d, t } = await manualDeps(ticketId);
      if (!w.reopen) throw new Error('reopening the sandbox is not available');
      await recreateSandboxNoSync({ ...d, ...syncTrack, reopen: w.reopen }, t);
    },
    /** Dashboard Stop: stop (keep) this ticket's sandbox. */
    stop: stopTicket,
    /** Dashboard Remove: sync, then remove; unsynced commits need an explicit "Remove anyway". */
    remove: async (ticketId: number): Promise<void> => {
      if (recordedHost(ticketId)) return;
      const { d, t } = await manualDeps(ticketId);
      await removeGuarded(d, t);
    },
    dispose: async (ticketId: number): Promise<void> => {
      const { t, projectRoot } = await manual(ticketId);
      await disposeSandboxOp({ notify: w.notify, bridges: w.bridges(), projectRoot }, t);
    },
    /** Launch records where the ticket runs, with its core, in one write; only the controlling window writes (AC-37). */
    recordLaunchPlacement: (ticketId: number, placement: TicketPlacement, sessionProvider: AgentProvider | null): boolean => {
      if (!controls(ticketId)) return false;
      recordPlacement(w.store, ticketId, placement, sessionProvider);
      return true;
    },
    beforeArchive: async (ticketId: number): Promise<boolean> => { const d = deps(); return d && !recordedHost(ticketId) ? removeGuarded(d, await resolved(ticketId, d.projectRoot)) : true; },
    /** Done: merged → remove (verified), else stop only (arch:AC-37). */
    onDone: (ticketId: number): void => { const d = deps(); if (d && !recordedHost(ticketId)) void resolved(ticketId, d.projectRoot).then(async (t) => { const merged = isDoneMerged(w.store, ticketId); const ok = await onDoneOp(d, t, merged); if (ok && merged) markRemoved(ticketId); }).catch((err: unknown) => w.logError('karst: sandbox stop on done failed', err)); },
    /** Activation backfill (D245): record placement for this project's unrecorded tickets from a CLEAN listing; a failed listing records nothing. Never throws. */
    backfillPlacements: async (): Promise<void> => {
      const d = deps();
      const projectId = w.projectId();
      if (!d || projectId === undefined) return;
      try {
        const inv = await inventoryOf(d);
        if (inv.errors.length > 0) return;
        const n = backfillPlacement(w.store, inv.sandboxes.filter((s) => s.invalidCore !== true), projectId);
        if (n > 0) w.info(`karst: recorded placement for ${n} ticket(s)`);
      } catch (err) {
        w.logError('karst: placement backfill failed', err);
      }
    },
    /** Activation backfill: remove sandboxes that done+merged tickets still hold. Never throws. */
    removeDoneMerged: async (): Promise<void> => {
      const d = deps();
      if (!d || w.projectId() === undefined) return;
      try {
        const n = await removeDoneMergedSandboxes(d, doneMergedTicketIds(w.store), (id, core) => ({ ...target(id), core }), w.info);
        if (n > 0) w.info(`karst: removed ${n} sandbox(es) of done+merged ticket(s)`);
      } catch (err) {
        w.logError('karst: removing sandboxes of done+merged tickets failed', err);
      }
    },
    /** Tickets whose sandbox is still listed: the bridge sweep keeps their dirs. */
    sandboxTicketIds: async (): Promise<ReadonlySet<number>> => {
      const d = deps();
      if (!d) return new Set();
      const inv = await inventoryOf(d);
      for (const e of inv.errors) w.info(`karst: sandbox listing: ${e}`);
      return new Set(inv.sandboxes.map((b) => b.ticketId));
    },
    onProviderSwitch: async (ticketId: number, newCore: string): Promise<boolean> => {
      const d = deps();
      return d && !recordedHost(ticketId) ? switchProviderOp({ ...d, clearSession: (id) => { clearSession(id); markRemoved(id); } }, await resolved(ticketId, d.projectRoot), newCore) : true;
    },
    reconcile: async (): Promise<void> => {
      const d = deps();
      if (!d || w.projectId() === undefined) return;
      await runSandboxReconcile({
        inventory: async () => {
          const inventory = await inventoryOf(d);
          w.onInventory?.(inventory);
          return inventory;
        },
        live: liveTickets, owns: controls, clearSession, info: w.info, logError: w.logError,
        sweepStrays: async (inv) => {
          const sd = { projectRoot: d.projectRoot, docker: d.dockerProc ?? NODE_DOCKER_PROCESS, liveTicketIds: new Set(liveTickets().map((t) => t.id)) };
          const strays = await findStrays(sd, inv);
          const failed = await removeStrays(sd, strays);
          const kept = strays.filter((s) => !s.removable).map((s) => `${s.kind} ${s.name}`);
          const removed = strays.filter((s) => s.removable).length - failed.length;
          return [
            ...(removed > 0 ? [`karst: removed ${removed} stray sandbox resource(s) of closed tickets`] : []),
            ...failed.map((f) => `karst: could not remove stray ${f}`),
            ...(kept.length > 0 ? [`karst: stray sandbox resource(s) of open tickets left alone: ${kept.join(', ')}`] : []),
          ];
        },
      });
    },
    /** Stop (never remove) running sandboxes idle past the stuck threshold (arch:AC-32). */
    idleSweep: async (): Promise<number> => {
      const d = deps();
      if (!d || w.projectId() === undefined) return 0;
      const tickets = liveTickets().map((t) => ({ id: t.id, updatedAtMs: t.updatedAt === null ? Number.NaN : parseDbTimeMs(t.updatedAt), sessionOpen: w.sessionOpen(t.id) }));
      const idle = idleSandboxes(await inventoryOf(d), tickets, d.owns, (w.now ?? Date.now)(), STUCK_IDLE_MINUTES * 60_000);
      let stopped = 0;
      for (const box of idle) if (await stopSandboxOp(d, { ...target(box.ticketId), core: box.core })) stopped += 1;
      if (stopped > 0) w.info(`karst: stopped ${stopped} idle sandbox(es): ${idle.map((b) => b.name).join(', ')}`);
      return stopped;
    },
    cleanupOrphans: async (): Promise<void> => {
      const d = deps();
      if (!d || w.projectId() === undefined) { w.notify.info('Karst: no sandbox backend configured.'); return; }
      await cleanupOrphansOp(d, new Set(liveTickets().map((t) => t.id)));
    },
    /** Periodic idle sweep; the returned disposable stops it. A failed sweep is logged, never thrown. */
    startIdleSweep: (): { dispose(): void } => {
      const tick = (): void => { void wiring.idleSweep().catch((err: unknown) => w.logError('karst: sandbox idle sweep failed', err)); };
      const every = w.setInterval ?? ((fn, ms) => { const h = setInterval(fn, ms); return { dispose: () => clearInterval(h) }; });
      return every(tick, IDLE_SWEEP_INTERVAL_MS);
    },
  };
  return wiring;
}
