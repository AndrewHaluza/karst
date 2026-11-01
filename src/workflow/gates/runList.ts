import { nowIso } from '../../model/time.js';
import type { GateResult } from './result.js';
import type { ResolvedGate } from './resolve.js';
import { runRegenerate, type RegenerateSpec } from './regenerate.js';
import { GATE_MAX_WORKERS_ENV, isResourceKill, resourceKillReason } from './resourceKill.js';
import { leasePortSlot, PORT_OFFSET_ENV, type PortSlotLease } from '../../runtime/portSlots.js';
import { runProcess, type GateOutputChunk, type GateProcessRunner, type ProcessOutcome } from './run.js';

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
  /**
   * Whether the repository defines a given package.json script. `derived` is true
   * when the script was read off a command gate rather than declared, so a caller
   * that could not read package.json can let the gate run and speak for itself.
   */
  scriptsAvailable?: (script: string, derived: boolean) => boolean;
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
  /**
   * The repo's `ship.regenerate` generators: run (where the gates run) and committed BEFORE the
   * list. A generator that fails ends the pass with that one result and runs no gate.
   */
  regenerate?: RegenerateSpec;
  /** True when `runProcess` is a sandbox runner (a missing module then means the sandbox lacks the tool). */
  sandboxed?: boolean;
}

export async function runGateList(
  gates: readonly ResolvedGate[],
  cwd: string,
  opts: RunGatesOptions = {},
): Promise<
  | { kind: 'ran'; results: GateResult[]; regenerateFailed?: true }
  | { kind: 'stopped'; results: GateResult[] }
> {
  const now = opts.now ?? nowIso;
  const results: GateResult[] = [];
  const onDebug = opts.onDebug;
  if (opts.regenerate && opts.regenerate.commands.length > 0) {
    const regenName = `regenerate (${opts.regenerate.repo})`;
    opts.onGateStart?.(regenName);
    const regen = await runRegenerate(
      opts.regenerate,
      cwd,
      {
        sandbox: opts.runProcess ?? runProcess,
        ...(opts.hostProcess ? { host: opts.hostProcess } : {}),
        signal: opts.signal,
        onDebug,
        ...(opts.onGateOutput ? { onOutput: (chunk: GateOutputChunk) => opts.onGateOutput?.(regenName, chunk) } : {}),
      },
      opts.sandboxed === true,
      now,
    );
    if (regen.kind === 'stopped') return { kind: 'stopped', results };
    // Index -1: the evidence row is not one of the resolved gates. Written on EVERY run
    // (ok too), so a regenerate that changed nothing or never committed is still visible.
    const r = regen.result;
    opts.onGateComplete?.(r.name, r.exitCode, r.startedAt ?? null, r.endedAt ?? null, -1, r.output);
    if (regen.kind === 'failed') return { kind: 'ran', results: [r], regenerateFailed: true };
  }
  for (const [index, gate] of gates.entries()) {
    if (opts.signal?.aborted) return { kind: 'stopped', results };
    opts.onGateStart?.(gate.name);
    const startedAt = now();
    onDebug?.(
      `[gate] ${gate.name}: gate ${index + 1} of ${gates.length} — ` +
        `${gate.command}${gate.args.length > 0 ? ` ${gate.args.join(' ')}` : ''}`,
    );

    if (gate.script !== null && gate.required && opts.scriptsAvailable?.(gate.script, gate.derivedScript === true) === false) {
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

    const runOpts = {
      signal: opts.signal,
      onDebug,
      onOutput: opts.onGateOutput ? (chunk: GateOutputChunk) => opts.onGateOutput?.(gate.name, chunk) : undefined,
    };
    const onHost = gate.sandbox === 'host' && opts.hostProcess !== undefined;
    // Integration suites own fixed port bands; concurrent gates (other tickets'
    // worktrees) must not share one, so each leases a slot and runs shifted.
    let lease: PortSlotLease | undefined;
    if (isIntegrationGate(gate)) {
      try {
        lease = await leasePortSlot({ signal: opts.signal, onDebug });
      } catch (err) {
        // Only a Stop is a stop; any other lease failure is an environment fault
        // and must surface, not masquerade as the user cancelling.
        if (opts.signal?.aborted) return { kind: 'stopped', results };
        throw err;
      }
    }
    let outcome: ProcessOutcome;
    let resourceKilled: string | undefined;
    try {
    const offsetEnv = lease ? [`${PORT_OFFSET_ENV}=${lease.offset}`] : [];
    // Every spawn of this gate (first run, host fallback, resource-kill retry) runs in the leased band.
    const launch = (run: GateProcessRunner, extraEnv: readonly string[] = []): Promise<ProcessOutcome> =>
      extraEnv.length + offsetEnv.length > 0
        ? run('env', [...extraEnv, ...offsetEnv, gate.command, ...gate.args], cwd, runOpts)
        : run(gate.command, gate.args, cwd, runOpts);
    outcome = await launch(onHost ? opts.hostProcess! : (opts.runProcess ?? runProcess));
    if (outcome.kind === 'completed' && isResourceKill({ name: gate.name, exitCode: outcome.exitCode, output: outcome.output })) {
      // SIGKILL with no failing test: memory pressure, an environment fault (arch:GATE-CAPABILITY).
      const policy = gate.onResourceKill ?? 'retry-then-park';
      const sandboxed = opts.sandboxed === true && !onHost;
      onDebug?.(`[gate] ${gate.name}: killed (exit 137, no failing test) — onResourceKill=${policy}`);
      if (policy === 'host' && opts.hostProcess && !onHost) {
        outcome = await launch(opts.hostProcess);
      } else if (policy !== 'park') {
        const run = onHost ? opts.hostProcess! : (opts.runProcess ?? runProcess);
        outcome = await launch(run, [`${GATE_MAX_WORKERS_ENV}=1`]);
      }
      if (outcome.kind === 'completed' && isResourceKill({ name: gate.name, exitCode: outcome.exitCode, output: outcome.output })) {
        resourceKilled = resourceKillReason(gate.name, sandboxed);
      }
    }
    } finally {
      await lease?.release();
    }

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
      ...(resourceKilled !== undefined ? { resourceKilled } : {}),
    });
    opts.onGateComplete?.(gate.name, exitCode, startedAt, endedAt, index, output);
  }
  return { kind: 'ran', results };
}

/** Gates running the `*.integration.test.*` suites, whose fixed port bands must not be shared across worktrees. */
function isIntegrationGate(gate: ResolvedGate): boolean {
  return /integration/.test([gate.name, gate.script ?? '', ...gate.args].join(' '));
}
