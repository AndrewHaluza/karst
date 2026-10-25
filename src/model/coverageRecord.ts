/**
 * The advisory COVERAGE record (arch:UAT-OBS). The UAT Tester and the reviewer
 * each end with ONE info-severity entry saying what they checked, what they
 * skipped and why, so a reader can tell "skipped" from "passed". It is the
 * agent's SELF-REPORT: it never passes, fails, transitions or spends a round,
 * and both lanes strip it before anything aggregates (`aggregateUat` /
 * `aggregateReview` never see it). It rides the existing findings storage as a
 * title-prefixed `info` row, so the dashboard shows it with no new surface.
 */
export const COVERAGE_PREFIX = 'COVERAGE (reported): ';

export type CoverageStatus = 'PASS' | 'SKIPPED' | 'NOT RUN';

const STATUSES: readonly CoverageStatus[] = ['PASS', 'SKIPPED', 'NOT RUN'];

const SHAPE =
  `ONE entry with severity "info" and a title starting "${COVERAGE_PREFIX}" followed by PASS (checked, nothing found), ` +
  `SKIPPED (name what and why) or NOT RUN, then " — " and what you covered. `;

export const COVERAGE_RULE_UAT =
  `Always finish by recording ${SHAPE}` +
  `If the changed code is not reachable by the harness (for example webview DOM the uat:host probe cannot see, or code behind the faked agent core), ` +
  `say so inside that same entry as SKIPPED with the reason and what else covers it.`;

export const COVERAGE_RULE_REVIEW =
  `Always finish by recording ${SHAPE}` +
  `Name the areas you reviewed and any you skipped and why. This entry is advisory and never counts as a finding.`;

export function isCoverageRecord(f: { title: string }): boolean {
  return f.title.startsWith(COVERAGE_PREFIX);
}

/** Status word right after the prefix; anything unstated reads as NOT RUN. */
export function coverageStatus(title: string): CoverageStatus {
  const rest = title.slice(COVERAGE_PREFIX.length);
  return STATUSES.find((s) => rest.startsWith(s)) ?? 'NOT RUN';
}

export function splitCoverage<T extends { title: string }>(items: readonly T[]): { coverage: T[]; rest: T[] } {
  const coverage: T[] = [];
  const rest: T[] = [];
  for (const i of items) (isCoverageRecord(i) ? coverage : rest).push(i);
  return { coverage, rest };
}

/** Title of the host's fallback when the agent returned no record. */
export const COVERAGE_FALLBACK_TITLE = `${COVERAGE_PREFIX}NOT RUN — the agent reported no coverage record`;

/**
 * The one record to keep: the agent's first (forced to info), else a
 * deterministic NOT RUN entry made by `fallback`, so silence is never ambiguous.
 */
export function coverageOrFallback<T extends { severity: string; title: string }>(
  coverage: readonly T[],
  fallback?: (title: string) => T,
): T {
  const first = coverage[0];
  if (first) return { ...first, severity: 'info' };
  return fallback ? fallback(COVERAGE_FALLBACK_TITLE) : ({ severity: 'info', title: COVERAGE_FALLBACK_TITLE } as T);
}
