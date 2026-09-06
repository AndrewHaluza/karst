/**
 * Relative-age rendering for the Inside projection.
 *
 * Every graph row the panel shows — a planner run, a node run, the graph run
 * itself — is a durable row that outlives the window reading it. Without an
 * age, a planner `running` since yesterday and one launched a second ago are
 * the SAME row on screen, and the only question a stuck run raises ("is this
 * process new or stale?") has no answer in the surface that owns it.
 *
 * Pure and injected-clock: `now` is the projection's own `input.now`, never
 * `Date.now()`, so the rendering is deterministic under test and identical for
 * every row of one projection pass. Display only — nothing here decides
 * anything, and a coarse bucket is deliberate: the panel answers "how old",
 * not "how long exactly", which is what the evidence rows carry.
 */

/** Coarse buckets, largest unit that yields a whole number ≥ 1. */
const UNITS: readonly { ms: number; suffix: string }[] = [
  { ms: 86_400_000, suffix: 'd' },
  { ms: 3_600_000, suffix: 'h' },
  { ms: 60_000, suffix: 'm' },
  { ms: 1_000, suffix: 's' },
];

/**
 * A bare duration between two ISO instants ("3m", "2h", "4d"), or null when
 * either instant is absent or unparseable — a caller renders nothing rather
 * than a misleading zero. A negative span (a row stamped by a window whose
 * clock runs ahead) clamps to `0s`, never a negative age.
 */
export function durationBetween(fromIso: string | null | undefined, toIso: string): string | null {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const span = Math.max(0, to - from);
  for (const unit of UNITS) {
    const n = Math.floor(span / unit.ms);
    if (n >= 1) return `${n}${unit.suffix}`;
  }
  return '0s';
}

/**
 * How long ago an instant was, as a row detail fragment ("3m ago"), or null
 * when there is no instant to render.
 */
export function relativeAge(instantIso: string | null | undefined, nowIso: string): string | null {
  const span = durationBetween(instantIso, nowIso);
  return span === null ? null : `${span} ago`;
}

/**
 * The age fragment for a run row: how long it has been running when it is
 * still open, how long it took when it has ended, and an explicit "never
 * started" when a row reached a live status without ever recording a start —
 * which is itself the evidence that something is wrong with it.
 */
export function runAge(
  run: { startedAt?: string | null; endedAt?: string | null },
  nowIso: string,
  options: { live: boolean },
): string | null {
  if (run.endedAt) {
    const took = durationBetween(run.startedAt, run.endedAt);
    return took === null ? `ended ${relativeAge(run.endedAt, nowIso)}` : `ran ${took}`;
  }
  if (run.startedAt) return `running ${durationBetween(run.startedAt, nowIso)}`;
  return options.live ? 'never started' : null;
}
