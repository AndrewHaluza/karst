import type { GateRun } from '../../store/gateRuns.js';
import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { StageKey } from '../types.js';
import { formatTime, type InsideStatus } from './types.js';

/**
 * The round switcher's pure selectors (Option B, T1). A gate stage that
 * looped through the fix cycle records more than one ATTEMPT — the gate batch
 * and AI process run of each pass through `uat`/`review` — and today's
 * `latestBatch`/`latestProcessRun` (gates.ts) collapse them to the newest one
 * only. These selectors make "latest" a DEFAULT SELECTION over the full
 * attempt list rather than a hard-coded read, without touching the existing
 * latest-only behaviour: every function here treats `key === null` as "give
 * me exactly what the un-looped code already returns," so a ticket that never
 * looped renders byte-for-byte unchanged.
 */

/**
 * Tabs are bounded because a runaway ticket could in principle loop dozens of
 * times; the newest 8 is the same order of magnitude `max_rounds` is ever
 * configured to, and a stage with more attempts than this has bigger problems
 * than a missing tab.
 */
export const ATTEMPT_TABS_LIMIT = 8;

/** Opaque identifier of one recorded attempt at a gate stage. */
export type AttemptKey = string;

/**
 * The canonical key of a recorded row's attempt.
 *
 * `stageRunId` (v25) is preferred whenever a row carries one: it is the
 * `stage_runs` invocation itself, shared by every row (gate, process run,
 * finding) that same invocation produced. A row written before v25 carries no
 * stage run id — it still belongs to SOME invocation, so it falls back to the
 * batch stamp (`runAt`) the legacy branch of `scopeReviewFindings`
 * (`model/findingScope.ts`) keys by.
 */
export function attemptKey(stageRunId: number | null | undefined, runAt: string): AttemptKey {
  return stageRunId !== null && stageRunId !== undefined ? `sr:${stageRunId}` : `ra:${runAt}`;
}

/** The visible status word beside a tab's glyph — status is never colour-only. */
const STATUS_LABELS: Readonly<Record<InsideStatus, string>> = {
  pending: 'pending',
  run: 'running',
  wait: 'waiting',
  pass: 'passed',
  fail: 'failed',
  note: 'no result',
  skip: 'skipped',
};

/** One tab in the round switcher — one recorded attempt at a gate stage. */
export interface GateAttemptView {
  key: AttemptKey;
  /** Host-authored tab copy: `R2`, `latest`, `live`, `attempt 3`. */
  label: string;
  status: InsideStatus;
  /** Visible status word, so colour is never the only carrier. */
  statusLabel: string;
  /** `formatTime` of the attempt's earliest recorded start, when it has one. */
  time?: string;
  /** The round this attempt opened, when it opened one. */
  round?: number;
  /** True for the newest attempt — the default selection. */
  latest: boolean;
}

/** One attempt's recorded rows, grouped for `listGateAttempts` before it becomes a view. */
interface AttemptGroup {
  key: AttemptKey;
  runs: GateRun[];
  /** The greatest `runAt` among the group's rows — the ordering key, NEVER array position. */
  order: string;
}

/**
 * Group a stage's gate runs into attempts, oldest to newest.
 *
 * Grouped by `attemptKey`, ordered by each group's greatest `runAt` — exactly
 * the reduction `latestBatch` documents, applied per attempt instead of once
 * across the whole stage. Array position is never trusted: nothing here
 * assumes the store returns rows in any particular order beyond `runAt`
 * being a comparable ISO stamp.
 */
