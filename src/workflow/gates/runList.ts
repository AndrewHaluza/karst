import { nowIso } from '../../model/time.js';
import type { GateResult } from './result.js';
import type { ResolvedGate } from './resolve.js';
import { runProcess, type GateOutputChunk, type GateProcessRunner } from './run.js';

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
   * like the recorded result), the gate's index in the list, and the gate's
   * combined output. Lets callers push dashboard progress ("gate 2 of 4,
   * elapsed 1m23s") and persist the gate's evidence row the moment it lands —
   * a host death between two gates must not take the finished gate's record
   * with it. `output` is the bounded captured stdout+stderr, so a caller that
   * records a failure summary (v46) can derive it HERE, at the same instant
   * the row is appended, instead of re-reading the artifact later.
   */
  onGateComplete?: (
    gateName: string,
    exitCode: number | null,
    startedAt: string | null,
    endedAt: string | null,
    index: number,
    output?: string,
  ) => void;
  /**
   * Called BEFORE each gate's work begins, with the gate's name — the live
   * counterpart of `onGateComplete`, so callers can flip a process header to
   * `run` the moment the gate starts rather than only after it lands.
   */
  onGateStart?: (gateName: string) => void;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[gate]`.
   * Absent → no debug lines; the host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on). Threaded into `runProcess` so
   * the gate's process lifecycle is visible in the same stream.
   */
  onDebug?: (message: string) => void;
  /**
   * Live output from the gate currently running, chunk by chunk, tagged with
   * the gate's name. Lets a caller stream a running gate into an open console
   * instead of showing it only once the artifact is written. Raw CLI prose —
   * sanitized at the console boundary, never here.
   */
  onGateOutput?: (gateName: string, chunk: GateOutputChunk) => void;
  /**
   * Whether the base branch's package.json defines `script` (rebase target of a
   * stale ticket branch). Absent → the branch is never treated as stale.
   */
  baseDefinesScript?: (script: string) => Promise<boolean>;
  /** The base ref named in the stale-branch reason. */
  baseRef?: string;
  /** Where each gate runs; absent → the host `runProcess`. A sandboxed ticket passes its runner's `runGate` (arch:AC-32). */
  runProcess?: GateProcessRunner;
  /** Runs a gate declared `sandbox: host`; absent → such a gate uses `runProcess` like any other. Declared order is kept (arch:AC-36). */
  hostProcess?: GateProcessRunner;
}

export async function runGateList(
  gates: readonly ResolvedGate[],
  cwd: string,
  opts: RunGatesOptions = {},
): Promise<{ kind: 'ran'; results: GateResult[] } | { kind: 'stopped'; results: GateResult[] }> {
  const now = opts.now ?? nowIso;
  const results: GateResult[] = [];
  const onDebug = opts.onDebug;
  for (const [index, gate] of gates.entries()) {
    if (opts.signal?.aborted) return { kind: 'stopped', results };
    opts.onGateStart?.(gate.name);
    const startedAt = now();
    onDebug?.(
      `[gate] ${gate.name}: gate ${index + 1} of ${gates.length} — ` +
        `${gate.command}${gate.args.length > 0 ? ` ${gate.args.join(' ')}` : ''}`,
    );

    if (gate.script !== null && gate.required && opts.scriptsAvailable?.(gate.script) === false) {
      // The config named a question this repo cannot answer. A failure, not null —
      // and agent-fixable, because both the config and the missing script are in
      // the repository. Caught here rather than by spawning `npm run`, whose
      // "Missing script" exit 1 would read as a verdict about the ticket's code.
      const endedAt = now();
      if (gate.derivedScript === true && (await opts.baseDefinesScript?.(gate.script)) === true) {
        const base = opts.baseRef ?? 'the base branch';
        const reason =
          `gate "${gate.name}" runs npm script "${gate.script}", which ${base} defines but this branch does not — ` +
          `rebase onto ${base} ("Rebase on base")`;
        onDebug?.(`[gate] ${gate.name}: ${reason}`);
        results.push({ name: gate.name, exitCode: 1, output: reason, staleBranch: reason, startedAt, endedAt });
        opts.onGateComplete?.(gate.name, 1, startedAt, endedAt, index, reason);
        continue;
      }
      onDebug?.(
        `[gate] ${gate.name}: configured script "${gate.script}" is missing from package.json (required gate)`,
      );
      results.push({
        name: gate.name,
        exitCode: 1,
        output: `configured gate "${gate.name}" needs a "${gate.script}" script, which package.json does not define (nor does the base branch)`,
        startedAt,
        endedAt,
      });
      opts.onGateComplete?.(gate.name, 1, startedAt, endedAt, index, results[results.length - 1]!.output);
      continue;
    }

    const outcome = await (gate.sandbox === 'host' && opts.hostProcess ? opts.hostProcess : (opts.runProcess ?? runProcess))(gate.command, gate.args, cwd, {
      signal: opts.signal,
      onDebug,
      onOutput: opts.onGateOutput ? (chunk) => opts.onGateOutput?.(gate.name, chunk) : undefined,
    });

    if (outcome.kind === 'aborted') return { kind: 'stopped', results };
    if (outcome.kind === 'spawnFailed' && !gate.required && gate.script !== null) {
      // A discovered script whose binary vanished between probe and spawn: karst
      // had no question to ask after all, so it stays null rather than becoming a
      // verdict about the ticket's code.
      onDebug?.(`[gate] ${gate.name}: discovered script's binary is gone — recorded as nothing to run`);
      results.push({
        name: gate.name,
        exitCode: null,
        output: `no "${gate.script}" script available — nothing to run`,
      });
      opts.onGateComplete?.(gate.name, null, null, null, index, results[results.length - 1]!.output);
      continue;
    }
    if (outcome.kind === 'spawnFailed' && gate.sandbox === 'host' && opts.hostProcess) {
      // A host gate the host boundary refused (arch:SANDBOX-HOST): it never ran, so
      // it has no verdict. Null + `hostRefused`, for required and optional gates alike.
      onDebug?.(`[gate] ${gate.name}: host gate refused — recorded as capability-missing: ${outcome.message}`);
      results.push({ name: gate.name, exitCode: null, output: outcome.output, hostRefused: true });
      opts.onGateComplete?.(gate.name, null, null, null, index, outcome.output);
      continue;
    }
    const endedAt = now();
    const exitCode = outcome.kind === 'completed' ? outcome.exitCode : 1;
    const output =
      exitCode !== 0 && outcome.output.trim() === ''
        ? `exited ${exitCode} with no output (command: ${[gate.command, ...gate.args].join(' ')})`
        : outcome.output;
    onDebug?.(
      `[gate] ${gate.name}: ${outcome.kind} (exit ${outcome.kind === 'completed' ? outcome.exitCode : 1}) — ${outcome.output.length} byte(s)`,
    );
    results.push({
      name: gate.name,
      exitCode,
      output,
      startedAt,
      endedAt,
    });
    opts.onGateComplete?.(gate.name, exitCode, startedAt, endedAt, index, output);
  }
  return { kind: 'ran', results };
}
