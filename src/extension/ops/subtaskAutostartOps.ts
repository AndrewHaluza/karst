import type { Manifest } from '../../manifest/types.js';
import { DEFAULT_SUBTASK_LIMITS } from '../../manifest/schema.js';
import type { Store } from '../../store/db.js';
import { findTicketById } from '../../store/tickets.js';
import { claimAutostart, releaseAutostart, requeueStaleClaims } from '../../store/autostart.js';
import { postMessage } from '../../store/ticketMessages.js';
import { pickSubtasksToStart, type AutostartCaps } from '../../workflow/subtaskAutostart.js';
import { isStackedSubtask } from '../../workflow/baseRef.js';
import type { Notify } from './notify.js';
import { formatId, formatTicketRef } from '../../model/entityId.js';

/**
 * Sub-task auto-start (plan §A). Picks queued sub-tasks under the caps,
 * atomically claims each (so overlapping sweeps and other windows never start
 * the same child twice), then starts it with the host's `startTicket`.
 *
 * Runs only in the window that owns the parent's live session (`ownsParent`);
 * a parent with no live session anywhere leaves its children queued.
 */

/**
 * The caps from the CURRENT manifest (`subtasks`), falling back to the
 * defaults when there is no manifest or no block. `0` = unlimited. Called per
 * sweep so a Settings save takes effect without a reload.
 */
export function autostartCapsFrom(manifest: Manifest | undefined): AutostartCaps {
  const limits = manifest?.subtasks ?? DEFAULT_SUBTASK_LIMITS;
  return { perParent: limits.maxConcurrentPerParent, total: limits.maxConcurrentTotal };
}

/** Upper bound on the failure reason carried into the parent's event. */
const MAX_REASON = 300;

/** A starting claim older than this at scope is an orphan (its window died). */
export const STALE_CLAIM_MS = 10 * 60_000;

export type AutostartStartResult = { ok: true } | { ok: false; message: string };

export interface SubtaskAutostartDeps {
  store: Store;
  /** The window's bound project; `undefined` = not bound yet, nothing to do. */
  projectId: () => number | undefined;
  caps: () => AutostartCaps;
  /** The current manifest; without it every child counts as stacked (no pull). */
  manifest?: () => Manifest | undefined;
  ownsParent: (parentId: number) => boolean;
  /**
   * The host start path. Autostart passes `pullBase: false` for stacked sub-tasks
   * (the child's base is its parent's branch, not a remote) or `pullBase: true`
   * when non-stacked, and `quiet: true` — this op owns the single user-facing warning.
   */
  startTicket: (ticketId: number, opts: { pullBase: boolean; quiet: boolean }) => Promise<AutostartStartResult>;
  notify: Notify;
  debug: (message: string) => void;
}

export interface SubtaskAutostart {
  /** Start what the caps admit; resolves to the ids started. Never throws. */
  sweep(): Promise<number[]>;
  /** Stop for good: no further child is started, even mid-sweep. */
  dispose(): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeSubtaskAutostart(deps: SubtaskAutostartDeps): SubtaskAutostart {
  let running = false;
  let disposed = false;

  async function startOne(id: number, caps: AutostartCaps): Promise<boolean> {
    if (!claimAutostart(deps.store, id, caps)) {
      deps.debug(`[driver] autostart ${formatId('ticket', id)}: not claimed (blocked, raced, or capped) — skipping`);
      return false;
    }
    deps.debug(`[driver] autostart ${formatId('ticket', id)}: claimed — starting`);
    let reason: string;
    try {
      const child = findTicketById(deps.store, id);
      const manifest = deps.manifest?.();
      const stacked = !child || !manifest || isStackedSubtask(deps.store, child, manifest);
      const res = await deps.startTicket(id, { pullBase: !stacked, quiet: true });
      if (res.ok) {
        deps.debug(`[driver] autostart ${formatId('ticket', id)}: started`);
        return true;
      }
      reason = res.message;
    } catch (err) {
      reason = errorText(err);
    }
    reportFailure(id, reason);
    return false;
  }

  function reportFailure(id: number, reason: string): void {
    // Before scope passed the claim is still 2: release it to 0 (no retry —
    // the user starts it manually). After, setStage already cleared it.
    releaseAutostart(deps.store, id);
    const child = findTicketById(deps.store, id);
    const key = formatTicketRef(id, child?.key);
    const where =
      child?.stageCurrent === 'scope' || !child
        ? 'stayed at scope — start it manually'
        : `is at ${child.stageCurrent} without a session — open its session`;
    const body = `${key} autostart failed: ${reason.slice(0, MAX_REASON)} (${where})`;
    deps.debug(`[driver] autostart ${formatId('ticket', id)}: failed — ${where}`);
    deps.notify.warn(`karst: sub-task ${key} could not auto-start: ${reason.slice(0, MAX_REASON)}`);
    if (child?.subtaskParentId == null) return;
    try {
      postMessage(deps.store, {
        projectId: child.projectId,
        fromTicketId: null,
        toTicketId: child.subtaskParentId,
        kind: 'event',
        body,
      });
    } catch (err) {
      deps.debug(`[driver] autostart ${formatId('ticket', id)}: failure event not posted — ${errorText(err)}`);
    }
  }

  async function sweep(): Promise<number[]> {
    if (disposed) return [];
    if (running) {
      deps.debug('[driver] autostart: sweep already running — skipping');
      return [];
    }
    running = true;
    try {
      const projectId = deps.projectId();
      if (projectId === undefined) return [];
      const requeued = requeueStaleClaims(deps.store, projectId, STALE_CLAIM_MS);
      if (requeued > 0) deps.debug(`[driver] autostart: re-queued ${requeued} orphaned claim(s)`);
      const caps = deps.caps();
      const picked = pickSubtasksToStart(deps.store, projectId, {
        ...caps,
        ownsParent: deps.ownsParent,
        onBlocked: (id) => deps.debug(`[driver] autostart ${formatId('ticket', id)}: blocked by dependency — skipping`),
      });
      if (picked.length === 0) return [];
      deps.debug(`[driver] autostart: picked ${picked.join(', ')}`);
      const started: number[] = [];
      for (const id of picked) {
        if (disposed) {
          deps.debug('[driver] autostart: disposed — stopping sweep');
          break;
        }
        if (await startOne(id, caps)) started.push(id);
      }
      deps.debug(`[driver] autostart: started ${started.length}/${picked.length}`);
      return started;
    } catch (err) {
      deps.debug(`[driver] autostart: sweep failed — ${errorText(err)}`);
      return [];
    } finally {
      running = false;
    }
  }

  return {
    sweep,
    dispose: () => {
      disposed = true;
    },
  };
}