function groupAttempts(runs: readonly GateRun[], stageKey: StageKey): AttemptGroup[] {
  const mine = runs.filter((r) => r.stageKey === stageKey);
  const groups = new Map<AttemptKey, AttemptGroup>();
  for (const r of mine) {
    const key = attemptKey(r.stageRunId, r.runAt);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, runs: [r], order: r.runAt });
    } else {
      existing.runs.push(r);
      if (r.runAt > existing.order) existing.order = r.runAt;
    }
  }
  return [...groups.values()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

/**
 * One attempt's status, derived ONLY from its own recorded batch — never from
 * another attempt's outcome. A gate that failed (a non-skipped, non-null,
 * non-zero exit) fails the whole attempt; otherwise an attempt that answered
 * at least one gate passed; an attempt that recorded rows but answered none
 * (every gate skipped, or every script missing) states no verdict.
 */
function attemptStatus(runs: readonly GateRun[]): InsideStatus {
  // A synthetic live group: the invocation is open and has recorded nothing.
  // Absence, not a verdict — `listGateAttempts` overrides this with `run`
  // while the stage is actually running.
  if (runs.length === 0) return 'pending';
  const failed = runs.some((r) => !r.skipped && r.exitCode !== null && r.exitCode !== 0);
  if (failed) return 'fail';
  const answered = runs.some((r) => !r.skipped && r.exitCode !== null);
  return answered ? 'pass' : 'note';
}

/** The earliest recorded start among an attempt's rows, or undefined if none started. */
function attemptEarliestStart(runs: readonly GateRun[]): string | undefined {
  let earliest: string | undefined;
  for (const r of runs) {
    if (!r.startedAt) continue;
    if (earliest === undefined || r.startedAt < earliest) earliest = r.startedAt;
  }
  return earliest;
}

/** Everything `listGateAttempts` needs, already loaded. */
export interface ListGateAttemptsInput {
  gateRuns: readonly GateRun[];
  processRuns: readonly ProcessRun[];
  rounds: readonly RecoveryRound[];
  stageKey: StageKey;
  /** Whether the stage is running right now — the newest attempt reads `live` instead of `latest`. */
  running: boolean;
  /**
   * The stage's CURRENT invocation (`currentAttempt.ts`), when the host knows
   * it. An invocation that has recorded no gate row yet holds no group here —
   * it is the fix cycle's fresh round, and without a synthetic tab for it the
   * switcher vanishes exactly when the reader most needs to reach the round
   * before it. `null`/absent adds nothing.
   */
  currentAttempt?: AttemptKey | null;
}

/**
 * The ordered attempt tabs for one gate stage.
 *
 * A stage with 0 or 1 recorded attempt emits NO tabs — the control costs
 * nothing on a ticket that never looped, and there would be nothing to
 * switch between. `processRuns` is accepted but unused today: it is part of
 * the T1 selector surface future tasks (T3/T4) read alongside this list, kept
 * here so the input shape does not change again when they land.
 */
export function listGateAttempts(input: ListGateAttemptsInput): GateAttemptView[] {
  const groups = groupAttempts(input.gateRuns, input.stageKey);
  // The current invocation may have recorded nothing yet (the fix cycle's
  // fresh round). It is still an attempt — and the NEWEST one — so it gets a
  // tab, or the switcher disappears the moment a round reopens and the
  // previous round's evidence becomes unreachable. Appended AFTER the sort:
  // `groupAttempts` returns oldest→newest, and an invocation with no rows has
  // no `runAt` to sort by.
  const current = input.currentAttempt ?? null;
  if (current !== null && !groups.some((g) => g.key === current)) {
    groups.push({ key: current, runs: [], order: '' });
  }
  if (groups.length < 2) return [];

  const roundByKey = new Map<AttemptKey, RecoveryRound>();
  for (const round of input.rounds) {
    if (round.sourceStage !== input.stageKey) continue;
    if (round.sourceStageRunId === null) continue;
    roundByKey.set(attemptKey(round.sourceStageRunId, ''), round);
  }

  const lastIndex = groups.length - 1;
  const views = groups.map((group, index): GateAttemptView => {
    const isLatest = index === lastIndex;
    const round = roundByKey.get(group.key);
    // ONE naming series, and it is the attempt's own 1-based position in the
    // stage's history — `attempt 2` is always the second attempt, whatever
    // number the round it opened carries. A round number is NOT that position
    // (only a FAILING attempt opens a round, so round 2 can sit at attempt 3),
    // and labelling some tabs `R2` and their neighbours `attempt 3` invited
    // exactly that misreading. The round rides along as a suffix, so the tab
    // still says which recovery it caused, and the `round` field below stays
    // the machine-readable fact the note is worded from.
    const position = `attempt ${index + 1}`;
    const label =
      round !== undefined
        ? `${position} · R${round.round}`
        : isLatest
          ? input.running
            ? 'live'
            : 'latest'
          : position;
    const status = isLatest && input.running ? 'run' : attemptStatus(group.runs);
    const time = attemptEarliestStart(group.runs);
    return {
      key: group.key,
      label,
      status,
      statusLabel: STATUS_LABELS[status],
      ...(time ? { time: formatTime(time) } : {}),
      ...(round !== undefined ? { round: round.round } : {}),
      latest: isLatest,
    };
  });

  // Bound to the newest ATTEMPT_TABS_LIMIT — the array is already oldest→newest.
  return views.length > ATTEMPT_TABS_LIMIT ? views.slice(views.length - ATTEMPT_TABS_LIMIT) : views;
}

/**
 * The rounds ONE attempt opened — what the attempt's Fix row may report.
 *
 * The Fix process is drawn per attempt, so it must read that attempt's own
 * recovery, never the stage's whole history: the newest round rendered on every
 * tab made a completed round keep spinning on the attempt that had finished it,
 * and put a Fix row on a live attempt that had not failed anything yet.
 *
 * `selected === null` (the default path) is scoped to `latest` for the same
 * reason — the default view IS the latest attempt, and a round an earlier
 * attempt opened is that earlier attempt's evidence.
 *
 * A legacy round with no `sourceStageRunId` cannot be attributed to an attempt,
 * so it rides with the latest one rather than disappearing — the same
 * "unattributable rows keep their pre-v25 home" rule `batchForAttempt` follows.
 * A stage with no attempt key at all (no gate row recorded yet) keeps every
 * round: there is nothing to scope against.
 */
export function roundsForAttempt(
  rounds: readonly RecoveryRound[],
  stageKey: StageKey,
  selected: AttemptKey | null,
  latest: AttemptKey | null,
): RecoveryRound[] {
  const mine = rounds.filter((r) => r.sourceStage === stageKey);
  const effective = selected ?? latest;
  if (effective === null) return mine;
  return mine.filter((r) =>
    r.sourceStageRunId === null
      ? effective === latest
      : attemptKey(r.sourceStageRunId, '') === effective,
  );
}

/**
 * The most recent invocation's rows for a stage — duplicated from
 * `latestBatch` (gates.ts) rather than imported: importing gates.ts from here
 * would close a cycle once T3 makes gates.ts import THIS module's selectors.
 * Kept byte-for-byte identical on purpose — this is the exact `key === null`
 * path every caller must keep reading.
 */
function latestBatchLocal(runs: readonly GateRun[], stageKey: StageKey): GateRun[] {
  const mine = runs.filter((r) => r.stageKey === stageKey);
  const latest = mine.reduce<string | null>(
    (max, r) => (max === null || r.runAt > max ? r.runAt : max),
    null,
  );
  return latest === null ? [] : mine.filter((r) => r.runAt === latest);
}

/**
 * The gate batch for one attempt. `key === null` reproduces `latestBatch`'s
 * behaviour exactly — what keeps every un-looped ticket unchanged. An unknown
 * key returns an empty batch rather than throwing: a selection that no longer
 * exists (a snapshot that moved on) degrades to "nothing recorded", never a
 * crash.
 */
export function batchForAttempt(
  runs: readonly GateRun[],
  stageKey: StageKey,
  key: AttemptKey | null,
): GateRun[] {
  if (key === null) return latestBatchLocal(runs, stageKey);
  const mine = runs.filter(
    (r) => r.stageKey === stageKey && attemptKey(r.stageRunId, r.runAt) === key,
  );
  // ONE stage run can record more than one batch (a re-run inside the same
  // invocation), and a batch — not a stage run — is what `latestBatch` returns
  // and what a gate row belongs to. Keeping the attempt's NEWEST batch is what
  // makes the latest tab render exactly the default view's rows; without it a
  // multi-batch stage run showed both batches at once, so selecting the tab
  // already on screen changed what was on screen.
  const newest = mine.reduce<string | null>(
    (max, r) => (max === null || r.runAt > max ? r.runAt : max),
    null,
  );
  return newest === null ? [] : mine.filter((r) => r.runAt === newest);
}

/**
 * The key of the stage's NEWEST attempt, or null when it recorded none.
 *
 * Derived from the same grouping the tabs are built from, so "is this
 * selection the latest one?" is answered by the attempt SERIES rather than by
 * whichever row a batch happens to hold first — rows of one batch are not
 * guaranteed to agree about `stageRunId` (a legacy row carries none), and a
 * caller that reads `batch[0]` to answer it is trusting array position, which
 * this module refuses to do everywhere else.
 */
export function latestAttemptKey(
  runs: readonly GateRun[],
  stageKey: StageKey,
): AttemptKey | null {
  const groups = groupAttempts(runs, stageKey);
  return groups.length === 0 ? null : groups[groups.length - 1]!.key;
}

/**
 * The latest invocation of a process, by its explicit run id — duplicated
 * from `latestProcessRun` (gates.ts) for the same cycle-avoidance reason
 * `latestBatchLocal` gives above.
 */
function latestProcessRunLocal(
  runs: readonly ProcessRun[],
  processId: string,
): ProcessRun | undefined {
  let best: ProcessRun | undefined;
  for (const run of runs) {
    if (run.processId !== processId) continue;
    if (best === undefined || run.id > best.id) best = run;
  }
  return best;
}

/**
 * The process run for one attempt, matched by `stageRunId` — a process run
 * carries no `runAt` batch stamp of its own, so unlike `batchForAttempt` a
 * legacy run with no stage run id can never match an explicit key: there is
 * no `ra:` fallback to compare it against. `key === null` reproduces
 * `latestProcessRun`'s behaviour exactly. An unknown key returns undefined,
 * never throws.
 */
export function processRunForAttempt(
  runs: readonly ProcessRun[],
  processId: string,
  key: AttemptKey | null,
): ProcessRun | undefined {
  if (key === null) return latestProcessRunLocal(runs, processId);
  let best: ProcessRun | undefined;
  for (const run of runs) {
    if (run.processId !== processId) continue;
    if (run.stageRunId === null) continue;
    if (attemptKey(run.stageRunId, '') !== key) continue;
    if (best === undefined || run.id > best.id) best = run;
  }
  return best;
}
