/**
 * The auto-deliver of a resolved merge on the ship panel and in `karst context` (T1018, @arch:AP-00).
 *
 * Pure wording over facts the host read from the deliver tables (`store/deliverRuns.ts`). The webview and the
 * context renderer only word these facts (UI-R31); they never decide them.
 */

/** A gate failure kept on record, with the head where it failed. */
export interface DeliverFailureFact {
  readonly gate: string;
  readonly repo: string;
  readonly exitCode: number;
  readonly headSha: string | null;
  readonly summary: string | null;
}

export interface DeliverRunningFact {
  /** The gate that runs now, 1-based. */
  readonly n: number;
  readonly m: number;
  readonly gate: string;
  /** The run re-runs the gates a manual Deliver skipped, on the pushed head: no push follows (D540). */
  readonly afterTakeOver?: boolean;
}

export interface DeliverTakeOverFact {
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
}

export interface DeliverFacts {
  readonly running: DeliverRunningFact | null;
  /** Failures still on record (not dismissed, not passed on a newer head). */
  readonly failures: readonly DeliverFailureFact[];
  readonly takenOver: DeliverTakeOverFact | null;
  /** A conflict round is armed or its delivery runs: `merge: clean` is the LOCAL merge commit. */
  readonly roundActive: boolean;
  /** The head the ship panel shows now; a failure on another head is an older record. */
  readonly headSha: string | null;
}

export const SHA_SHORT = 9;
export const shortSha = (sha: string | null): string => (sha === null ? 'unknown head' : sha.slice(0, SHA_SHORT));

/** The one progress line, or null when no auto-deliver runs. */
export function deliverProgressLine(f: DeliverFacts): string | null {
  if (f.running === null) return null;
  if (f.running.afterTakeOver === true) return `Running the gates skipped by the manual Deliver: gate ${f.running.n}/${f.running.m} (${f.running.gate})`;
  return `Delivering resolved merge: gate ${f.running.n}/${f.running.m} (${f.running.gate}), push after the gates`;
}

export function deliverFailureLine(x: DeliverFailureFact): string {
  return `Gate ${x.gate} failed (exit ${x.exitCode}) on ${shortSha(x.headSha)}`;
}

/** What the manual Deliver does while the auto-deliver runs its gates (D506, D540). */
export const DELIVER_NOW_HINT = 'Deliver now pushes at once; the skipped gates run after the push.';

/** The hint of the Deliver button; null when the plain button needs no hint. */
export function deliverHint(f: DeliverFacts): string | null {
  const own = f.failures.find((x) => x.headSha === f.headSha) ?? null;
  if (own !== null) return `${deliverFailureLine(own)}. Deliver now pushes it anyway.`;
  if (f.running?.afterTakeOver === true) return null;
  if (f.running !== null) return `Auto-deliver runs gate ${f.running.n}/${f.running.m} (${f.running.gate}). ${DELIVER_NOW_HINT}`;
  return null;
}

const list = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(', '));

export function deliverTakeOverLine(t: DeliverTakeOverFact): string {
  return `Delivery taken over by a manual Deliver; failed: ${list(t.failed)}; skipped: ${list(t.skipped)}`;
}

/** The failures grouped under the head where they failed, newest head first as given. */
export function groupFailuresByHead(failures: readonly DeliverFailureFact[]): Array<{ headSha: string | null; items: DeliverFailureFact[] }> {
  const out: Array<{ headSha: string | null; items: DeliverFailureFact[] }> = [];
  for (const x of failures) {
    const g = out.find((o) => o.headSha === x.headSha);
    if (g) g.items.push(x);
    else out.push({ headSha: x.headSha, items: [x] });
  }
  return out;
}

export const LOCAL_MERGE_NOTE = 'the local merge commit, not on the PR yet';

/** The merge row / context wording while a round is armed or delivering. */
export function mergeStateWording(state: string, roundActive: boolean): string {
  return roundActive && state === 'clean' ? `clean (${LOCAL_MERGE_NOTE})` : state;
}
