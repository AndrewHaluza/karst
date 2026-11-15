// The phase times of one visual or layout gate run, as one log line.
// The gate (scripts/dockerGate.mjs) records the phases: plan, wait, sweep and re-run.

const MS_PER_SECOND = 1000;

/** Seconds with one decimal. A negative or non-finite time shows as 0.0. */
function seconds(ms) {
  return Number.isFinite(ms) && ms > 0 ? (ms / MS_PER_SECOND).toFixed(1) : '0.0';
}

/**
 * `visual timing: plan 4.1 s, wait 0.0 s, sweep 412.0 s`, or null when no phase is recorded.
 * @param {ReadonlyArray<{ name: string, ms: number }>} phases
 */
export function formatTiming(phases) {
  if (phases.length === 0) return null;
  return `visual timing: ${phases.map((phase) => `${phase.name} ${seconds(phase.ms)} s`).join(', ')}`;
}

/** A phase clock: `lap(name)` records the time since the last lap. `phases()` gives a copy of the list. */
export function phaseClock(now = () => performance.now()) {
  const phases = [];
  let last = now();
  return {
    lap(name) {
      const at = now();
      phases.push({ name, ms: at - last });
      last = at;
    },
    phases: () => phases.map((phase) => ({ ...phase })),
  };
}
