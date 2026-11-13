import type { Store } from '../../store/db.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import type { GateOutputChunk, GateProcessRunner } from '../../workflow/gates/run.js';
import { regenerateRepoOf, type RegenerateSpec } from '../../workflow/gates/regenerate.js';
import { runGateList } from '../../workflow/gates/runList.js';
import type { ResolvedGate } from '../../workflow/gates/resolve.js';
import { recordGateRun, HOST_RERUN_SOURCE } from '../../store/gateRuns.js';
import { stageAttempt } from '../../store/stages.js';
import { listArchCitations } from '../../store/archCitations.js';
import { renderCitationText } from '../../model/archCitations.js';
import type { StageKey } from '../../model/types.js';
import { probeScripts } from '../../workflow/gates/probe.js';
import { resolveTargetGates } from '../../workflow/stages/uat.js';
import { withHostOverride } from '../../workflow/gates/resourceKill.js';
import { getHostGates } from '../../store/ticketGates.js';
import type { UatConfig } from '../../manifest/types.js';
import { nowIso } from '../../model/time.js';
import type { MarkerStage } from '../../agent/markerStage.js';
import { runRequestedHostReruns } from '../../workflow/fixHostRerunRequest.js';
import { NO_NEW_COMMIT_REASON } from '../../workflow/fixRoundGuard.js';
import {
  describeHostRerun,
  hostRerunFailedGates,
  preBriefHostRerun,
  type FailedGate,
  type GateRerunResult,
  type HostRerunOutcome,
  type HostRerunReply,
} from '../../workflow/fixHostRerun.js';

export interface GateRerunDeps {
  readonly store: Store;
  /** The ticket's gate process: its sandbox runner, or the host's `runProcess`. */
  readonly runnerFor: (ticketId: number) => GateProcessRunner;
  /** The host's own runner, for `ship.regenerate` entries marked `sandbox: host`. */
  readonly hostRunner?: GateProcessRunner;
  /** A fresh host runner of a sandboxed ticket, for a `sandbox: host` gate (@arch:SANDBOX-HOST); absent → `hostRunner`. */
  readonly hostGateFor?: (ticketId: number) => GateProcessRunner | undefined;
  /** True when the ticket runs its gates in a sandbox. */
  readonly sandboxedFor?: (ticketId: number) => boolean;
  /** The manifest `ship.regenerate` spec of a repo key; undefined when it declares none. */
  readonly regenerateFor?: (repo: string) => RegenerateSpec | undefined;
  /** The manifest gates of a repo worktree, as UAT resolves them; undefined → the repo has none to answer with. */
  readonly gatesFor?: (ticketId: number, repo: string, cwd: string) => readonly ResolvedGate[] | undefined;
  /** The ticket's base ref of a repo, for `KARST_BASE_REF` (the D360 drift check). */
  readonly baseRefFor?: (ticketId: number, repo: string) => string | undefined;
  /** Live output of a gate, tagged with the ticket and the source stage. */
  readonly onGateOutput?: (ticketId: number, stage: StageKey, gateName: string, chunk: GateOutputChunk) => void;
  /** The pid of a gate process; the returned disposer runs when it settles. */
  readonly onGateSpawned?: (ticketId: number, gateName: string, pid: number, cwd: string) => (() => void) | void;
  readonly onGateStart?: (ticketId: number, stage: StageKey, gateName: string) => void;
  /** Pool root of the gate slot leases; tests inject a temp dir. */
  readonly gateSlotsDir?: string;
  readonly gateSlotPollMs?: number;
  readonly debug?: (message: string) => void;
  readonly now?: () => string;
  /** The one gate spawn path; tests inject a fake. */
  readonly runGates?: typeof runGateList;
}

type RerunDone = { name: string; exitCode: number | null; startedAt: string | null; endedAt: string | null; output: string; row: number };
type RerunGroup = { readonly path: string; readonly repo: string; readonly entries: { readonly gate: FailedGate; readonly index: number }[] };

const rerunError = (message: string): GateRerunResult => ({ exitCode: null, summary: `re-run error: ${message}` });

function groupByRepo(deps: GateRerunDeps, ticketId: number, gates: readonly FailedGate[], out: GateRerunResult[]): RerunGroup[] {
  const worktrees = listWorktreesByTicket(deps.store, ticketId);
  const groups = new Map<string, RerunGroup>();
  gates.forEach((gate, index) => {
    const repo = gate.repo ?? (gate.kind === 'regenerate' ? regenerateRepoOf(gate.gateName) : null);
    const worktree = worktrees.find((w) => w.repo === repo);
    if (!worktree) {
      out[index] = rerunError(`no worktree for repo ${repo ?? '(none)'}`);
      return;
    }
    const group = groups.get(worktree.repo) ?? { path: worktree.path, repo: worktree.repo, entries: [] };
    group.entries.push({ gate, index });
    groups.set(worktree.repo, group);
  });
  return [...groups.values()];
}

