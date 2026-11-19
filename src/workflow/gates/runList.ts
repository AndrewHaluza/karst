import { nowIso } from '../../model/time.js';
import type { GateResult } from './result.js';
import type { ResolvedGate } from './resolve.js';
import { regenerateGateName, runRegenerate, type RegenerateSpec } from './regenerate.js';
import { GATE_MAX_WORKERS_ENV, isResourceKill, resourceKillReason } from './resourceKill.js';
import { leasePortSlot, PORT_OFFSET_ENV, type PortSlotLease } from '../../runtime/portSlots.js';
import { GATE_LEASE_HELD_ENV, leaseGateSlot } from './gateLease.js';
import { isUiGate } from './uiScope.js';
import { gateTimeoutMs, runProcess, type GateOutputChunk, type GateProcessRunner, type ProcessOutcome } from './run.js';

/**
 * Run a resolved gate list in one worktree, in two lanes (@arch:GATE-CONCURRENCY).
 *
 * Lane 1 holds the UI gates (`isUiGate`: the visual sweep runs in its own container), lane 2 holds
 * every other gate. The lanes run side by side; inside a lane the gates run one after the other in
 * manifest order, so two vitest gates never run at once and the `node_modules` and build output of
 * the worktree keep a single writer per lane. A list with gates in only one lane is the old
 * sequential run. Each gate still runs async, so the extension host keeps serving hooks and
 * webviews throughout.
 *
 * Each gate's output is captured on its own: the caller builds the artifact sections from
 * `results` after the list returns, and `onGateOutput` carries the gate name with every chunk.
 * `results` are in manifest order and each carries its `index` in `gates`, also after a Stop
 * (a gate that did not finish leaves no row, and no later row shifts its identity).
 *
 * A throw in one lane (a lease error) aborts the other lane through an internal signal and waits
 * for it to settle before the error is thrown again, so no gate process outlives the call.
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
   * the row is appended, instead of re-reading the artifact later. `waitMs` is the part of
   * `endedAt - startedAt` spent waiting for slots (gate lease, port slot, sandbox runner slot);
   * null for a gate that never ran (@arch:RESULTS).
   */
  onGateComplete?: (
    gateName: string,
    exitCode: number | null,
    startedAt: string | null,
    endedAt: string | null,
    index: number,
    output?: string,
    waitMs?: number | null,
  ) => void;
  /**
   * Called BEFORE each gate's work begins, with the gate's name — the live
   * counterpart of `onGateComplete`, so callers can flip a process header to
   * `run` the moment the gate starts rather than only after it lands. With two
   * lanes, it is called again with the gate that still runs after another gate
   * ended (right after that gate's `onGateComplete`), so a reader that shows ONE
   * running gate (`deliver_runs.current_gate`, the Inside gates row) never names a gate that ended.
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
   * Called with a gate's name and the pid of each process it spawns; the
   * returned disposer runs when that process settles. Absent → unregistered.
   */
  onGateSpawned?: (gateName: string, pid: number, cwd: string) => (() => void) | void;
  /**
   * Whether the base branch's package.json defines `script` (rebase target of a
   * stale ticket branch). Absent or `undefined` (base unreadable) → the branch is
   * never treated as stale and the failure text makes no claim about the base.
   */
  baseDefinesScript?: (script: string) => Promise<boolean | undefined>;
  /** The base ref named in the stale-branch reason. */
  baseRef?: string;
  /**
   * The base tip a base-moved check merged (@arch:GATE-BASE-MOVED). Every gate process gets
   * `KARST_MERGED_BASE_SHA=<sha>`: the sweep gates select views from the ticket diff against it, not from the base delta.
   */
  mergedBaseSha?: string;
  /**
   * `'branch-diff'`: a vitest gate with no earlier state narrows its first pass to the tests related to the
   * branch diff (@arch:GATE-REPEAT). Only the UAT stage sets it; ship, base-moved and auto-deliver runs stay full.
   */
  firstPass?: 'branch-diff';
  /**
   * The ticket's rendered arch citations (@arch:CLI-22). When set (an empty string is a value:
   * "nothing cited"), every gate process gets `PR_BODY=<text>` and `BASE_REF=<baseRef>`, which is
   * what `scripts/docsGate.mjs` reads. The text is passed as one argv element of `env`, never
   * through a shell, and the gate reads it as text.
   */
  prBody?: string;
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
  /** Pool root for `maxConcurrent` gate leases; absent → `~/.karst/gate-slots`. Tests inject a temp dir. */
  gateSlotsDir?: string;
  /** Poll interval of a waiting gate lease; absent → the lease default. */
  gateSlotPollMs?: number;
}

