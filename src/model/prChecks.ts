/**
 * The CI rollup and GitHub's merge verdict, as karst stores and renders them.
 *
 * Both are DISPLAY data cached in the registry, not a mirror of GitHub's check
 * model: gh is the source of truth, and the next sweep corrects whatever moved.
 * Pure — no gh vocabulary, no store, no clock — so the two normalizers that DO
 * know gh's JSON (`src/integrations/prChecks.ts`) and the panel that words the
 * result (`src/model/prChecksView.ts`) both stay replaceable on their own.
 */

/**
 * The rollup as a reader needs it: one word, four counts, and the failures by
 * name. 'unknown' is gh's non-answer, NOT a verdict — see the store's write rule.
 */
export type ChecksState = 'passing' | 'failing' | 'pending' | 'none' | 'unknown';

/** One failed check: its name and where the run can be read. */
export interface FailingCheck {
  /** The check's name, bounded to 120 chars (untrusted upstream prose). */
  name: string;
  /** The run url, or null when gh named none. */
  url: string | null;
}

export interface PrChecks {
  state: ChecksState;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** The failures, in rollup order, capped at MAX_FAILING_CHECKS. */
  failing: readonly FailingCheck[];
  /** How many failed in total, when more failed than `failing` carries. */
  failedShown: number;
}

/**
 * GitHub's answer to "will this merge", normalized. 'unknown' is its lazily
 * computed non-answer and must never read as a block.
 */
export type MergeBlock =
  | 'clean' | 'blocked' | 'behind' | 'dirty' | 'unstable' | 'draft' | 'has_hooks' | 'unknown';

export const MAX_FAILING_CHECKS = 10;

export const UNKNOWN_PR_CHECKS: PrChecks = {
  state: 'unknown', total: 0, passed: 0, failed: 0, pending: 0, failing: [], failedShown: 0,
};

const CHECK_STATES: readonly ChecksState[] = ['passing', 'failing', 'pending', 'none', 'unknown'];

const MERGE_BLOCKS: readonly MergeBlock[] = [
  'clean', 'blocked', 'behind', 'dirty', 'unstable', 'draft', 'has_hooks', 'unknown',
];

/**
 * The `prs.merge_block` column → the verdict. An unrecognised token reads as
 * 'unknown', never as a block or as 'clean': a row written by a newer karst, or
 * corrupted, must not be able to claim GitHub refuses this merge — nor that it
 * allows it. The same rule `parseState` states in store/mergeChecks.ts.
 */
export function readMergeBlock(raw: string | null): MergeBlock {
  return raw !== null && (MERGE_BLOCKS as readonly string[]).includes(raw)
    ? (raw as MergeBlock)
    : 'unknown';
}

/**
 * The rollup → the `prs.checks` column. null stays null: "never probed". A
 * rollup whose state is 'unknown' also serializes to null, because an unknown is
 * not a value to store — it must leave whatever was stored before alone.
 */
export function serializeChecks(checks: PrChecks | null): string | null {
  if (checks === null || checks.state === 'unknown') return null;
  return JSON.stringify(checks);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function failingChecks(raw: unknown): FailingCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .filter((c) => typeof c.name === 'string')
    .map((c) => ({
      name: c.name as string,
      url: typeof c.url === 'string' && c.url !== '' ? c.url : null,
    }));
}

/**
 * The `prs.checks` column → the rollup. Never throws: a NULL, empty, malformed,
 * non-object, or unrecognised-state column reads as null (no chip) rather than
 * taking the panel down — the column is a display cache, gh remains the truth.
 */
export function parseChecks(raw: string | null | undefined): PrChecks | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.state !== 'string' || !CHECK_STATES.includes(o.state as ChecksState)) return null;
  return {
    state: o.state as ChecksState,
    total: count(o.total),
    passed: count(o.passed),
    failed: count(o.failed),
    pending: count(o.pending),
    failing: failingChecks(o.failing),
    failedShown: count(o.failedShown),
  };
}
