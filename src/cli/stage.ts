import type { Store } from '../store/db.js';
import type { StageKey, Verdict } from '../model/types.js';
import { MARKER_STAGES, isMarkerStage, type MarkerStage } from '../agent/markerStage.js';
import { transition as defaultTransition } from '../workflow/machine.js';
import { markImplementDone } from '../workflow/stages/implement.js';
import { markFixDone } from '../workflow/fixExecution.js';

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

/**
 * The one marker state a stage may not be marked done in: the agent asked the
 * user a question and is blocked on their input. A stage whose agent is
 * WAITING cannot be complete — the agent literally stopped to ask, so its
 * work is not done. Refusing the marker here is what stops the "marker fired
 * when the agent asked me a question" premature-advance (the writing-plans
 * handoff asks "Which approach?" — the ticket must stay at impl until the
 * user answers and the agent actually finishes).
 *
 * `null` (no agent yet) and `running`/`idle` are NOT refused: `running` is
 * the normal state while the agent fires the marker from within its session,
 * and `idle` is a finished session the marker may legitimately close.
 */
export function assertMarkerNotWhileWaiting(
  agentState: string | null | undefined,
): void {
  if (agentState === 'waiting') {
    throw new Error(
      'cannot mark this stage done: the agent is currently waiting for your input ' +
        '(it asked a question). A stage whose agent is waiting on the user is not complete — ' +
        'answer the question, then re-fire the marker when the work is actually done.',
    );
  }
}

/** Parse argv and apply the transition for `ticketId`; returns the next stage. */
export function runStageCommand(
  store: Store,
  ticketId: number,
  argv: string[],
  transition: TransitionFn = defaultTransition,
  ticket?: { agentState?: string | null },
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
  // The impl marker routes through markImplementDone, never directly through
  // the generic transition: completing the stable implementation run (closing
  // its segment and Session process run, passing the run) is part of the
  // marker's job, folded into the SAME transaction as the stage advance.
  if (stage === 'impl') return markImplementDone(store, ticketId, transition);
  // The fix marker routes through markFixDone for the same reason one level
  // down: completing the recovery round (passing the linked Fix process run,
  // moving the round to revalidating) is part of the marker's job, folded into
  // the SAME transaction as the fix→uat advance. A ticket with no committed
  // round (pre-v30) transitions untracked.
  return markFixDone(store, ticketId, transition);
}
