import type { InsideProcessView, InsideStageKey } from './types.js';

/**
 * The live progress protocol (Task 13): a host-owned event describing ONE
 * process operation as it happens, pushed between full dashboard snapshots.
 *
 * The webview renders a LIVE HEADER for the `active` event and replaces the
 * process row when the matching `completed` event lands — the full snapshot
 * that follows remains authoritative, so these are an overlay, never a state
 * source. `cleared` handles cancellation/snapshot supersession without
 * inventing a terminal result: an operation that simply stopped existing is
 * not a pass, a fail, or a note.
 *
 * Pure types + a closed validator: the messages boundary (`messages.ts`)
 * validates the discriminant/status combinations here rather than re-deriving
 * them, so a malformed host message can never reach the webview.
 */

/**
 * What the live header says while an operation is in flight. A live operation
 * is never a pass: it is working (`run`), held (`wait`), or failed (`fail`) —
 * a terminal outcome is a `completed` event carrying a full process row.
 */
export interface LiveOperationView {
  status: 'run' | 'wait' | 'fail';
  /** Preformatted label — `test (web)`, `push /repo/web`. */
  label?: string;
  /** Preformatted one-line detail — the host's own wording. */
  detail?: string;
  /** Preformatted elapsed time — the host's own wording. */
  duration?: string;
}

export type InsideProgressEvent =
  | {
      kind: 'active';
      ticketId: number;
      stage: InsideStageKey;
      processId: string;
      live: LiveOperationView;
    }
  | {
      kind: 'completed';
      ticketId: number;
      stage: InsideStageKey;
      /** The process row that replaces the live header — pass/fail/note/skip with final evidence. */
      process: InsideProcessView;
    }
  | {
      kind: 'cleared';
      ticketId: number;
      stage: InsideStageKey;
      processId: string;
    };

const INSIDE_STAGE_KEYS: readonly string[] = ['scope', 'impl', 'uat', 'review', 'ship', 'done'];
const LIVE_STATUSES: readonly string[] = ['run', 'wait', 'fail'];
const PROCESS_STATUSES: readonly string[] = [
  'pending',
  'run',
  'wait',
  'pass',
  'fail',
  'note',
  'skip',
];

/** Longest label/prose value accepted on the wire — everything is preformatted host copy. */
const MAX_WIRE_TEXT = 240;

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isBoundedText(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_WIRE_TEXT;
}

function isStage(v: unknown): v is InsideStageKey {
  return typeof v === 'string' && (INSIDE_STAGE_KEYS as readonly string[]).includes(v);
}

function isLiveStatus(v: unknown): v is LiveOperationView['status'] {
  return typeof v === 'string' && (LIVE_STATUSES as readonly string[]).includes(v);
}

function isProcessStatus(v: unknown): v is InsideProcessView['status'] {
  return typeof v === 'string' && (PROCESS_STATUSES as readonly string[]).includes(v);
}

/**
 * Narrow an untrusted host-message payload to an `InsideProgressEvent`.
 *
 * The webview is the trust boundary in the other direction here — a host bug
 * must not be able to ship an event the renderer cannot handle — so every
 * field is type-checked against the closed vocabularies and every prose value
 * is bounded: the webview renders strings verbatim (it never re-formats), so
 * an unbounded value would be an unbounded DOM injection surface.
 */
export function validateInsideProgressEvent(raw: unknown): InsideProgressEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (!isId(m.ticketId) || !isStage(m.stage)) return null;
  if (m.kind === 'active') {
    if (typeof m.processId !== 'string' || m.processId.length === 0 || m.processId.length > 64) {
      return null;
    }
    const live = m.live as Record<string, unknown> | null | undefined;
    if (typeof live !== 'object' || live === null || !isLiveStatus(live.status)) return null;
    for (const key of ['label', 'detail', 'duration'] as const) {
      if (live[key] !== undefined && !isBoundedText(live[key])) return null;
    }
    return {
      kind: 'active',
      ticketId: m.ticketId,
      stage: m.stage,
      processId: m.processId,
      live: {
        status: live.status,
        ...(typeof live.label === 'string' ? { label: live.label } : {}),
        ...(typeof live.detail === 'string' ? { detail: live.detail } : {}),
        ...(typeof live.duration === 'string' ? { duration: live.duration } : {}),
      },
    };
  }
  if (m.kind === 'completed') {
    const process = m.process as Record<string, unknown> | null | undefined;
    if (typeof process !== 'object' || process === null) return null;
    if (
      typeof process.id !== 'string' ||
      process.id.length === 0 ||
      process.id.length > 64 ||
      typeof process.kind !== 'string' ||
      process.kind.length === 0 ||
      process.kind.length > 64 ||
      !isBoundedText(process.label) ||
      !isProcessStatus(process.status)
    ) {
      return null;
    }
    return {
      kind: 'completed',
      ticketId: m.ticketId,
      stage: m.stage,
      process: { id: process.id, kind: process.kind, label: process.label, status: process.status },
    };
  }
  if (m.kind === 'cleared') {
    if (typeof m.processId !== 'string' || m.processId.length === 0 || m.processId.length > 64) {
      return null;
    }
    return {
      kind: 'cleared',
      ticketId: m.ticketId,
      stage: m.stage,
      processId: m.processId,
    };
  }
  return null;
}
