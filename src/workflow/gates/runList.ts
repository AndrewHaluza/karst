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
}

export async function runGateList(
  gates: readonly ResolvedGate[],
  cwd: string,
  opts: RunGatesOptions = {},
): Promise<{ kind: 'ran'; results: GateResult[] } | { kind: 'stopped'; results: GateResult[] }> {
  const now = opts.now ?? nowIso;
  const results: GateResult[] = [];
  for (const gate of gates) {
    if (opts.signal?.aborted) return { kind: 'stopped', results };
    const startedAt = now();

    if (gate.script !== null && gate.required && opts.scriptsAvailable?.(gate.script) === false) {
      // The config named a question this repo cannot answer. A failure, not null —
      // and agent-fixable, because both the config and the missing script are in
      // the repository. Caught here rather than by spawning `npm run`, whose
      // "Missing script" exit 1 would read as a verdict about the ticket's code.
      results.push({
        name: gate.name,
        exitCode: 1,
        output: `configured gate "${gate.name}" needs a "${gate.script}" script, which package.json does not define`,
        startedAt,
        endedAt: now(),
      });
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
      continue;
    }
    results.push({
      name: gate.name,
      exitCode: outcome.kind === 'completed' ? outcome.exitCode : 1,
      output: outcome.output,
      startedAt,
      endedAt: now(),
    });
  }
  return { kind: 'ran', results };
}
