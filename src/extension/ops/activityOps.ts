import type { Store } from '../../store/db.js';
import { getEvent, markAllEventsRead, markEventRead } from '../../store/karstEvents.js';

/** Seams of the sidebar Activity pane actions. */
export interface ActivityOpsDeps {
  store: Store;
  /** The window's bound project; the pane acts on this project's events only. */
  projectId: () => number | undefined;
  openDashboard: (ticketId: number) => void | Promise<void>;
  /** Re-push the sidebar state (debounced). */
  refresh: () => void;
  /** Grow the pane by one page; `beforeId` is the oldest shown row. */
  showMore: (beforeId: number) => void;
}

export interface ActivityActions {
  activityOpen(id: number): Promise<void>;
  activityMarkRead(id: number): void;
  activityMarkAllRead(): void;
  activityMore(beforeId: number): void;
}

/** The webview sends an event id it read from a snapshot; accept it only for the bound project. */
function ownEvent(deps: ActivityOpsDeps, id: number) {
  const projectId = deps.projectId();
  const event = projectId === undefined ? null : getEvent(deps.store, id);
  return event && event.projectId === projectId ? event : null;
}

export function makeActivityActions(deps: ActivityOpsDeps): ActivityActions {
  return {
    async activityOpen(id) {
      const event = ownEvent(deps, id);
      if (!event || event.ticketId === null) return;
      markEventRead(deps.store, id);
      deps.refresh();
      await deps.openDashboard(event.ticketId);
    },
    activityMarkRead(id) {
      if (!ownEvent(deps, id)) return;
      markEventRead(deps.store, id);
      deps.refresh();
    },
    activityMarkAllRead() {
      const projectId = deps.projectId();
      if (projectId === undefined) return;
      markAllEventsRead(deps.store, projectId);
      deps.refresh();
    },
    activityMore(beforeId) {
      deps.showMore(beforeId);
    },
  };
}
