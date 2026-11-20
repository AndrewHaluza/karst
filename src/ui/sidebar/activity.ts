import type { Store } from '../../store/db.js';
import { countEvents, listEvents, unreadEventCount, type EventLevel, type KarstEvent } from '../../store/karstEvents.js';
import { formatId } from '../../model/entityId.js';

/** Rows the Activity pane lists per page (first load and each Show more). */
export const ACTIVITY_PAGE = 50;

/** One Activity row, phrased by the host (@ui:UI-R31): the webview only draws it. */
export interface ActivityRowView {
  id: number;
  level: EventLevel;
  title: string;
  /** The ticket the event is about; null for a project-wide event (the row has no click target). */
  ticketId: number | null;
  /** `T963` for `ticketId`; null without a ticket. */
  ticketLabel: string | null;
  /** UTC ISO time; the webview groups by day and prints HH:MM in the viewer's zone. */
  createdAt: string;
  unread: boolean;
}

/** The Activity pane's data: the newest rows of the bound project and the counts its header shows. */
export interface ActivityView {
  rows: ActivityRowView[];
  /** All unread rows of the project, not only the loaded ones. */
  unread: number;
  /** All rows of the project. */
  total: number;
  /** True when rows older than the loaded ones exist. */
  hasMore: boolean;
}

export const EMPTY_ACTIVITY: ActivityView = { rows: [], unread: 0, total: 0, hasMore: false };

/** SQLite `datetime('now')` is UTC without a zone; make it an ISO instant the webview parses as UTC. */
export function eventIso(createdAt: string): string {
  return /[zZ]|[+-]\d\d:\d\d$/u.test(createdAt) ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
}

function rowView(e: KarstEvent): ActivityRowView {
  return {
    id: e.id,
    level: e.level,
    title: e.title,
    ticketId: e.ticketId,
    ticketLabel: e.ticketId === null ? null : formatId('ticket', e.ticketId),
    createdAt: eventIso(e.createdAt),
    unread: e.readAt === null,
  };
}

/** The Activity pane's snapshot: the newest `limit` rows, whatever the ticket facet or search. */
export function buildActivity(store: Store, projectId: number | undefined, limit: number = ACTIVITY_PAGE): ActivityView {
  if (projectId === undefined) return EMPTY_ACTIVITY;
  const rows = listEvents(store, { projectId, limit }).map(rowView);
  const total = countEvents(store, projectId);
  return { rows, unread: unreadEventCount(store, projectId), total, hasMore: total > rows.length };
}
