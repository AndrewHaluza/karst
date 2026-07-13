import type { Store } from '../store/db.js';
import type { StageKey, Verdict } from '../model/types.js';
import { STAGE_KEYS } from '../model/types.js';
import { transition as defaultTransition } from '../workflow/machine.js';

/**
 * The `karst stage <key> <pass|fail> [reason]` CLI — a thin wrapper over
 * `transition()` (T4.1), the marker path an agent uses to advance a stage it
 * cannot self-report a deterministic verdict for (e.g. the impl boundary, §5.4).
 * It is NOT a separate stage — it just parses argv and calls the machine.
 */

export interface ParsedStage {
  stage: StageKey;
  verdict: Exclude<Verdict, null>;
}

function isStageKey(v: string): v is StageKey {
  return (STAGE_KEYS as readonly string[]).includes(v);
}

/**
 * Parse `['stage', <key>, <pass|fail>, ...reason]` at the system boundary.
 * Fails fast with a clear message on anything malformed — never trust argv.
 */
export function parseStageArgs(argv: string[]): ParsedStage {
  const [cmd, stage, word, ...rest] = argv;
  if (cmd !== 'stage') {
    throw new Error(`expected 'stage' command, got '${cmd ?? ''}'`);
  }
  if (!stage || !isStageKey(stage)) {
    throw new Error(`unknown stage key '${stage ?? ''}' (want one of ${STAGE_KEYS.join(', ')})`);
  }
  if (word === 'pass') {
    return { stage, verdict: { kind: 'passed' } };
  }
  if (word === 'fail') {
    const reason = rest.join(' ').trim();
    return { stage, verdict: reason ? { kind: 'failed', reason } : { kind: 'failed' } };
  }
  throw new Error(`unknown verdict '${word ?? ''}' (want 'pass' or 'fail')`);
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
