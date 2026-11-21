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
  /** The gate waits for a concurrency slot and has not started: live host state, never stored. */
  readonly waiting?: boolean;
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
  const at = `gate ${f.running.n}/${f.running.m} (${f.running.gate})`;
  const wait = f.running.waiting === true;
  if (f.running.afterTakeOver === true) return `Running the gates skipped by the manual Deliver: ${at}${wait ? ' waits for a slot' : ''}`;
  return `Delivering resolved merge: ${at}${wait ? ' waits for a slot' : ', push after the gates'}`;
}

/** The facts with the running gate marked waiting when the live state says it waits for a slot. */
export function withDeliverWait(f: DeliverFacts | undefined, live: Readonly<Record<string, { readonly kind: string }>> | undefined): DeliverFacts | undefined {
  if (!f?.running || live?.[f.running.gate]?.kind !== 'wait') return f;
  return { ...f, running: { ...f.running, waiting: true } };
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

/** The head facts that decide how a clean merge check reads (T1143). */
export interface MergeHeadFacts {
  /** `merge_checks.head_sha`: the head the local probe merged. */
  readonly localHead: string | null;
  /** `prs.head_oid`: the head GitHub holds for the PR; null when never stored. */
  readonly prHead: string | null;
  /** `prs.merge_block`: GitHub's own answer; null when never stated. */
  readonly mergeBlock: string | null;
}

/** True when the local merge head is a head that GitHub does not hold yet. */
export function isLocalHeadUnpushed(facts: MergeHeadFacts | undefined): boolean {
  return facts !== undefined && facts.localHead !== null && facts.prHead !== null && facts.localHead !== facts.prHead;
}

/**
 * The merge row / context wording. The head facts decide it, not an Autopilot round:
 * an agent or a user can also merge locally (T1099).
 */
export function mergeStateWording(state: string, facts: MergeHeadFacts | undefined): string {
  if (state !== 'clean' || facts === undefined || facts.localHead === null) return state;
  const head = shortSha(facts.localHead);
  if (facts.prHead === null) return `clean locally on ${head} (GitHub head unknown)`;
  if (facts.prHead === facts.localHead) return state;
  return `clean locally on ${head} (not pushed; GitHub: ${facts.mergeBlock ?? 'unknown'})`;
}

const CONFLICT_NOTE = /\((?:a conflict|conflicts) in ([^)]*)\)/;

/**
 * Rewrite the `(a conflict in <repo>)` note of a stored awaiting-merge reason at read time
 * when every named repo has a clean local merge that is not pushed (T1143). The stored reason stays as parked.
 */
export function wordResolvedConflict(reason: string, heads: ReadonlyMap<string, MergeHeadFacts>): string {
  const m = CONFLICT_NOTE.exec(reason);
  if (m === null) return reason;
  const repos = m[1]!.split(', ');
  const resolved = repos.map((repo) => ({ repo, facts: heads.get(repo) }));
  if (!resolved.every((r) => isLocalHeadUnpushed(r.facts))) return reason;
  const note =
    resolved.length === 1
      ? `(conflict resolved locally on ${shortSha(resolved[0]!.facts!.localHead)}, push pending)`
      : `(conflicts resolved locally: ${resolved.map((r) => `${r.repo} on ${shortSha(r.facts!.localHead)}`).join(', ')}; push pending)`;
  return reason.replace(CONFLICT_NOTE, note);
}
