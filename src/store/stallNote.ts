import type { Store } from './db.js';
import { listFindings, recordFindings, type Finding } from './reviewFindings.js';

/** Title of the human finding that carries the note of an applied stall option. */
export const STALL_NOTE_TITLE = 'Stall decision';

/** Title of the human finding that records an accepted docs-only report. */
export const STALL_ACCEPT_TITLE = 'Report accepted with open findings';

/**
 * Record the note of an applied stall option as a human `info` finding.
 * It never counts toward a stall (stall input is agent findings only).
 */
export function recordStallNote(
  store: Store,
  ticketId: number,
  attempt: number,
  runAt: string,
  note: string,
): void {
  recordFindings(store, {
    ticketId,
    attempt,
    runAt,
    findings: [{ severity: 'info', repo: '', title: STALL_NOTE_TITLE, detail: note, source: 'human' }],
  });
}

/**
 * Record that the user accepted the report with `openBlocking` findings open.
 * The findings stay in history and stay unfixed.
 */
export function recordStallAccept(
  store: Store,
  ticketId: number,
  attempt: number,
  runAt: string,
  openBlocking: number,
): void {
  recordFindings(store, {
    ticketId,
    attempt,
    runAt,
    findings: [
      {
        severity: 'info',
        repo: '',
        title: STALL_ACCEPT_TITLE,
        detail: `Accepted by the user with ${openBlocking} open blocking finding(s). They stay unfixed.`,
        source: 'human',
      },
    ],
  });
}

/**
 * The newest stall note, or null. A note applies only until a newer agent
 * review batch exists: the next review judges the work after the note.
 */
export function stallNote(store: Store, ticketId: number): string | null {
  const all = listFindings(store, ticketId);
  const notes = all.filter((f) => f.source === 'human' && f.title === STALL_NOTE_TITLE);
  const last = notes.reduce<(typeof notes)[number] | null>(
    (max, f) => (max === null || f.runAt >= max.runAt ? f : max),
    null,
  );
  if (last === null) return null;
  const newerAgent = all.some((f) => f.source !== 'human' && f.runAt > last.runAt);
  return newerAgent ? null : last.detail;
}

const isStallRow = (f: Finding): boolean =>
  f.source === 'human' && (f.title === STALL_NOTE_TITLE || f.title === STALL_ACCEPT_TITLE);

/**
 * The newest batch of review findings, with the stall rows left out. A stall
 * note is stored as the newest batch, so the plain latest batch would hold
 * only the note and the fix brief would lose the findings.
 */
export function latestReviewBatch(store: Store, ticketId: number): Finding[] {
  const all = listFindings(store, ticketId).filter((f) => !isStallRow(f));
  const latest = all.reduce<string | null>((max, f) => (max === null || f.runAt > max ? f.runAt : max), null);
  return latest === null ? [] : all.filter((f) => f.runAt === latest);
}
