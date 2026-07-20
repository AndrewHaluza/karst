import type { Store } from '../store/db.js';
import type { StageKey, Verdict } from '../model/types.js';
import { MARKER_STAGES, isMarkerStage, type MarkerStage } from '../agent/markerStage.js';
import { transition as defaultTransition } from '../workflow/machine.js';

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

/** Parse argv and apply the transition for `ticketId`; returns the next stage. */
export function runStageCommand(
  store: Store,
  ticketId: number,
  argv: string[],
  transition: TransitionFn = defaultTransition,
): StageKey {
  const { stage, verdict } = parseStageArgs(argv);
  return transition(store, ticketId, stage, verdict);
}
