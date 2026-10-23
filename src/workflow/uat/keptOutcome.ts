import type { UatFindingInput } from '../../store/uatFindings.js';
import type { KeptTarget } from '../usageLimitKept.js';

/** A sibling target's status carried on a UAT park row's `keptOutcome`. */
export interface UatKeptTarget extends KeptTarget {
  observations?: number;
}

/**
 * The sibling targets AND the observations a UAT park row kept: the evidence
 * the stopped Tester had already produced. Both must survive a re-park — the
 * observations to count (they are already durable from the run that made
 * them), the target statuses to carry forward on the next park row.
 */
export function parseUatKeptOutcome(raw: string | null): {
  observations: UatFindingInput[];
  targets: UatKeptTarget[];
} {
  const observations: UatFindingInput[] = [];
  const targets: UatKeptTarget[] = [];
  try {
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.observations)) {
        for (const obs of parsed.observations) {
          if (obs && typeof obs === 'object' && typeof obs.severity === 'string' && typeof obs.title === 'string') {
            observations.push({
              severity: obs.severity,
              title: obs.title,
              repo: obs.repo ?? null,
              file: obs.file ?? null,
              line: obs.line ?? null,
            });
          }
        }
      }
      if (Array.isArray(parsed.targets)) {
        for (const t of parsed.targets) {
          if (t && typeof t === 'object' && typeof t.repo === 'string') {
            targets.push(t as UatKeptTarget);
          }
        }
      }
    }
  } catch {
    // A malformed kept outcome keeps nothing — never a crash.
  }
  return { observations, targets };
}

/**
 * Merge a re-run's fresh UAT outcome with the siblings the earlier park kept.
 *
 * `testerResult.keptOutcome` names only the target THIS run touched; a re-run
 * that parks AGAIN would otherwise drop everything a partner target answered
 * before the first park — the very evidence the one-shot merge exists to
 * protect, lost on the second quota stop. Sibling observations lead (they were
 * observed first), and the fresh target statuses win for the re-run target (a
 * re-parked target must read `usage-limited`, not its stale prior status).
 */
export function mergeUatKeptOutcome(
  fresh: string,
  siblingObservations: readonly UatFindingInput[],
  siblingTargets: readonly UatKeptTarget[],
): string {
  let freshObservations: unknown[] = [];
  let freshTargets: unknown[] = [];
  try {
    const parsed = JSON.parse(fresh);
    if (Array.isArray(parsed.observations)) freshObservations = parsed.observations;
    if (Array.isArray(parsed.targets)) freshTargets = parsed.targets;
  } catch {
    // A malformed fresh outcome degrades to the siblings alone, never drops them.
  }
  const freshRepos = new Set(
    freshTargets
      .map((t) => (t && typeof t === 'object' ? (t as { repo?: unknown }).repo : undefined))
      .filter((r): r is string => typeof r === 'string'),
  );
  const preservedTargets = siblingTargets.filter((t) => !freshRepos.has(t.repo));
  return JSON.stringify({
    observations: [...siblingObservations, ...freshObservations],
    targets: [...preservedTargets, ...freshTargets],
  });
}

/**
 * One observation's identity, for "record each observation once" across runs: a
 * park row carries siblings forward into the next park, so the same finding can
 * reach several re-runs and must not gain a row per attempt.
 */
export function uatObservationKey(o: {
  repo?: string | null;
  severity: string;
  title: string;
  file?: string | null;
  line?: number | null;
}): string {
  return [o.repo ?? '', o.severity, o.title, o.file ?? '', o.line ?? ''].join('|');
}