export type RunGateListResult =
  | { kind: 'ran'; results: GateResult[]; regenerateFailed?: true }
  | { kind: 'stopped'; results: GateResult[] };

interface GateRun {
  readonly gates: readonly ResolvedGate[];
  readonly cwd: string;
  readonly opts: RunGatesOptions;
  readonly now: () => string;
  /** The signal every gate sees: the caller's Stop, or a lane's throw (see `runGateList`). */
  readonly signal: AbortSignal;
}

/** What one gate yields: its result, or `undefined` when a Stop landed before it ended. */
type GateEnd = { readonly result: GateResult } | undefined;

export async function runGateList(
  gates: readonly ResolvedGate[],
  cwd: string,
  opts: RunGatesOptions = {},
): Promise<RunGateListResult> {
  const now = opts.now ?? nowIso;
  const onDebug = opts.onDebug;
  if (opts.regenerate && opts.regenerate.commands.length > 0) {
    const regenName = regenerateGateName(opts.regenerate.repo);
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
    if (regen.kind === 'stopped') return { kind: 'stopped', results: [] };
    // Index -1: the evidence row is not one of the resolved gates. Written on EVERY run
    // (ok too), so a regenerate that changed nothing or never committed is still visible.
    const r = regen.result;
    opts.onGateComplete?.(r.name, r.exitCode, r.startedAt ?? null, r.endedAt ?? null, -1, r.output, null);
    if (regen.kind === 'failed') return { kind: 'ran', results: [r], regenerateFailed: true };
  }

  // The internal controller follows the caller's Stop and adds the abort of a failing lane.
  const controller = new AbortController();
  const follow = (): void => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', follow, { once: true });
  const run: GateRun = { gates, cwd, opts, now, signal: controller.signal };

  const slots: (GateResult | undefined)[] = gates.map(() => undefined);
  // Gates that started and have not ended, in start order: the label a single-gate reader shows.
  const running = new Map<number, string>();
  let stopped = false;
  const runLane = async (indexes: readonly number[]): Promise<void> => {
    for (const index of indexes) {
      if (run.signal.aborted) {
        stopped = true;
        return;
      }
      const gate = gates[index]!;
      running.set(index, gate.name);
      opts.onGateStart?.(gate.name);
      let end: GateEnd;
      try {
        end = await runOneGate(run, index);
      } finally {
        running.delete(index);
      }
      if (end === undefined) {
        stopped = true;
        return;
      }
      slots[index] = { ...end.result, index };
      // A reader of one running gate (current_gate, the Inside gates row) must name a gate
      // that still runs once this one has ended, so the survivor is announced again.
      const [survivor] = [...running.values()].reverse();
      if (survivor !== undefined) opts.onGateStart?.(survivor);
    }
  };

  const uiLane: number[] = [];
  const mainLane: number[] = [];
  for (const [index, gate] of gates.entries()) (isUiGate(gate) ? uiLane : mainLane).push(index);
  const lanes = [uiLane, mainLane].filter((lane) => lane.length > 0);
  const settled = await Promise.allSettled(
    lanes.map((lane) =>
      runLane(lane).catch((err: unknown) => {
        // Stop the other lane's gates now, then rethrow once every lane has settled.
        controller.abort();
        throw err;
      }),
    ),
  );
  opts.signal?.removeEventListener('abort', follow);
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure) throw failure.reason;
  const results = slots.filter((r): r is GateResult => r !== undefined);
  return stopped ? { kind: 'stopped', results } : { kind: 'ran', results };
}