/**
 * Re-run the failed gates of a stage through `runGateList`, the UAT gate path: one call for each repo
 * worktree, run at the same time. It gets the gate slot, the port slot, the UI timeout, the host
 * route, the base ref and the live log. Each result lands in `gate_runs`, marked as a host re-run.
 */
export function makeGateRerun(
  deps: GateRerunDeps,
): (ticketId: number, gates: readonly FailedGate[], stage: StageKey) => Promise<GateRerunResult[]> {
  return async (ticketId, gates, stage) => {
    const out: GateRerunResult[] = new Array(gates.length);
    const groups = groupByRepo(deps, ticketId, gates, out);
    await Promise.all(
      groups.map(async (group) => {
        try {
          const results = await rerunGroup(deps, ticketId, stage, group);
          group.entries.forEach((e, i) => (out[e.index] = results[i]!));
        } catch (err) {
          const res = rerunError(err instanceof Error ? err.message : String(err));
          for (const e of group.entries) out[e.index] = res;
        }
      }),
    );
    return out;
  };
}

function resultOf(exitCode: number | null, output: string): GateRerunResult {
  if (exitCode === 0) return { exitCode: 0, summary: null };
  return { exitCode, summary: exitCode === null ? output || 'the gate could not run' : summarizeGateFailure(output) };
}

/** One repo worktree: resolve its failed rows to manifest gates, then one `runGateList` call. */
async function rerunGroup(deps: GateRerunDeps, ticketId: number, stage: StageKey, group: RerunGroup): Promise<GateRerunResult[]> {
  const results: (GateRerunResult | undefined)[] = group.entries.map(() => undefined);
  const regenIdx = group.entries.findIndex((e) => e.gate.kind === 'regenerate');
  let regenerate: RegenerateSpec | undefined;
  if (regenIdx >= 0) {
    const regenGate = group.entries[regenIdx]!.gate;
    const spec = deps.regenerateFor?.(regenerateRepoOf(regenGate.gateName) ?? group.repo);
    if (!spec || spec.commands.length === 0) {
      results[regenIdx] = { exitCode: null, cannotRerun: true, summary: `${regenGate.gateName} has no ship.regenerate commands in the manifest` };
    } else regenerate = spec;
  }
  const manifestGates = deps.gatesFor?.(ticketId, group.repo, group.path) ?? [];
  const toRun: ResolvedGate[] = [];
  const rowOfGate = new Map<string, number>();
  group.entries.forEach((e, i) => {
    if (e.gate.kind === 'regenerate') return;
    const match = manifestGates.find((g) => g.command === e.gate.command && g.args.join('\u0000') === e.gate.args.join('\u0000'));
    if (!match) {
      results[i] = { exitCode: null, cannotRerun: true, summary: `${e.gate.gateName} is no longer a manifest gate` };
      return;
    }
    if (!rowOfGate.has(match.name)) {
      toRun.push(match);
      rowOfGate.set(match.name, i);
    }
  });
  if (toRun.length === 0 && regenerate === undefined) return fill(results, 'not run');
  const now = deps.now ?? nowIso;
  const attempt = stageAttempt(deps.store, ticketId, stage);
  const done: RerunDone[] = [];
  const baseRef = deps.baseRefFor?.(ticketId, group.repo);
  const run = deps.runGates ?? runGateList;
  const res = await run(toRun, group.path, {
    now,
    ...(baseRef ? { baseRef } : {}),
    prBody: renderCitationText(listArchCitations(deps.store, ticketId)),
    runProcess: deps.runnerFor(ticketId),
    ...(deps.hostGateFor?.(ticketId) ?? deps.hostRunner ? { hostProcess: deps.hostGateFor?.(ticketId) ?? deps.hostRunner } : {}),
    sandboxed: deps.sandboxedFor?.(ticketId) === true,
    ...(regenerate ? { regenerate } : {}),
    ...(deps.gateSlotsDir ? { gateSlotsDir: deps.gateSlotsDir } : {}),
    ...(deps.gateSlotPollMs !== undefined ? { gateSlotPollMs: deps.gateSlotPollMs } : {}),
    ...(deps.debug ? { onDebug: deps.debug } : {}),
    onGateStart: (name) => deps.onGateStart?.(ticketId, stage, name),
    onGateOutput: (name, chunk) => deps.onGateOutput?.(ticketId, stage, name, chunk),
    onGateSpawned: (name, pid, cwd) => deps.onGateSpawned?.(ticketId, name, pid, cwd),
    onGateComplete: (name, exitCode, startedAt, endedAt, index, rawOutput) => {
      const output = rawOutput ?? '';
      const row = index < 0 ? regenIdx : (rowOfGate.get(name) ?? -1);
      done.push({ name, exitCode, startedAt, endedAt, output, row });
      if (row >= 0) results[row] = resultOf(exitCode, output);
    },
  });
  recordRerunRows(deps, ticketId, stage, attempt, now(), group, done);
  const reason = res.kind === 'stopped' ? 'aborted' : 'not run: regenerate failed';
  return fill(results, reason);
}

