import { buildAgentSetupView, parseChecklistReport, type AgentSetupView } from '../../setup/checklist/panelView.js';
import type { ChecklistItem } from '../../setup/checklist/types.js';

/**
 * The host side of the Getting Started "Agent setup" list. It owns the last
 * result and the run state; a run is the `setup checklist` CLI in a child
 * process, injected as `run`, so no discovery or readiness probe (sync git and
 * fs IO) ever runs on the extension host event loop (@arch:EVENTLOOP).
 *
 * `refresh` is for a user or panel request and joins a run in flight.
 * `schedule` is for a change on disk (a host apply, an approved skip): a burst
 * of calls runs one check, and a call during a run asks for one more run,
 * because the run in flight may have read the old files.
 */

/** Quiet time after the last change before the check runs. */
export const AGENT_SETUP_DEBOUNCE_MS = 1_500;

export interface AgentSetupChecklistDeps {
  /** Run `setup checklist` (JSON) and return its stdout. Rejects when the child fails or times out. */
  run: () => Promise<string>;
  now: () => Date;
  debounceMs?: number;
  /** Report a failed run (the view already carries the reason). */
  logError: (message: string, error: unknown) => void;
}

export interface AgentSetupChecklist {
  view(): AgentSetupView;
  /** Start a run now; joins a run in flight. Never rejects. */
  refresh(): Promise<void>;
  /** A change on disk: run once after a quiet window. */
  schedule(): void;
  /** Called after every state change (run start and run end). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export const timeLabel = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function createAgentSetupChecklist(deps: AgentSetupChecklistDeps): AgentSetupChecklist {
  const debounceMs = deps.debounceMs ?? AGENT_SETUP_DEBOUNCE_MS;
  const listeners = new Set<() => void>();
  let items: readonly ChecklistItem[] | undefined;
  let error: string | null = null;
  let updatedLabel: string | null = null;
  let inflight: Promise<void> | undefined;
  let dirty: boolean; // set before each run; a schedule() during a run sets it again
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;

  const notify = (): void => {
    for (const l of [...listeners]) l();
  };

  const runOnce = async (): Promise<void> => {
    try {
      items = parseChecklistReport(await deps.run());
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      deps.logError('karst: agent setup checklist failed', e);
    }
    updatedLabel = timeLabel(deps.now());
  };

  const loop = async (): Promise<void> => {
    do {
      dirty = false;
      await runOnce();
    } while (dirty && !disposed);
    inflight = undefined;
    notify();
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inflight === undefined) {
      inflight = loop();
      notify(); // the run has started: the panel shows 'Checking…' over the old rows
    }
    return inflight;
  };

  return {
    view: () => buildAgentSetupView({ items, error, checking: inflight !== undefined, updatedLabel }),
    refresh,
    schedule() {
      if (disposed) return;
      if (inflight !== undefined) {
        dirty = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), debounceMs);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}
