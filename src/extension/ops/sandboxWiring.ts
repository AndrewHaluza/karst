import type { Store } from '../../store/db.js';
import { parseDbTimeMs } from '../../doctor/applyFixes.js';
import { STUCK_IDLE_MINUTES } from '../../doctor/stuckCheck.js';
import { getTicket, listTickets, setSessionId } from '../../store/tickets.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import type { SbxProcess } from '../../agent/sbx/sbxProcess.js';
import type { DockerProcess } from '../../agent/docker/dockerProcess.js';
import type { Notify } from './notify.js';
import { disposeSandboxOp, syncSandboxOp, type SandboxSyncTarget } from './sandboxSyncOps.js';
import { diffSandboxOp } from './sandboxDiffOp.js';
import { runSandboxReconcile } from './bootSweeps.js';
import {
  cleanupOrphansOp, idleSandboxes, inventoryOf, removeSandboxGuarded, stopSandboxOp, switchProviderOp, type Choose, type SandboxLifecycleDeps,
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
  readonly bridges: () => { dispose(ticketId: number): Promise<void> } | undefined;
  readonly openSyncDiff: (ticketId: number) => Promise<void>;
  /** Opens a unified diff in a read-only editor. */
  readonly showDiff: (title: string, diff: string) => Promise<void>;
  readonly info: (m: string) => void;
  readonly logError: (m: string, err: unknown) => void;
  /** A ticket's terminal/session is open (never stopped under it). */
  readonly sessionOpen: (ticketId: number) => boolean;
  /** Test seams; default to the real async spawns and clock. */
  readonly now?: () => number;
  readonly setInterval?: (fn: () => void, ms: number) => { dispose(): void };
  readonly proc?: SbxProcess;
  readonly dockerProc?: DockerProcess;
}

/** arch:AC-32 lifecycle bindings for `extension.ts`: only with a sandbox backend, only this window's tickets. */
/** How often the idle sweep looks; the threshold itself is STUCK_IDLE_MINUTES. */
export const IDLE_SWEEP_INTERVAL_MS = 10 * 60_000;

export function makeSandboxWiring(w: SandboxWiringInput) {
  const target = (ticketId: number): SandboxSyncTarget => {
    const t = getTicket(w.store, ticketId);
    return { ticketId, ticketLabel: t.key ?? String(ticketId), core: t.sessionProvider ?? null, worktree: listWorktreesByTicket(w.store, ticketId)[0] };
  };
  const deps = (): SandboxLifecycleDeps | undefined => {
    const projectRoot = w.projectRoot();
    if (!w.backendOn() || projectRoot === undefined) return undefined;
    const bridges = w.bridges();
    return {
      notify: w.notify, projectRoot, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}), choose: w.choose, owns: controls, ...(bridges ? { bridges } : {}),
      openSyncDiff: (t) => w.openSyncDiff(t.ticketId),
    };
  };
  /** Dashboard Stop / Remove: explicit user actions, independent of the configured backend (ownership and the unsynced-commit guard still apply). */
  const manualDeps = (ticketId: number): { d: SandboxLifecycleDeps; t: SandboxSyncTarget } => {
    const { t, projectRoot } = manual(ticketId);
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
  const clearSession = (id: number): void => setSessionId(w.store, id, null, null);
  const liveTickets = () => {
    const projectId = w.projectId();
    return projectId === undefined ? [] : listTickets(w.store, { projectId }).filter((t) => t.archivedAt === null);
  };
  const manual = (ticketId: number) => {
    const t = target(ticketId);
    return { t, projectRoot: w.projectRoot() ?? t.worktree?.path ?? '' };
  };
  const wiring = {
    /** `karst.sandbox.sync` / `.dispose`: explicit user actions, independent of the configured backend. */
    sync: async (ticketId: number): Promise<void> => {
      const { t, projectRoot } = manual(ticketId);
      await syncSandboxOp({ notify: w.notify, projectRoot }, t);
    },
    /** Dashboard "Open sync diff": what a sync would bring in, nothing merged. */
    diff: async (ticketId: number): Promise<void> => {
      const { t, projectRoot } = manual(ticketId);
      await diffSandboxOp({ notify: w.notify, projectRoot, showDiff: w.showDiff, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}) }, t);
    },
    /** Dashboard Stop: stop (keep) this ticket's sandbox. */
    stop: async (ticketId: number): Promise<void> => {
      const { d, t } = manualDeps(ticketId);
      if (await stopSandboxOp(d, t)) w.notify.info(`Karst: ${t.ticketLabel} sandbox stopped.`);
    },
    /** Dashboard Remove: sync, then remove; unsynced commits need an explicit "Remove anyway". */
    remove: async (ticketId: number): Promise<void> => {
      const { d, t } = manualDeps(ticketId);
      await removeSandboxGuarded(d, t);
    },
    dispose: async (ticketId: number): Promise<void> => {
      const { t, projectRoot } = manual(ticketId);
      await disposeSandboxOp({ notify: w.notify, bridges: w.bridges(), projectRoot }, t);
    },
    beforeArchive: async (ticketId: number): Promise<boolean> => { const d = deps(); return d ? removeSandboxGuarded(d, target(ticketId)) : true; },
    onDone: (ticketId: number): void => { const d = deps(); if (d) void stopSandboxOp(d, target(ticketId)); },
    onProviderSwitch: async (ticketId: number, newCore: string): Promise<boolean> => {
      const d = deps();
      return d ? switchProviderOp({ ...d, clearSession }, target(ticketId), newCore) : true;
    },
    reconcile: async (): Promise<void> => {
      const d = deps();
      if (!d || w.projectId() === undefined) return;
      await runSandboxReconcile({
        inventory: () => inventoryOf(d),
        live: liveTickets, owns: controls, clearSession, info: w.info, logError: w.logError,
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