function fill(results: (GateRerunResult | undefined)[], reason: string): GateRerunResult[] {
  return results.map((r) => r ?? { exitCode: null, summary: reason });
}

/** Write the re-run's gate rows, marked so no reader takes them as a UAT batch verdict. */
function recordRerunRows(
  deps: GateRerunDeps,
  ticketId: number,
  stage: StageKey,
  attempt: number,
  runAt: string,
  group: RerunGroup,
  done: readonly RerunDone[],
): void {
  if (done.length === 0) return;
  recordGateRun(deps.store, {
    ticketId,
    stageKey: stage,
    attempt,
    runAt,
    source: HOST_RERUN_SOURCE,
    gates: done.map((d) => {
      const entry = d.row >= 0 ? group.entries[d.row]?.gate : undefined;
      return {
        gateName: entry?.gateName ?? d.name,
        exitCode: d.exitCode,
        startedAt: d.startedAt ?? undefined,
        endedAt: d.endedAt ?? undefined,
        repo: group.repo,
        command: entry?.command ?? d.name,
        args: entry?.args ?? [],
        summary: d.exitCode === 0 ? undefined : summarizeGateFailure(d.output),
      };
    }),
  });
}

export interface ManifestGatesDeps {
  readonly store: Store;
  readonly uat: () => UatConfig | undefined;
  /** The enabled manifest entry names of a worktree repo; absent → the repo itself names the entry. */
  readonly namesFor?: (repo: string) => readonly string[] | undefined;
  readonly debug?: (message: string) => void;
}

/** The `gatesFor` binding: the gates UAT would resolve for a repo worktree, with the ticket's host override. */
export function makeManifestGatesFor(deps: ManifestGatesDeps): NonNullable<GateRerunDeps['gatesFor']> {
  return (ticketId, repo, cwd) => {
    const resolution = resolveTargetGates(probeScripts(cwd, deps.debug), deps.uat(), deps.namesFor?.(repo) ?? [repo], [], deps.debug);
    if (resolution.kind !== 'gates') return undefined;
    return withHostOverride(resolution.gates, getHostGates(deps.store, ticketId));
  };
}

export interface RecoverRefusalDeps {
  readonly rerun: (ticketId: number) => Promise<HostRerunOutcome>;
  readonly debug?: (message: string) => void;
}

/** The `markerFlow.recoverRefusal` binding: only a no-new-commit fix refusal triggers the host re-run. */
export function makeRecoverRefusal(
  ticketId: number,
  deps: RecoverRefusalDeps,
): (stage: MarkerStage, stderr: string) => Promise<HostRerunReply | undefined> {
  return async (stage, stderr) => {
    if (stage !== 'fix' || !stderr.includes(NO_NEW_COMMIT_REASON)) return undefined;
    const outcome = await deps.rerun(ticketId);
    deps.debug?.(`[fix-rerun] ticket ${ticketId}: ${outcome.kind}`);
    return describeHostRerun(outcome);
  };
}

/** Production composition: re-run through the store-backed workflow with the host's gate runner. */
export function hostRerunFor(deps: GateRerunDeps): (ticketId: number) => Promise<HostRerunOutcome> {
  const runGates = makeGateRerun(deps);
  return (ticketId) => hostRerunFailedGates(deps.store, ticketId, { runGates });
}

/** Production composition for the pre-brief re-run of an environment-signature gate failure. */
export function preBriefRerunFor(deps: GateRerunDeps): (ticketId: number) => Promise<HostRerunOutcome> {
  const runGates = makeGateRerun(deps);
  return (ticketId) => preBriefHostRerun(deps.store, ticketId, { runGates });
}

export interface RequestedRerunSweepDeps extends GateRerunDeps {
  readonly projectId: () => number | undefined;
  readonly debug?: (message: string) => void;
}

/**
 * The extension sweep for host CLI fix markers (@arch:AC-45): a refused `stage fix pass` stored a
 * re-run request; run it here, never in the CLI. A tick that finds a run in flight does nothing.
 */
export function makeRequestedRerunSweep(deps: RequestedRerunSweepDeps): () => Promise<void> {
  const runGates = makeGateRerun(deps);
  let running = false;
  return async () => {
    const projectId = deps.projectId();
    if (running || projectId === undefined) return;
    running = true;
    try {
      const outcomes = await runRequestedHostReruns(deps.store, projectId, { runGates });
      for (const o of outcomes) deps.debug?.(`[fix-rerun] requested by the host CLI: ${o.kind}`);
    } catch (err) {
      deps.debug?.(`[fix-rerun] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
}
