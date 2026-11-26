/**
 * Pure unit logic for the graph limit rows of the Edit drawer (spec Edit 2).
 *
 * A limit is stored in the manifest as canonical seconds, bytes, or a count.
 * The drawer shows it as an amount plus a unit:
 *
 * - duration fields (`*Seconds`) use s, min, hours;
 * - byte fields (`*Bytes`) use KiB, MiB, GiB;
 * - count fields have no unit.
 *
 * `toDisplay` picks the LARGEST unit in which the value is a whole amount, and
 * `fromDisplay` gives the canonical value back. The round trip is exact (an
 * invariant of the ticket): a byte value that is whole in no unit shows as a
 * fraction of KiB, and a division by 1024 is exact in floating point.
 *
 * The defaults and ceilings are IMPORTED from `graphConfig.ts` (R-X1): a
 * restated number is a number that can drift from the validator.
 */
import { DEFAULT_GRAPH_LIMITS, GRAPH_HARD_CEILINGS } from '../../../../manifest/graphConfig.js';
import type { GraphLimitField } from './approachDraft.js';

export type DurationUnit = 's' | 'min' | 'hours';
export type ByteUnit = 'KiB' | 'MiB' | 'GiB';
export type LimitUnit = DurationUnit | ByteUnit;
export type LimitKind = 'duration' | 'bytes' | 'count';

/** One displayed limit value. `unit` is `null` for a count. */
export interface LimitDisplay {
  readonly amount: number;
  readonly unit: LimitUnit | null;
}

/** The size of each unit in canonical seconds or bytes, smallest first. */
const DURATION_UNITS: readonly (readonly [DurationUnit, number])[] = [
  ['s', 1],
  ['min', 60],
  ['hours', 3600],
];
const BYTE_UNITS: readonly (readonly [ByteUnit, number])[] = [
  ['KiB', 1024],
  ['MiB', 1024 * 1024],
  ['GiB', 1024 * 1024 * 1024],
];

/** The short unit text the hints use ("24 h", "30 min"). */
const HINT_UNIT: Readonly<Record<LimitUnit, string>> = {
  s: 's',
  min: 'min',
  hours: 'h',
  KiB: 'KiB',
  MiB: 'MiB',
  GiB: 'GiB',
};

/** The kind of a limit field, from its key suffix. */
export function limitKind(field: GraphLimitField): LimitKind {
  if (field.endsWith('Seconds')) return 'duration';
  if (field.endsWith('Bytes')) return 'bytes';
  return 'count';
}

function scaleFor(kind: LimitKind): readonly (readonly [LimitUnit, number])[] {
  if (kind === 'duration') return DURATION_UNITS;
  if (kind === 'bytes') return BYTE_UNITS;
  return [];
}

/** The units the unit select offers for `field`; empty for a count. */
export function unitsFor(field: GraphLimitField): readonly LimitUnit[] {
  return scaleFor(limitKind(field)).map(([unit]) => unit);
}

function displayFor(kind: LimitKind, value: number): LimitDisplay {
  const scale = scaleFor(kind);
  const smallest = scale[0];
  if (!smallest) return { amount: value, unit: null };
  for (let i = scale.length - 1; i >= 0; i -= 1) {
    const [unit, size] = scale[i]!;
    if (value % size === 0) return { amount: value / size, unit };
  }
  return { amount: value / smallest[1], unit: smallest[0] };
}

/** The canonical `value` as an amount in the largest unit with a whole amount. */
export function toDisplay(field: GraphLimitField, value: number): LimitDisplay {
  return displayFor(limitKind(field), value);
}

/** The canonical seconds or bytes for `amount` in `unit` (a count is unchanged). */
export function fromDisplay(field: GraphLimitField, amount: number, unit: LimitUnit | null): number {
  const size = scaleFor(limitKind(field)).find(([name]) => name === unit)?.[1] ?? 1;
  return amount * size;
}

function human(kind: LimitKind, value: number): string {
  const shown = displayFor(kind, value);
  return shown.unit === null ? String(shown.amount) : `${shown.amount} ${HINT_UNIT[shown.unit]}`;
}

/** A duration in seconds in human units ("2 h"), for the command timeout row. */
export function humanDuration(seconds: number): string {
  return human('duration', seconds);
}

/** The row help: `default <human> · max <human>`. */
export function limitHint(field: GraphLimitField): string {
  const kind = limitKind(field);
  return `default ${human(kind, DEFAULT_GRAPH_LIMITS[field])} · max ${human(kind, GRAPH_HARD_CEILINGS[field])}`;
}

/** The canonical value the typed `text` in `unit` gives, or `null` if it is not a number. */
export function parseDisplay(field: GraphLimitField, text: string, unit: LimitUnit | null): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const amount = Number(trimmed);
  return Number.isFinite(amount) ? fromDisplay(field, amount, unit) : null;
}

/**
 * The row error for the typed `text` in `unit`, or `null` when it is valid: the
 * canonical value must be a positive whole number at or under the ceiling.
 */
export function limitError(
  field: GraphLimitField,
  label: string,
  text: string,
  unit: LimitUnit | null,
): string | null {
  const value = parseDisplay(field, text, unit);
  if (value === null || !Number.isInteger(value) || value <= 0) {
    return `${label} must be a whole number above 0.`;
  }
  const ceiling = GRAPH_HARD_CEILINGS[field];
  if (value > ceiling) return `${label} must be ${human(limitKind(field), ceiling)} or less.`;
  return null;
}
