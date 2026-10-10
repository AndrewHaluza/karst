/**
 * Ratchet ledger for the layout-sanity gate: match / seed / prune as pure
 * functions (the teardown test owns the file IO and env reads).
 *
 * The ledger (tests/visual/layout-known-failures.json) is the only exemption.
 * A failure it does not list fails the gate; an entry that no longer reproduces
 * fails too, so the ledger only shrinks. Stale entries are judged ONLY over the
 * route x width pairs that actually ran, so a filtered run never reports other
 * routes stale. Docker is authoritative for ledger geometry (host and docker
 * render differently), so seed and prune refuse without `authoritative`.
 */
import { failureKey, type LayoutFailure } from './layoutChecks.js';

/** Identity of one test: the routes x widths a shard set covers. */
export function runKey(route: string, width: number): string {
  return `${route}|${width}`;
}

/** `route|width` prefix of a ledger key (the selector may itself contain `|`). */
function runKeyOf(ledgerKey: string): string {
  const first = ledgerKey.indexOf('|');
  const second = ledgerKey.indexOf('|', first + 1);
  return second === -1 ? ledgerKey : ledgerKey.slice(0, second);
}

export interface LedgerResult {
  /** Failures the ledger does not list. */
  readonly unexpected: readonly LayoutFailure[];
  /** Ledger keys of routes that ran and no longer reproduce; delete them. */
  readonly stale: readonly string[];
}

export function matchLedger(
  failures: readonly LayoutFailure[],
  ledger: readonly string[],
  ran: ReadonlySet<string>,
): LedgerResult {
  const known = new Set(ledger);
  const seen = new Set(failures.map(failureKey));
  return {
    unexpected: failures.filter((f) => !known.has(failureKey(f))),
    stale: ledger.filter((key) => ran.has(runKeyOf(key)) && !seen.has(key)),
  };
}

/** True when every expected route x width test produced a shard. */
export function isFullRun(ran: ReadonlySet<string>, expected: readonly string[]): boolean {
  return expected.every((key) => ran.has(key));
}

export interface LedgerGuard {
  readonly authoritative: boolean;
  readonly fullRun: boolean;
}

function requireGuard(op: 'seed' | 'prune', guard: LedgerGuard): void {
  if (!guard.authoritative) {
    throw new Error(`layout ledger ${op} refused: run it via npm run test:layout:docker:${op} (KARST_LAYOUT_AUTHORITATIVE=1)`);
  }
  if (!guard.fullRun) {
    throw new Error(`layout ledger ${op} refused: the run was filtered; run every route (no file filter)`);
  }
}

/** One-time: the ledger is exactly the current failures. Refuses if one exists. */
export function seed(
  failures: readonly LayoutFailure[],
  existing: readonly string[] | null,
  guard: LedgerGuard,
): string[] {
  requireGuard('seed', guard);
  if (existing !== null) {
    throw new Error('layout ledger seed refused: tests/visual/layout-known-failures.json already exists (seeding is one-time; use prune)');
  }
  return Array.from(new Set(failures.map(failureKey))).sort();
}

/** Removes stale entries only; never adds. */
export function prune(
  failures: readonly LayoutFailure[],
  ledger: readonly string[],
  ran: ReadonlySet<string>,
  guard: LedgerGuard,
): string[] {
  requireGuard('prune', guard);
  const stale = new Set(matchLedger(failures, ledger, ran).stale);
  return ledger.filter((key) => !stale.has(key));
}
