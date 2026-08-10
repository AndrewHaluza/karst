import { nowIso } from '../../model/time.js';
import type { GateResult } from './result.js';
import type { ResolvedGate } from './resolve.js';
import { runProcess } from './run.js';

/**
 * Run a resolved gate list sequentially in one worktree.
 *
 * Sequential, not `Promise.all`: several npm scripts racing in one worktree fight
 * over the same node_modules and build output, and their interleaved text lands in
 * one unreadable artifact. Each still runs async, so the extension host keeps
 * serving hooks and webviews throughout.
 *
 * No short-circuit on the first failure. The attempt cap makes complete
 * information per attempt worth more than saved minutes: an agent that learns
 * about the unit failure only, fixes it, re-enters and THEN hits the integration
 * failure has spent two of three attempts to learn what one could have told it.
 *
 * `stopped` still carries `results` for whichever gates completed before the
 * abort landed (empty when none did). `gate_runs` is the project's only
 * append-only evidence table — a `stopped` outcome that discarded its partial
 * results would make the work those gates already did unrecoverable by any
 * caller, even though it happened.
 */
export interface RunGatesOptions {
  signal?: AbortSignal;
  now?: () => string;
  /** Whether the repository defines a given package.json script. */
  scriptsAvailable?: (script: string) => boolean;
  /**
   * Called after each gate finishes, with the gate's name AND its recorded
   * outcome (`null` = the repo could not answer — the "nothing to run" note,
   * never a verdict), the row's own timing (null when none exists, exactly
   * like the recorded result) and the gate's index in the list. Lets callers
   * push dashboard progress ("gate 2 of 4, elapsed 1m23s") and persist the
   * gate's evidence row the moment it lands — a host death between two gates
   * must not take the finished gate's record with it.
   */
  onGateComplete?: (
    gateName: string,
    exitCode: number | null,
    startedAt: string | null,
    endedAt: string | null,
    index: number,
  ) => void;
  /**
   * Called BEFORE each gate's work begins, with the gate's name — the live
   * counterpart of `onGateComplete`, so callers can flip a process header to
   * `run` the moment the gate starts rather than only after it lands.
   */
  onGateStart?: (gateName: string) => void;
}

export async function runGateList(
  gates: readonly ResolvedGate[],
  cwd: string,
  opts: RunGatesOptions = {},
): Promise<{ kind: 'ran'; results: GateResult[] } | { kind: 'stopped'; results: GateResult[] }> {
  const now = opts.now ?? nowIso;
  const results: GateResult[] = [];
  for (const [index, gate] of gates.entries()) {
    if (opts.signal?.aborted) return { kind: 'stopped', results };
    opts.onGateStart?.(gate.name);
    const startedAt = now();

    if (gate.script !== null && gate.required && opts.scriptsAvailable?.(gate.script) === false) {
      // The config named a question this repo cannot answer. A failure, not null —
      // and agent-fixable, because both the config and the missing script are in
      // the repository. Caught here rather than by spawning `npm run`, whose
      // "Missing script" exit 1 would read as a verdict about the ticket's code.
      const endedAt = now();
      results.push({
        name: gate.name,
        exitCode: 1,
        output: `configured gate "${gate.name}" needs a "${gate.script}" script, which package.json does not define`,
        startedAt,
        endedAt,
      });
      opts.onGateComplete?.(gate.name, 1, startedAt, endedAt, index);
      continue;
    }

    const outcome = await runProcess(gate.command, gate.args, cwd, { signal: opts.signal });

    if (outcome.kind === 'aborted') return { kind: 'stopped', results };
    if (outcome.kind === 'spawnFailed' && !gate.required && gate.script !== null) {
      // A discovered script whose binary vanished between probe and spawn: karst
      // had no question to ask after all, so it stays null rather than becoming a
      // verdict about the ticket's code.
      results.push({
        name: gate.name,
        exitCode: null,
        output: `no "${gate.script}" script available — nothing to run`,
      });
      opts.onGateComplete?.(gate.name, null, null, null, index);
      continue;
    }
    const endedAt = now();
    results.push({
      name: gate.name,
      exitCode: outcome.kind === 'completed' ? outcome.exitCode : 1,
      output: outcome.output,
      startedAt,
      endedAt,
    });
    opts.onGateComplete?.(gate.name, outcome.kind === 'completed' ? outcome.exitCode : 1, startedAt, endedAt, index);
  }
  return { kind: 'ran', results };
}
