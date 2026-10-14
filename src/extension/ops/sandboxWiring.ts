import type { Store } from '../../store/db.js';
import { getTicket, listTickets, setSessionId } from '../../store/tickets.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import type { SbxProcess } from '../../agent/sbx/sbxProcess.js';
import type { DockerProcess } from '../../agent/docker/dockerProcess.js';
import type { Notify } from './notify.js';
import { disposeSandboxOp, syncSandboxOp, type SandboxSyncTarget } from './sandboxSyncOps.js';
import { runSandboxReconcile } from './bootSweeps.js';
import {
  cleanupOrphansOp, inventoryOf, removeSandboxGuarded, stopSandboxOp, switchProviderOp, type Choose, type SandboxLifecycleDeps,
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
  readonly info: (m: string) => void;
  readonly logError: (m: string, err: unknown) => void;
  /** Test seams; default to the real async spawns. */
  readonly proc?: SbxProcess;
  readonly dockerProc?: DockerProcess;
}

/** arch:AC-32 lifecycle bindings for `extension.ts`: only with a sandbox backend, only this window's tickets. */
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
      notify: w.notify, projectRoot, ...(w.proc ? { proc: w.proc } : {}), ...(w.dockerProc ? { dockerProc: w.dockerProc } : {}), choose: w.choose, owns: (id) => w.owned.has(id), ...(bridges ? { bridges } : {}),
      openSyncDiff: (t) => w.openSyncDiff(t.ticketId),
    };
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
  return {
    /** `karst.sandbox.sync` / `.dispose`: explicit user actions, independent of the configured backend. */
    sync: async (ticketId: number): Promise<void> => {
      const { t, projectRoot } = manual(ticketId);
      await syncSandboxOp({ notify: w.notify, projectRoot }, t);
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
        live: liveTickets, owns: (id) => w.owned.has(id), clearSession, info: w.info, logError: w.logError,
      });
    },
    cleanupOrphans: async (): Promise<void> => {
      const d = deps();
      if (!d || w.projectId() === undefined) { w.notify.info('Karst: no sandbox backend configured.'); return; }
      await cleanupOrphansOp(d, new Set(liveTickets().map((t) => t.id)));
    },
  };
}
