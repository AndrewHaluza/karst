/**
 * The deterministic Tester verifier boundary (Task 8).
 *
 * The AI UAT Tester's observations are advisory BY DEFAULT — they can never
 * pass, fail, transition, or spend a recovery round by themselves. The ONE
 * knob that makes them a verdict is `uat.testerObservations.blockingSeverity`
 * (`uat/tester.ts` counts, `stages/uat.ts` decides); its default `'none'`
 * leaves the behavior below exactly as shipped. The optional
 * `uat.testerVerifier` GateDef is the host-authored deterministic check whose
 * COMPLETED exit code is the sole Tester-specific UAT verdict: 0 completes the
 * Tester, a completed nonzero exit fails UAT (opening a Tester-attributed
 * recovery round), a spawn failure is `execution-failed` (the stage parks —
 * a command that could not run is environmental, and must not consume a Fix
 * round), and an abort or timeout is an interruption (no verdict at all).
 *
 * The gate is run through the INJECTED host gate runner (`runProcess` from
 * `workflow/gates/run.ts`) — never spawned from workflow code — so the
 * extension host's event-loop and timeout rules apply uniformly, and unit
 * tests supply a fake runner that returns `ProcessOutcome` values directly.
 */

import type { GateDef } from '../../manifest/types.js';
import type { ProcessOutcome } from '../gates/run.js';

/**
 * The closed verification outcome vocabulary. `absent` means no verifier is
 * configured — the Tester's observations stay advisory and the ordinary UAT
 * gates decide progression alone.
 */
export type TesterVerificationOutcome =
  | { kind: 'absent' }
  | { kind: 'passed'; exitCode: 0 }
  | { kind: 'failed'; exitCode: number }
  | { kind: 'execution-failed'; message: string }
  | { kind: 'interrupted' };

/**
 * The injected host gate boundary — structurally `runProcess` from
 * `workflow/gates/run.ts`. The `ProcessOutcome` (not `runCommand`'s flattened
 * `CommandResult`) is load-bearing: only a `completed` outcome is a verdict,
 * and a spawn failure must stay distinguishable from a completed nonzero exit
 * or the stage could not tell "could not run" (park) from "ran and failed"
 * (recovery round).
 */
export type TesterGateRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  options?: { signal?: AbortSignal; onDebug?: (message: string) => void },
) => Promise<ProcessOutcome>;

export interface RunTesterVerifierOpts {
  /** The configured `uat.testerVerifier`; absent → `{ kind: 'absent' }`. */
  gate?: GateDef;
  /** The worktree the verifier runs in. */
  cwd: string;
  /** One signal for the whole run, so Stop reaches the verifier in flight. */
  signal?: AbortSignal;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[gate]` —
   * the verifier is part of the UAT stage flow, so its lines ride the same
   * stream the stage's own debug lines use, and `onDebug` is threaded into
   * the gate runner so the verifier's process lifecycle lands there too.
   * Absent → no debug lines; the stage threads its `RunUatOpts.debug` here.
   */
  onDebug?: (message: string) => void;
}

export interface TesterVerifierDeps {
  /** The host gate runner; absent with a configured gate → execution-failed. */
  run?: TesterGateRunner;
}

/**
 * The verdict reason prefix the UAT stage reads to attribute a failed verdict
 * to the Tester process (`sourceProcessId: 'tester'`) instead of to a gate —
 * the same pattern review's `FINDINGS_FAILURE_PREFIX` uses.
 */
export const TESTER_VERIFIER_FAILURE_PREFIX = 'uat tester verifier failed: ';

/**
 * The prefix that attributes a failed UAT verdict to the Tester's OBSERVATIONS
 * (not its verifier gate) — the same pattern review's `FINDINGS_FAILURE_PREFIX`
 * uses. Reached only when `uat.testerObservations.blockingSeverity` is set to a
 * severity; at the default `'none'` no verdict ever carries it. Declared once,
 * here, so the stage and its tests never hold a second copy of the string.
 */
export const TESTER_OBSERVATIONS_FAILURE_PREFIX = 'uat tester observations: ';

/**
 * The single declared gate's invocation — the same `npm run <script>` mapping
 * `workflow/gates/resolve.ts`'s `resolveDeclared` applies to a `kind: 'script'`
 * gate, kept here because the verifier is one gate resolved directly from the
 * manifest, never through a probe.
 */
export function verifierCommand(gate: GateDef): { command: string; args: string[] } {
  if (gate.kind === 'command') {
    return { command: gate.command!, args: gate.args ?? [] };
  }
  const script = gate.script!;
  return { command: 'npm', args: script === 'test' ? ['test'] : ['run', script] };
}

/** Run the verifier and reduce the process outcome to the closed vocabulary. */
export async function runTesterVerifier(
  opts: RunTesterVerifierOpts,
  deps: TesterVerifierDeps,
): Promise<TesterVerificationOutcome> {
  if (!opts.gate) return { kind: 'absent' };
  if (!deps.run) {
    return {
      kind: 'execution-failed',
      message: 'no verifier gate runner is wired to the host',
    };
  }
  const { command, args } = verifierCommand(opts.gate);
  const onDebug = opts.onDebug;
  onDebug?.(
    `[gate] uat tester verifier: ${opts.gate.name} — running ${command}` +
      `${args.length > 0 ? ` ${args.join(' ')}` : ''} (cwd ${opts.cwd})`,
  );
  const outcome = await deps.run(command, args, opts.cwd, {
    signal: opts.signal,
    onDebug,
  });
  switch (outcome.kind) {
    case 'completed':
      onDebug?.(
        `[gate] uat tester verifier: ${opts.gate.name} — ${
          outcome.exitCode === 0 ? 'passed' : 'failed'
        } (exit ${outcome.exitCode})`,
      );
      return outcome.exitCode === 0
        ? { kind: 'passed', exitCode: 0 }
        : { kind: 'failed', exitCode: outcome.exitCode };
    case 'spawnFailed':
      onDebug?.(
        `[gate] uat tester verifier: ${opts.gate.name} — execution-failed (${outcome.message})`,
      );
      return { kind: 'execution-failed', message: outcome.message };
    case 'timedOut':
    case 'aborted':
      onDebug?.(`[gate] uat tester verifier: ${opts.gate.name} — interrupted`);
      return { kind: 'interrupted' };
  }
}
