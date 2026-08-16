import type { Store } from '../store/db.js';
import type { StageKey, Verdict } from '../model/types.js';
import { MARKER_STAGES, isMarkerStage, type MarkerStage } from '../agent/markerStage.js';
import { transition as defaultTransition } from '../workflow/machine.js';
import { graphImplMarkerGuard, graphApproachMissingRun } from '../workflow/graphMarkerGuard.js';
import { BUILT_IN_PACKAGE_ID } from '../approaches/builtInId.js';
import { markImplementDone } from '../workflow/stages/implement.js';
import { markFixDone } from '../workflow/fixExecution.js';
import { assertMarkerNotWhileWaiting } from '../workflow/markerGuard.js';

export { assertMarkerNotWhileWaiting };

/**
 * The `karst stage <impl|fix> pass` CLI — a thin wrapper over `transition()`
 * (T4.1), the marker path an agent uses to advance a boundary that has no
 * deterministic verdict of its own (§5.4). It is NOT a separate stage — it just
 * parses argv and calls the machine.
 *
 * The surface is deliberately two stages and one verdict wide:
 *
 *  - **Stages** narrow to `MARKER_STAGES`. Accepting the full `STAGE_KEYS` set
 *    let `stage ship pass` force a passed verdict on a gate that never ran,
 *    bypassing tests, gates and the PR-open flow — an agent self-reporting a
 *    deterministic verdict, which §5.4 forbids. The invoking agent reads ticket
 *    content it did not author, so prompt injection makes that reachable.
 *  - **Verdicts** narrow to `pass`. Neither marker stage has a `failed` edge, so
 *    a parsed `fail` could only ever throw in the machine; rejecting it here
 *    names the mistake instead of explaining the graph.
 */

/**
 * Compose the `node <cli> stage <stage> pass --db <db> --ticket` prefix the agent
 * appends a ticket key to (`$ARGUMENTS`, or a concrete key in the launch seed) to
 * record the done marker for the stage it is working on.
 *
 * `stage` defaults to `impl` — the generated `/karst:<id>` command is
 * materialized once and only ever covers the impl boundary. A session resumed at
 * `fix` must be seeded `fix` instead, or the agent fires the wrong marker and the
 * ticket never leaves fix.
 *
 * `manifestPath` is optional but load-bearing once several projects share one
 * DB: it names the project the key belongs to. Without it a key two projects
 * both use resolves to whichever row is older, and the marker advances the
 * wrong board.
 *
 * Paths are double-quoted so spaces survive. Pure (no fs) so it is testable.
 */
export function composeStageCommand(
  cliEntry: string,
  dbPath: string,
  stage: MarkerStage = 'impl',
  manifestPath?: string,
): string {
  const q = (s: string): string => `"${s}"`;
  return [
    'node',
    q(cliEntry),
    'stage',
    stage,
    'pass',
    '--db',
    q(dbPath),
    ...(manifestPath ? ['--manifest', q(manifestPath)] : []),
    '--ticket',
  ].join(' ');
}

export interface ParsedStage {
  stage: MarkerStage;
  verdict: { kind: 'passed' };
}

/**
 * Parse `['stage', <impl|fix>, 'pass']` at the system boundary. Fails fast with a
 * clear message on anything malformed — never trust argv.
 */
export function parseStageArgs(argv: string[]): ParsedStage {
  const [cmd, stage, word] = argv;
  if (cmd !== 'stage') {
    throw new Error(`expected 'stage' command, got '${cmd ?? ''}'`);
  }
  if (!stage || !isMarkerStage(stage)) {
    throw new Error(
      `cannot mark stage '${stage ?? ''}' (want one of ${MARKER_STAGES.join(', ')}) — ` +
        'a gate verdict comes from its exit code, not from the agent',
    );
  }
  if (word !== 'pass') {
    throw new Error(`unknown verdict '${word ?? ''}' (the marker records 'pass' only)`);
  }
  return { stage, verdict: { kind: 'passed' } };
}

/** The machine call the CLI performs — injected so the command is unit-testable. */
export type TransitionFn = (
  store: Store,
  ticketId: number,
  from: StageKey,
  verdict: Verdict,
) => StageKey;

/** The ticket a marker is fired for, as far as the CLI knows it. */
export interface StageCommandTicket {
  agentState?: string | null;
  stageCurrent?: string | null;
}

/**
 * The stages whose verdict comes from gate exit codes — the ones a marker can
 * never advance. Kept local so this parse path (the marker boundary) names them
 * itself rather than importing the machine's notion of a gate stage.
 */
const GATE_DECIDED_STAGES: readonly string[] = ['uat', 'review', 'ship'];

/**
 * Name the marker refusal when the fired stage is not the ticket's current one.
 *
 * The machine's backstop (`transition`) says only *that* the stages disagree;
 * this says what to do instead. A marker fired at a ticket that already left
 * the stage is the most common self-inflicted refusal — "I finished testing
 * and fired `stage impl pass` but the ticket had already moved to review" —
 * and the raw mismatch reads as a machine error, not as an instruction. The
 * marker surface is deliberately two stages wide (`impl`/`fix`), so the useful
 * correction is always: name the current stage, and name the marker that IS
 * valid there (or explain that none is).
 */