/** Run one gate of the list: leases, spawn, resource-kill retry. `undefined` = a Stop ended it. */
async function runOneGate(run: GateRun, index: number): Promise<GateEnd> {
  const { gates, cwd, opts, now, signal } = run;
  const gate = gates[index]!;
  const onDebug = opts.onDebug;
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
    const baseDefines = await opts.baseDefinesScript?.(gate.script);
    if (baseDefines === true) {
      const base = opts.baseRef ?? 'the base branch';
      const reason =
        `gate "${gate.name}" ${gate.derivedScript === true ? 'runs' : 'needs'} npm script "${gate.script}", which ${base} defines but this branch does not — ` +
        `rebase onto ${base} ("Rebase on base")`;
      onDebug?.(`[gate] ${gate.name}: ${reason}`);
      opts.onGateComplete?.(gate.name, 1, startedAt, endedAt, index, reason, null);
      return { result: { name: gate.name, exitCode: 1, output: reason, staleBranch: reason, startedAt, endedAt } };
    }
    onDebug?.(
      `[gate] ${gate.name}: configured script "${gate.script}" is missing from package.json (required gate)`,
    );
    const result: GateResult = {
      name: gate.name,
      exitCode: 1,
      output: `configured gate "${gate.name}" needs a "${gate.script}" script, which package.json does not define${baseDefines === false ? ' (nor does the base branch)' : ''}`,
      startedAt,
      endedAt,
    };
    opts.onGateComplete?.(gate.name, 1, startedAt, endedAt, index, result.output, null);
    return { result };
  }

  const timeoutMs = gateTimeoutMs(gate, isUiGate(gate));
  const runOpts = {
    signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    onDebug,
    onOutput: opts.onGateOutput ? (chunk: GateOutputChunk) => opts.onGateOutput?.(gate.name, chunk) : undefined,
    onSpawned: opts.onGateSpawned ? (pid: number) => opts.onGateSpawned?.(gate.name, pid, cwd) : undefined,
  };
  const onHost = gate.sandbox === 'host' && opts.hostProcess !== undefined;
  // A gate with `maxConcurrent` waits here for a host-wide slot, before any spawn (arch:GATE-CONCURRENCY).
  let slotWaitMs = 0;
  let gateLease: { release: () => Promise<void> } | undefined;
  if (gate.maxConcurrent !== undefined) {
    const leaseFrom = Date.now();
    try {
      gateLease = await leaseGateSlot(gate.name, gate.maxConcurrent, {
        dir: opts.gateSlotsDir,
        pollMs: opts.gateSlotPollMs,
        signal,
        onWait: (held) =>
          opts.onGateOutput?.(gate.name, {
            stream: 'stderr',
            text: `${gate.name}: waiting for a free slot (${held} of ${gate.maxConcurrent} in use by other tickets)\n`,
          }),
      });
    } catch (err) {
      if (signal.aborted) return undefined;
      throw err;
    }
    slotWaitMs += Date.now() - leaseFrom;
  }
  // Integration suites own fixed port bands; concurrent gates (other tickets'
  // worktrees) must not share one, so each leases a slot and runs shifted.
  let lease: PortSlotLease | undefined;
  if (isIntegrationGate(gate)) {
    const portFrom = Date.now();
    try {
      lease = await leasePortSlot({ signal, onDebug });
      slotWaitMs += Date.now() - portFrom;
    } catch (err) {
      // Only a Stop is a stop; any other lease failure is an environment fault
      // and must surface, not masquerade as the user cancelling.
      await gateLease?.release();
      if (signal.aborted) return undefined;
      throw err;
    }
  }
  let outcome: ProcessOutcome;
  let resourceKilled: string | undefined;
  try {
    const offsetEnv = lease ? [`${PORT_OFFSET_ENV}=${lease.offset}`] : [];
    // Every spawn of this gate (first run, host fallback, resource-kill retry) runs in the leased band.
    // The ticket's base branch reaches every gate process, host or sandbox (the D360 drift check reads it).
    const baseEnv = [
      // The gate script (dockerGate.mjs) skips its own lease: this run already holds the slot.
      ...(gateLease ? [`${GATE_LEASE_HELD_ENV}=1`] : []),
      // A base-moved run scopes against the fetched base sha: a local branch behind origin would move the merge base (@arch:GATE-BASE-MOVED).
      ...((opts.mergedBaseSha ?? opts.baseRef) ? [`KARST_BASE_REF=${opts.mergedBaseSha ?? opts.baseRef}`] : []),
      ...(opts.mergedBaseSha ? [`KARST_MERGED_BASE_SHA=${opts.mergedBaseSha}`] : []),
      ...(opts.firstPass ? [`KARST_GATE_FIRST_PASS=${opts.firstPass}`] : []),
      ...(opts.prBody !== undefined ? [`PR_BODY=${opts.prBody}`, ...(opts.baseRef ? [`BASE_REF=${opts.baseRef}`] : [])] : []),
    ];
    const launchOnce = (proc: GateProcessRunner, extraEnv: readonly string[] = []): Promise<ProcessOutcome> =>
      extraEnv.length + offsetEnv.length + baseEnv.length > 0
        ? proc('env', [...baseEnv, ...extraEnv, ...offsetEnv, gate.command, ...gate.args], cwd, runOpts)
        : proc(gate.command, gate.args, cwd, runOpts);
    // A sandbox runner reports its own slot wait on the outcome; every spawn of the gate adds its share.
    const launch = async (proc: GateProcessRunner, extraEnv: readonly string[] = []): Promise<ProcessOutcome> => {
      const launched = await launchOnce(proc, extraEnv);
      slotWaitMs += launched.waitMs ?? 0;
      return launched;
    };
    outcome = await launch(onHost ? opts.hostProcess! : (opts.runProcess ?? runProcess));
    if (outcome.kind === 'completed' && isResourceKill({ name: gate.name, exitCode: outcome.exitCode, output: outcome.output })) {
      // SIGKILL with no failing test: memory pressure, an environment fault (arch:GATE-CAPABILITY).
      const policy = gate.onResourceKill ?? 'retry-then-park';
      const sandboxed = opts.sandboxed === true && !onHost;
      onDebug?.(`[gate] ${gate.name}: killed (exit 137, no failing test) — onResourceKill=${policy}`);
      if (policy === 'host' && opts.hostProcess && !onHost) {
        outcome = await launch(opts.hostProcess);
      } else if (policy !== 'park') {
        const proc = onHost ? opts.hostProcess! : (opts.runProcess ?? runProcess);
        outcome = await launch(proc, [`${GATE_MAX_WORKERS_ENV}=1`]);
      }
      if (outcome.kind === 'completed' && isResourceKill({ name: gate.name, exitCode: outcome.exitCode, output: outcome.output })) {
        resourceKilled = resourceKillReason(gate.name, sandboxed);
      }
    }
  } finally {
    await lease?.release();
    await gateLease?.release();
  }

  if (outcome.kind === 'aborted') return undefined;
  if (outcome.kind === 'spawnFailed' && !gate.required && gate.script !== null) {
    // A discovered script whose binary vanished between probe and spawn: karst
    // had no question to ask after all, so it stays null rather than becoming a
    // verdict about the ticket's code.
    onDebug?.(`[gate] ${gate.name}: discovered script's binary is gone — recorded as nothing to run`);
    const result: GateResult = {
      name: gate.name,
      exitCode: null,
      output: `no "${gate.script}" script available — nothing to run`,
    };
    opts.onGateComplete?.(gate.name, null, null, null, index, result.output, null);
    return { result };
  }
  if (outcome.kind === 'spawnFailed' && gate.sandbox === 'host' && opts.hostProcess) {
    // A host gate the host boundary refused (arch:SANDBOX-HOST): it never ran, so
    // it has no verdict. Null + `hostRefused`, for required and optional gates alike.
    onDebug?.(`[gate] ${gate.name}: host gate refused — recorded as capability-missing: ${outcome.message}`);
    opts.onGateComplete?.(gate.name, null, null, null, index, outcome.output, null);
    return { result: { name: gate.name, exitCode: null, output: outcome.output, hostRefused: true } };
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
  opts.onGateComplete?.(gate.name, exitCode, startedAt, endedAt, index, output, slotWaitMs);
  return {
    result: {
      name: gate.name,
      exitCode,
      output,
      startedAt,
      endedAt,
      waitMs: slotWaitMs,
      ...(resourceKilled !== undefined ? { resourceKilled } : {}),
    },
  };
}

/** Gates running the `*.integration.test.*` suites, whose fixed port bands must not be shared across worktrees. */
function isIntegrationGate(gate: ResolvedGate): boolean {
  return /integration/.test([gate.name, gate.script ?? '', ...gate.args].join(' '));
}
