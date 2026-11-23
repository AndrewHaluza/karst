/**
 * Sidebar VIEW state that survives a reload of the webview (the webview state
 * API) and never reaches the host: which panes are collapsed and whether
 * archived planning sessions are listed, the Queue pane's filters and the
 * Activity level (SB-9, SB-17).
 */
import type { ActivityLevelFilter } from './activityFormat.js';
import { NO_QUEUE_FILTERS, restoreQueueFilters, type QueueFilters } from './queueFilter.js';

export type PaneKey = 'planning' | 'queue' | 'tickets' | 'activity';

export interface ViewState {
  readonly collapsed: Readonly<Record<PaneKey, boolean>>;
  readonly showArchivedPlans: boolean;
  readonly queueFilters: QueueFilters;
  readonly activityLevel: ActivityLevelFilter;
}

export const DEFAULT_VIEW: ViewState = {
  collapsed: { planning: false, queue: true, tickets: false, activity: true },
  showArchivedPlans: false,
  queueFilters: NO_QUEUE_FILTERS,
  activityLevel: 'all',
};

/** Read a persisted `view` defensively: an older snapshot has none, a corrupt one has odd types. */
export function restoreView(prev: unknown): ViewState {
  const v = (prev ?? {}) as { collapsed?: Partial<Record<PaneKey, unknown>>; showArchivedPlans?: unknown; queueFilters?: unknown; activityLevel?: unknown };
  return {
    collapsed: {
      planning: v.collapsed?.planning === true, queue: v.collapsed?.queue !== false, tickets: v.collapsed?.tickets === true,
      // A snapshot saved before the Activity pane has no key: it restores collapsed.
      activity: v.collapsed?.activity !== false,
    },
    showArchivedPlans: v.showArchivedPlans === true,
    queueFilters: restoreQueueFilters(v.queueFilters),
    activityLevel: v.activityLevel === 'problems' ? 'problems' : 'all',
  };
}
