import type { Store } from '../../store/db.js';
import { claimAutostart, findTicketById } from '../../store/tickets.js';
import { postMessage } from '../../store/ticketMessages.js';
import { pickSubtasksToStart, type AutostartCaps } from '../../workflow/subtaskAutostart.js';
import type { Notify } from './notify.js';

/**
 * Sub-task auto-start (plan §A). Picks queued sub-tasks under the caps,
 * atomically claims each (so overlapping sweeps and other windows never start
 * the same child twice), then starts it with the host's `startTicket`.
 *
 * Runs only in the window that owns the parent's live session (`ownsParent`);
 * a parent with no live session anywhere leaves its children queued.
 */

/** Used until the manifest carries `subtasks` caps (Wave 4). `0` = unlimited. */
export const DEFAULT_AUTOSTART_CAPS: AutostartCaps = { perParent: 2, total: 4 };

/** Upper bound on the failure reason carried into the parent's event. */
const MAX_REASON = 300;

export type AutostartStartResult = { ok: true } | { ok: false; message: string };

export interface SubtaskAutostartDeps {
  store: Store;
  /** The window's bound project; `undefined` = not bound yet, nothing to do. */
  projectId: () => number | undefined;
  caps: () => AutostartCaps;
  ownsParent: (parentId: number) => boolean;
  startTicket: (ticketId: number, opts: { pullBase: boolean }) => Promise<AutostartStartResult>;
  notify: Notify;
  debug: (message: string) => void;
}

export interface SubtaskAutostart {
  /** Start what the caps admit; resolves to the ids started. Never throws. */
  sweep(): Promise<number[]>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeSubtaskAutostart(deps: SubtaskAutostartDeps): SubtaskAutostart {
  let running = false;

  async function startOne(id: number): Promise<boolean> {
    if (!claimAutostart(deps.store, id)) {
      deps.debug(`[driver] autostart #${id}: already claimed elsewhere — skipping`);
      return false;
    }
    deps.debug(`[driver] autostart #${id}: claimed — starting`);
    let reason: string;
    try {
      const res = await deps.startTicket(id, { pullBase: false });
      if (res.ok) {
        deps.debug(`[driver] autostart #${id}: started`);
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
    const child = findTicketById(deps.store, id);
    const key = child?.key ?? `#${id}`;
    const where =
      child?.stageCurrent === 'scope' || !child
        ? 'stayed at scope — start it manually'
        : `is at ${child.stageCurrent} without a session — open its session`;
    const body = `${key} autostart failed: ${reason.slice(0, MAX_REASON)} (${where})`;
    deps.debug(`[driver] autostart #${id}: failed — ${where}`);
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
      deps.debug(`[driver] autostart #${id}: failure event not posted — ${errorText(err)}`);
    }
  }

  async function sweep(): Promise<number[]> {
    if (running) {
      deps.debug('[driver] autostart: sweep already running — skipping');
      return [];
    }
    running = true;
    try {
      const projectId = deps.projectId();
      if (projectId === undefined) return [];
      const picked = pickSubtasksToStart(deps.store, projectId, {
        ...deps.caps(),
        ownsParent: deps.ownsParent,
      });
      if (picked.length === 0) return [];
      deps.debug(`[driver] autostart: picked ${picked.join(', ')}`);
      const started: number[] = [];
      for (const id of picked) {
        if (await startOne(id)) started.push(id);
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

  return { sweep };
}
