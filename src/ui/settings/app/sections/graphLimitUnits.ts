/**
 * Pure unit helpers for the graph limit rows.
 *
 * Moved verbatim out of `ApproachesSection.tsx` with no behavior change: the
 * hint half of vanilla's `graphLimitRowHtml` and the two human formatters it
 * reads. A later change replaces them with the display-unit round trip
 * (`toDisplay` / `fromDisplay` / `limitHint`); until then they stay as they
 * were, so the rendered hints do not move.
 */
import type { GraphLimitField } from './approachDraft.js';

/** Byte budgets render as byte counts, everything else as durations (vanilla). */
export function isByteLimit(field: GraphLimitField): boolean {
  return (
    field.startsWith('maxAggregate') ||
    field.startsWith('maxArtifact') ||
    field === 'maxLogBytes'
  );
}

/** Vanilla's `formatSeconds` — the hint's human form of a second budget. */
export function formatSeconds(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Vanilla's `formatBytes` — the hint's human form of a byte budget. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit] ?? 'B'}`;
}

/**
 * The hint half of vanilla's `graphLimitRowHtml`: `packaged <default> (…)
 * · hard ceiling <ceiling> (…)`. The two VALUES are read from the imported
 * constants at the call site, so the row cannot show a ceiling the validator
 * does not enforce.
 */
export function budgetHint(field: GraphLimitField, packaged: number, ceiling: number): string {
  const format = isByteLimit(field) ? formatBytes : formatSeconds;
  return `packaged ${packaged} (${format(packaged)}) · hard ceiling ${ceiling} (${format(ceiling)})`;
}
