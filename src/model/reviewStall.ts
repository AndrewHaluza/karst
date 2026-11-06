import type { ReviewStallDetection } from '../manifest/types.js';

/** The blocking findings of one review attempt, reduced to what stall detection reads. */
export interface StallAttempt {
  attempt: number;
  /** An attempt with no findings is a clean round: it breaks every streak. */
  findings: readonly { file: string | null; line?: number | null; identity: string | null }[];
}

export interface StallFile {
  file: string;
  /** Consecutive attempts, ending at the latest, whose blocking findings hit this file. */
  roundsHit: number;
}

export interface ReviewStall {
  /** The streak length the reason names (consecutive attempts hitting the same file). */
  rounds: number;
  files: StallFile[];
  /** Identities that recur in the latest attempts (0 when repeats are not tracked). */
  repeatedIdentities: number;
  /** The problem the latest attempts repeat (identity or line match), or null. */
  repeat: { file: string | null; line: number | null } | null;
  reason: string;
}

/** Two findings in one file at most this many lines apart are the same problem. */
export const REPEAT_LINE_WINDOW = 15;

const filesOf = (a: StallAttempt): Set<string> =>
  new Set(a.findings.flatMap((f) => (f.file === null ? [] : [f.file])));

/** Consecutive attempts, counted back from the latest, for which `has` holds. */
function streak(attempts: readonly StallAttempt[], has: (a: StallAttempt) => boolean): number {
  let n = 0;
  for (let i = attempts.length - 1; i >= 0 && has(attempts[i]!); i--) n++;
  return n;
}

/**
 * Pure: is a ticket's review loop going round in circles?
 *
 * `attempts` are the ticket's blocking-finding attempts since the last reset,
 * oldest first; a clean round is an attempt with no findings and breaks the
 * streak. Stalled when the latest `sameFileRounds` attempts all hit at least
 * one common file, or (when `repeatedFindingRounds` is set) a finding identity
 * or a same-file line within REPEAT_LINE_WINDOW shows up in each of the latest
 * `repeatedFindingRounds` attempts.
 */
export function evaluateReviewStall(
  attempts: readonly StallAttempt[],
  cfg: ReviewStallDetection,
): ReviewStall | null {
  if (!cfg.enabled || attempts.length === 0) return null;

  const latestFiles = [...filesOf(attempts[attempts.length - 1]!)];
  const files = latestFiles
    .map((file) => ({ file, roundsHit: streak(attempts, (a) => filesOf(a).has(file)) }))
    .filter((f) => f.roundsHit >= cfg.sameFileRounds)
    .sort((a, b) => b.roundsHit - a.roundsHit || a.file.localeCompare(b.file));

  const repeated = repeatedIdentityCount(attempts, cfg.repeatedFindingRounds);
  const repeat = repeatedProblem(attempts, cfg.repeatedFindingRounds);

  if (files.length === 0 && repeat === null) return null;
  let rounds = files[0]?.roundsHit ?? 0;
  let reason = `Review keeps finding new problems in ${files.map((f) => f.file).join(', ')} (${rounds} rounds).`;
  if (repeat !== null) {
    const repeatRounds = cfg.repeatedFindingRounds ?? rounds;
    rounds = files[0]?.roundsHit ?? repeatRounds;
    const file = repeat.file ?? '(no file)';
    const at = repeat.line === null ? file : `${file}:${repeat.line}`;
    reason = `Review keeps reporting the same problem at ${at} (${repeatRounds} rounds). This is likely a design problem, not a bug.`;
  }
  return { rounds, files, repeatedIdentities: repeated, repeat, reason };
}

/** The latest attempts' common problem: a shared identity, else the same file within the line window. */
function repeatedProblem(
  attempts: readonly StallAttempt[],
  r: number | null,
): { file: string | null; line: number | null } | null {
  if (r === null || attempts.length < r) return null;
  const window = attempts.slice(-r);
  const latest = window[window.length - 1]!;
  const others = window.slice(0, -1);
  for (const f of latest.findings) {
    const sameIdentity =
      f.identity !== null && others.every((a) => a.findings.some((g) => g.identity === f.identity));
    const sameLine = f.file !== null && typeof f.line === 'number' && lineWindowHolds(f.file, f.line, others);
    if (sameIdentity || sameLine) return { file: f.file, line: f.line ?? null };
  }
  return null;
}

/**
 * True when a single window of `REPEAT_LINE_WINDOW` lines holds the latest
 * finding's line and one same-file line from each earlier attempt, so the
 * whole repeat spans at most the window, not twice of it.
 */
function lineWindowHolds(file: string, line: number, others: readonly StallAttempt[]): boolean {
  const linesOf = (a: StallAttempt): number[] =>
    a.findings.flatMap((g) => (g.file === file && typeof g.line === 'number' ? [g.line] : []));
  for (let lo = line - REPEAT_LINE_WINDOW; lo <= line; lo++) {
    const hi = lo + REPEAT_LINE_WINDOW;
    if (others.every((a) => linesOf(a).some((l) => l >= lo && l <= hi))) return true;
  }
  return false;
}

function repeatedIdentityCount(attempts: readonly StallAttempt[], r: number | null): number {
  if (r === null || attempts.length < r) return 0;
  const window = attempts.slice(-r);
  const [first, ...rest] = window.map(
    (a) => new Set(a.findings.flatMap((f) => (f.identity === null ? [] : [f.identity]))),
  );
  return [...first!].filter((id) => rest.every((s) => s.has(id))).length;
}
