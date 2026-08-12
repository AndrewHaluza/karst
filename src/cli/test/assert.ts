import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { parseFlags, requireFlag, type TestFlags } from './flags.js';

/**
 * `karst test assert` — compare a ticket's state against an expected object and
 * exit 0 on a match, 1 on a mismatch with a leaf-level diff.
 *
 * The comparison is a recursive, PARTIAL match over a closed projection of the
 * ticket (`stageCurrent`, `agentState`, and `stages` — a map of stageKey →
 * status). Only the keys the expectation names are compared, so
 * `--expect '{"stageCurrent":"done"}'` checks exactly that one fact and ignores
 * the rest. A mismatch exits 1 via `AssertionMismatchError`, which the CLI
 * process wrapper renders as `{"ok":false,"diff":…}` on stdout before exiting 1
 * (see main.ts) — the shell test scripts the ticket ships depend on that exit
 * code, while `runCli`-level tests catch the error and read `.diff`.
 */

export interface AssertDiff {
  [path: string]: { expected: unknown; actual: unknown };
}

/** The closed projection `assert` compares against. */
export function actualState(store: Store, ticketId: number): Record<string, unknown> {
  const ticket = getTicket(store, ticketId);
  const stages: Record<string, string> = {};
  for (const s of ticket.stages) stages[s.stageKey] = s.status;
  return {
    stageCurrent: ticket.stageCurrent,
    agentState: ticket.agentState,
    stages,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}

function diffAt(
  path: string,
  expected: unknown,
  actual: unknown,
  out: AssertDiff,
): void {
  if (
    typeof expected === 'object' &&
    expected !== null &&
    !Array.isArray(expected)
  ) {
    for (const [k, v] of Object.entries(expected)) {
      diffAt(path === '' ? k : `${path}.${k}`, v, (actual as Record<string, unknown> | null)?.[k], out);
    }
    return;
  }
  if (!deepEqual(expected, actual)) {
    out[path] = { expected, actual: actual ?? null };
  }
}

export interface ParsedAssert {
  expect: string;
}

export function parseAssertArgs(argv: string[]): ParsedAssert {
  const flags: TestFlags = parseFlags(argv);
  return { expect: requireFlag(flags, 'expect') };
}

/** Thrown on a mismatch; the CLI wrapper turns `.diff` into exit-code-1 JSON. */
export class AssertionMismatchError extends Error {
  readonly diff: AssertDiff;

  constructor(diff: AssertDiff) {
    super('test assertion failed');
    this.name = 'AssertionMismatchError';
    this.diff = diff;
  }
}

export function runAssert(store: Store, ticketId: number, parsed: ParsedAssert): string {
  let expected: unknown;
  try {
    expected = JSON.parse(parsed.expect);
  } catch {
    throw new Error(`--expect must be a JSON object (got '${parsed.expect}')`);
  }
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    throw new Error(`--expect must be a JSON object (got '${parsed.expect}')`);
  }
  const actual = actualState(store, ticketId);
  const diff: AssertDiff = {};
  diffAt('', expected, actual, diff);
  if (Object.keys(diff).length > 0) {
    throw new AssertionMismatchError(diff);
  }
  return JSON.stringify({ ok: true });
}