function markerRefusalMessage(ticketId: number, from: MarkerStage, current: string): string {
  const where = `ticket ${ticketId} is already at stage '${current}'`;
  if (current === 'fix' && from === 'impl') {
    return `${where} — the marker for fix is 'stage fix pass', not 'stage impl pass'.`;
  }
  if (current === 'impl' && from === 'fix') {
    return `${where} — the marker for impl is 'stage impl pass'.`;
  }
  if (current === 'done') {
    return `${where} — a done ticket has no marker to fire.`;
  }
  if ((GATE_DECIDED_STAGES as readonly string[]).includes(current)) {
    return (
      `${where}. '${current}' is decided by its gate exit codes, never by the marker — ` +
      `nothing you run advances it, and there is no marker to fire there. Re-read ` +
      '`karst context` to see where the ticket actually is before acting.'
    );
  }
  return `${where}, not '${from}'.`;
}

/** The ticket's current stage, preferring the caller's snapshot over a store read. */
function currentStageOf(
  store: Store,
  ticketId: number,
  ticket?: StageCommandTicket,
): string | null {
  if (ticket?.stageCurrent !== undefined) return ticket.stageCurrent;
  if (!store.db) return null;
  const row = store.db
    .prepare('SELECT stage_current AS stageCurrent FROM tickets WHERE id = ?')
    .get(ticketId) as { stageCurrent: string | null } | undefined;
  return row?.stageCurrent ?? null;
}

/** Parse argv and apply the transition for `ticketId`; returns the next stage. */
export function runStageCommand(
  store: Store,
  ticketId: number,
  argv: string[],
  transition: TransitionFn = defaultTransition,
  ticket?: StageCommandTicket,
): StageKey {
  const { stage, verdict } = parseStageArgs(argv);
  // The marker is the agent's claim that the stage's work is done. If the
  // agent is currently waiting for the user (it asked a question), that claim
  // is false by construction — refuse before any transition, so the ticket
  // cannot be advanced while the user is being asked for input. The caller
  // hands the resolved ticket when it has one (the CLI); a bare call reads the
  // live agent_state from the store. The test seam may stub the store without
  // `db` — the check simply does not apply then.
  const agentState =
    ticket?.agentState !== undefined
      ? ticket.agentState
      : store.db
        ? (
            store.db
              .prepare('SELECT agent_state FROM tickets WHERE id = ?')
              .get(ticketId) as { agent_state: string | null } | undefined
          )?.agent_state ?? null
        : undefined;
  assertMarkerNotWhileWaiting(agentState);
  // A marker fired for a stage the ticket already left is the agent's most
  // common self-inflicted refusal, and the machine's generic mismatch message
  // is the cryptic part of it — "stage 'impl' is not ticket 355's current
  // stage (review)" tells the agent its command was wrong but not what the
  // right one is. Name the current stage and the marker that IS valid there
  // BEFORE any transition (the graph guard and the run bookkeeping below stay
  // untouched — a refused marker mutates nothing). The machine keeps its own
  // guard as the backstop for every non-CLI transition.
  const current = currentStageOf(store, ticketId, ticket);
  if (current !== null && current !== stage) {
    throw new Error(markerRefusalMessage(ticketId, stage, current));
  }
  // A graph ticket's impl marker routes through the graph marker guard (the
  // ONLY graph/stage boundary, Slice-3 T9): the graph run closes and the
  // stage advances in one transaction, and an earlier/non-quiescent marker is
  // rejected without mutation. The graph has no stable implementation run, so
  // markImplementDone's run bookkeeping never applies.
  if (stage === 'impl') {
    // The store is the real db-backed store in production; the test seam may
    // stub it without `db` — the graph check simply does not apply then.
    const hasGraphRun = store.db
      ? (
          store.db
            .prepare('SELECT 1 AS n FROM approach_graph_runs WHERE ticket_id = ? LIMIT 1')
            .get(ticketId) as { n: number } | undefined
        ) !== undefined
      : false;
    if (hasGraphRun) {
      const result = graphImplMarkerGuard(store, ticketId);
      if (!result.ok) {
        throw new Error(`graph marker refused: ${result.reason}`);
      }
      return 'uat';
    }
    // A graph-approach ticket with NO graph run at all (bootstrap failed, the
    // run was cancelled, a misconfiguration) must never fall through to the
    // plain marker below — that would advance the ticket with zero graph
    // work performed. Refuse the marker, name why, and leave the ticket
    // exactly where it is.
    if (store.db && graphApproachMissingRun(store, ticketId)) {
      throw new Error(
        `graph marker refused: no graph run for ticket ${ticketId} (approach ${BUILT_IN_PACKAGE_ID})`,
      );
    }
    // The impl marker routes through markImplementDone, never directly through
    // the generic transition: completing the stable implementation run (closing
    // its segment and Session process run, passing the run) is part of the
    // marker's job, folded into the SAME transaction as the stage advance.
    return markImplementDone(store, ticketId, transition);
  }
  // The fix marker routes through markFixDone for the same reason one level
  // down: completing the recovery round (passing the linked Fix process run,
  // moving the round to revalidating) is part of the marker's job, folded into
  // the SAME transaction as the fix→uat advance. A ticket with no committed
  // round (pre-v30) transitions untracked.
  return markFixDone(store, ticketId, transition);
}
