import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';

/**
 * One recorded gate result — what a gate runner reported, kept after the fact.
 *
 * `exitCode: null` means the repo defines no such script, so karst had no
 * question to ask. That is neither a pass nor a fail, and it must never be
 * flattened into `0`: a gate that could not run did not go green.
 */
export interface GateRun {
  id: number;
  ticketId: number;
  stageKey: StageKey;
  attempt: number;
  /** Batch stamp shared by every gate of one runner invocation. */
  runAt: string;
  gateName: string;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * v21 invocation identity. NULL on a row recorded before these columns
   * existed, and on the 'changes' evidence row (Changes panel opened), which
   * names no command. Never backfilled — see migrations.ts v21.
   */
  repo: string | null;
  command: string | null;
  args: string[] | null;
  /**
   * v24: this gate resolved for the ticket and was deliberately NOT run,
   * because the user disabled it for this ticket alone (`tickets.disabled_gates`).
   *
   * A different fact from `exitCode === null`, which means the repo defines no
   * such script. Conflating the two would make a disabled gate read as a
   * missing script (or the reverse), so this is its own column. `false` for
   * every row written before v24 — nothing was ever skipped then.
   */
  skipped: boolean;
}

/** One gate as a runner reports it, before it has an id or a batch stamp. */
export interface GateRunInput {
  gateName: string;
  exitCode: number | null;
  /** Absent for a gate that never ran — it has no duration to state. */
  startedAt?: string | null;
  endedAt?: string | null;
  /**
   * v21 invocation identity — what actually ran. Absent/null for evidence that
   * is not a gate invocation (e.g. the 'changes' row) or for a caller that has
   * none to give; never invented on this side either.
   */
  repo?: string | null;
  command?: string | null;
  args?: readonly string[] | null;
  /** v24: recorded because it was disabled for this ticket, not because it ran. */
  skipped?: boolean;
}

export interface GateRunBatch {
  ticketId: number;
  stageKey: StageKey;
  /** The stage's attempt at the moment this batch ran. */
  attempt: number;
  runAt: string;
  gates: readonly GateRunInput[];
}

interface GateRunRow {
  id: number;
  ticket_id: number;
  stage_key: string;
  attempt: number;
  run_at: string;
  gate_name: string;
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  repo: string | null;
  command: string | null;
  args: string | null; // JSON array, or NULL
  skipped: number | null;
}

/**
 * Parse the stored `args` JSON column, tolerating bad data. `null` returns
 * `null` — no identity was given, nothing to parse. Anything else that fails
 * to parse, or parses to something other than an array of strings (a number,
 * an object, `[1, 2]`), also returns `null` rather than throwing: this read
 * path is on both the review-stage rendering path and the R7 aggregation
 * path, and `gate_runs` is append-only evidence — one corrupted historical
 * row must degrade, not take the panel (or the aggregation) down. Matches the
 * house convention (`parseFiles` in mergeChecks.ts, `parseSelectedRepos` in
 * tickets.ts): data written by this module is always well-formed, so this
 * guards the boundary, not the writer.
 */
function parseArgs(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string')) {
      return parsed;
    }
  } catch {
    // fall through to the null return below
  }
  return null;
}

function rowToGateRun(r: GateRunRow): GateRun {
  const args = parseArgs(r.args);
  // A row whose `args` column was PRESENT but did not parse to a string[] is
  // corrupted, and none of what it claims to have invoked can be trusted —
  // reading `repo`/`command` off it while only blanking `args` would leave
  // `sameGateIdentity` comparing a garbled row's args as `[]` (its "both sides
  // carry a command" branch reads `args ?? []`), which could accidentally
  // MATCH a genuinely different, argument-less invocation of the same
  // repo+command. So a corrupted `args` degrades the WHOLE identity to
  // absent, exactly like a pre-v21 row that never carried one — never a
  // partial, guessed identity.
  const corrupt = r.args !== null && args === null;
  return {
    id: r.id,
    ticketId: r.ticket_id,
    stageKey: r.stage_key as StageKey,
    attempt: r.attempt,
    runAt: r.run_at,
    gateName: r.gate_name,
    exitCode: r.exit_code,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    repo: corrupt ? null : r.repo,
    command: corrupt ? null : r.command,
    args,
    // Strictly `1`. A NULL is a pre-v24 row and a 0 is an explicit "it ran";
    // both are "not skipped", and neither is guessed at.
    skipped: r.skipped === 1,
  };
}

/**
 * Append one runner invocation's gates. Taken as a batch, not gate by gate, so
 * every row of one invocation shares `runAt` and the batch can be recovered
 * later without depending on `attempt` (which does not increment on a pass).
 *
 * Deliberately opens no transaction of its own: it is called from inside
 * `transition`'s premutate, so the gates and the verdict they produced commit
 * together or not at all.
 */
export function recordGateRun(store: Store, batch: GateRunBatch): void {
  const insert = store.db.prepare(
    `INSERT INTO gate_runs
       (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, started_at, ended_at,
        repo, command, args, skipped)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const g of batch.gates) {
    insert.run(
      batch.ticketId,
      batch.stageKey,
      batch.attempt,
      batch.runAt,
      g.gateName,
      g.exitCode,
      g.startedAt ?? null,
      g.endedAt ?? null,
      g.repo ?? null,
      g.command ?? null,
      g.args ? JSON.stringify(g.args) : null,
      g.skipped ? 1 : null,
    );
  }
}

/**
 * Every gate ever recorded for a ticket, oldest first (insertion order is run
 * order). Returns everything and groups nothing: picking "the latest batch" is a
 * pure decision that belongs in the model layer, where it is testable without a
 * database.
 */
export function listGateRuns(store: Store, ticketId: number): GateRun[] {
  return store.db
    .prepare(
      `SELECT id, ticket_id, stage_key, attempt, run_at, gate_name, exit_code,
              started_at, ended_at, repo, command, args, skipped
         FROM gate_runs
        WHERE ticket_id = ?
        ORDER BY id`,
    )
    .all(ticketId)
    .map((r) => rowToGateRun(r as GateRunRow));
}
