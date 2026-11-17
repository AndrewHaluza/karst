import type { Store } from '../../store/db.js';
import type { ActionRecorder } from '../../model/actionResult.js';
import { recordEvent, type EventLevel, type EventSource } from '../../store/karstEvents.js';

/** Writes one `karst_events` row for a toast the host is about to show (@arch:EVENTS). */
export type ToastRecorder = (level: EventLevel, message: string, ticketId?: number) => void;

/** A toast title is one short line; a longer or multi-line message also lands in the body. */
const TOAST_TITLE_LIMIT = 120;

export interface ToastRecorderDeps {
  store: Store;
  /** A getter: the project is resolved after the seam is bound. Undefined skips the row. */
  projectId: () => number | undefined;
  debug: (message: string) => void;
}

/**
 * The recorder behind the host toast seam. It never throws: `recordEvent` logs a failed
 * insert through `debug` and returns null, so the toast always shows (@arch:EVENTLOOP).
 */
export function makeToastRecorder(deps: ToastRecorderDeps, source: EventSource = 'host'): ToastRecorder {
  return (level, message, ticketId) => {
    const projectId = deps.projectId();
    if (projectId === undefined) return;
    const long = message.length > TOAST_TITLE_LIMIT || message.includes('\n');
    recordEvent(
      deps.store,
      { projectId, ...(ticketId === undefined ? {} : { ticketId }), level, source, title: message, ...(long ? { body: message } : {}) },
      deps.debug,
    );
  };
}

/** The panel action recorder: the same rows, with source `panel`, over the one event recorder. */
export function panelActionRecorder(record: ToastRecorder): ActionRecorder {
  return (event) => record(event.level, event.message, event.ticketId);
}
