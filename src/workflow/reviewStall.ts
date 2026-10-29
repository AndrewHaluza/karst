import type { ReviewStallDetection } from '../manifest/types.js';

/** The blocking findings of one review attempt, reduced to what stall detection reads. */
export interface StallAttempt {
  attempt: number;
  findings: readonly { file: string | null; identity: string | null }[];
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
  reason: string;
}

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
 * oldest first. Stalled when the latest `sameFileRounds` attempts all hit at
 * least one common file, or (when `repeatedFindingRounds` is set) a finding
 * identity shows up in each of the latest `repeatedFindingRounds` attempts.
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

  if (files.length === 0 && repeated === 0) return null;
  const rounds = files[0]?.roundsHit ?? cfg.repeatedFindingRounds ?? 0;
  const where = files.map((f) => `${f.file} (${f.roundsHit} rounds)`).join(', ');
  const reason =
    files.length > 0
      ? `Review keeps finding new problems in ${where} — likely a design problem, not a bug.`
      : `Review keeps raising the same finding (${repeated} repeated over ${rounds} rounds) — likely a design problem, not a bug.`;
  return { rounds, files, repeatedIdentities: repeated, reason };
}

function repeatedIdentityCount(attempts: readonly StallAttempt[], r: number | null): number {
  if (r === null || attempts.length < r) return 0;
  const window = attempts.slice(-r);
  const [first, ...rest] = window.map(
    (a) => new Set(a.findings.flatMap((f) => (f.identity === null ? [] : [f.identity]))),
  );
  return [...first!].filter((id) => rest.every((s) => s.has(id))).length;
}
