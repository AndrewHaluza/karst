import { probeScripts } from '../../workflow/gates/probe.js';
import type { GateLiveSink } from '../../workflow/gates/liveGates.js';
import { runGateList } from '../../workflow/gates/runList.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { resolveTargetGates } from '../../workflow/stages/uat.js';
import type { ResolvedGate } from '../../workflow/gates/resolve.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import type { UatConfig } from '../../manifest/types.js';
import type { DeliverPr } from '../../workflow/deliverState.js';
import type { GateOutputChunk } from '../../workflow/gates/run.js';
import type { Store } from '../../store/db.js';
import { finishDeliverRun, type DeliverRunKind, openDeliverRun, recordDeliverGate, setDeliverProgress } from '../../store/deliverRuns.js';
import { nowIso } from '../../model/time.js';
import type { GitRunner } from '../../integrations/git.js';
import { cutGatesWithoutUiChange } from '../../workflow/gates/uiDiff.js';
import { isUiGate } from '../../workflow/gates/uiScope.js';
import { NO_UI_CHANGE_REASON } from '../../workflow/gates/uiScope.js';

/**
 * The gate set a resolved merge must pass before Karst pushes it (arch:AC-39,
 * D247). Ship has no gate list of its own, so this is the ticket's UAT gate set
 * (declared `uat.gates`, else the probed scripts) run against each PR's merged
 * worktree. With `evidence` the run is recorded (T1018, @arch:EVIDENCE-WHEN): a
 * `deliver_runs` row opens before the first gate and one `deliver_gate_results` row
 * (with the head SHA) is appended as each gate finishes. A failure leaves the merge
 * undelivered with the reason shown, and its record stays.
 *
 * Base moved (D541, `baseMovedCheck.ts`): CI tests the PR head merged with the CURRENT base, a tree no karst gate
 * saw when the base moved after the last green run. Before a push, that merge is built in a temporary worktree
 * below `.karst/base-check` and this runner gates it with `kind: 'base-moved'`. The UI gates are cut by the BASE
 * delta since the last green run (`uiChanged`), never by a diff of the merged tree, whose branch changes hold UI
 * paths the earlier green run already covered. A test that also fails on the base alone is develop drift: the gate
 * scripts (D313, D360) excuse it, so the run still passes.
 * A ticket with a sandbox clone is not checked: its gate runner cannot see the merged worktree (@arch:AC-39).
 */
export interface ShipGatesDeps {
  readonly uat: UatConfig | undefined;
  /** A sandboxed ticket's gates run inside its sandbox, never on the host (arch:AC-39). */
  readonly runProcess?: GateProcessRunner;
  readonly hostProcess?: GateProcessRunner;
  readonly debug?: (message: string) => void;
  /** Where the run is recorded; absent → nothing is recorded (a caller with no ticket). */
  readonly evidence?: { readonly store: Store; readonly ticketId: number };
  /** The HEAD sha of the merged tree in `cwd`; absent or null → the result carries no sha. */
  readonly headSha?: (cwd: string) => Promise<string | null>;
  /** Run only the gates with these names (the re-run of the gates a manual Deliver skipped); absent → every gate. */
  readonly only?: readonly string[];
  /** Called with the id of the run this call opened. */
  readonly onRunOpened?: (runId: number) => void;
  /** What started the run; recorded on the run row. Default `auto`. */
  readonly kind?: DeliverRunKind;
  /** Aborts the running gate process (a manual Deliver takes over). */
  readonly signal?: AbortSignal;
  /** Live gate output for the ship console (@arch:GATE-OUTPUT). */
  readonly onOutput?: (gateName: string, chunk: GateOutputChunk) => void;
  /** A gate started or finished: the host pushes the dashboard state. */
  readonly onProgress?: () => void;
  /** The live state of the running gate (running, or waiting for a slot); absent → not reported. */
  readonly live?: GateLiveSink;
  /**
   * The ticket's rendered arch citations and base branch for one PR, so the
   * `docs:gate` gate reads the same `PR_BODY` and `BASE_REF` it reads in UAT.
   */
  /**
   * Reads the merged diff so the UI gates are cut when no UI path changed, as UAT does
   * (@arch:AP-01). Absent → every gate runs.
   */
  readonly git?: GitRunner;
  /**
   * The base delta of a base-moved merge holds a UI path (D541). Defined → the UI gates are cut by it and no diff is
   * read; absent → cut by the merged diff against the base, as UAT does.
   */
  readonly uiChanged?: boolean;
  /** The summary a gate cut by `uiChanged` records; absent → `NO_UI_CHANGE_REASON`. */
  readonly uiSkipReason?: string | null;
  /** The base tip of a base-moved merge: the sweep gates select views from the ticket diff against it, and each gate row keeps its scope line. */
  readonly mergedBaseSha?: string;
  readonly gateEnv?: (pr: DeliverPr) => { readonly prBody: string; readonly baseRef?: string };
}

interface PlannedRepo {
  readonly pr: DeliverPr;
  readonly probe: ReturnType<typeof probeScripts>;
  readonly gates: readonly ResolvedGate[];
  /** Gates cut by the UI-path rule: kept in the run plan, recorded as skipped, never run. */
  readonly skipped: readonly ResolvedGate[];
}

const STOPPED = 'stopped: a newer push superseded this run';

/** A ship gate that exited non-zero: its name and the output an environment classifier reads (T1315). */
export interface FailedShipGate {
  readonly name: string;
  /** The repo whose worktree ran it: a re-run needs only the repos that actually failed. */
  readonly repo: string;
  /** The gate's whole captured output. */
  readonly output: string;
  /** The failure summary the run stored, when there is one: it leads with the signature line when the runner stored it. */
  readonly summary?: string | null;
}

/**
 * What a ship gate run did: the first failure for the deliver path, and every failed gate with its output, so the
 * auto-deliver can tell an environment fault from one that needs an agent (@arch:GATE-ENV-RERUN, T1315).
 */
export interface ShipGateReport {
  /** Null when every gate passed (or there is nothing to run); else the first failure. */
  readonly reason: string | null;
  /** Every gate that exited non-zero, in run order. */
  readonly failed: readonly FailedShipGate[];
  /**
   * True when a repo failed before a later repo's gates ran. A re-run of only the failed gates would leave that repo
   * ungated, so the refusal stands instead.
   */
  readonly incomplete?: boolean;
}

const PASSED: ShipGateReport = { reason: null, failed: [] };

/** Null when every gate passed (or there is nothing to run); else the first failure. */
export async function runShipGates(prs: readonly DeliverPr[], d: ShipGatesDeps): Promise<string | null> {
  return (await runShipGatesReport(prs, d)).reason;
}

/** The same run, with every failed gate and its output: the auto-deliver's environment re-run needs that detail (T1315). */
export async function runShipGatesReport(prs: readonly DeliverPr[], d: ShipGatesDeps): Promise<ShipGateReport> {
  const planned: PlannedRepo[] = [];
  for (const pr of prs) {
    const probe = probeScripts(pr.cwd, d.debug);
    const resolution = resolveTargetGates(probe, d.uat, [pr.repo], [], d.debug);
    if (resolution.kind === 'unavailable') {
      if (resolution.blocker === 'nothing-to-run') continue;
      return { reason: `${pr.repo}: ${resolution.reason}`, failed: [] };
    }
    const baseRef = d.gateEnv?.(pr).baseRef;
    const cut = d.uiChanged !== undefined
      ? cutByBaseDelta(resolution.gates, d.uiChanged)
      : d.git && baseRef
      ? await cutGatesWithoutUiChange(resolution.gates, d.git, pr.cwd, baseRef, d.debug)
      : { kept: [...resolution.gates], skipped: [] };
    const wanted = (g: ResolvedGate): boolean => d.only === undefined || d.only.includes(g.name);
    planned.push({ pr, probe, gates: cut.kept.filter(wanted), skipped: cut.skipped.filter(wanted) });
  }
  // An abort during planning (a newer push superseded this run): open no run, or it would close the newer one.
  if (d.signal?.aborted) return { reason: STOPPED, failed: [] };
  const runId = await openRun(planned, d);
  if (d.signal?.aborted) return { reason: STOPPED, failed: [] }; // aborted while the head was read: no run, no gate
  if (runId !== null) d.onRunOpened?.(runId);
  let report: ShipGateReport = PASSED;
  try {
    for (let i = 0; i < planned.length; i += 1) {
      const ran = await runRepo(planned[i]!, d, runId);
      if (ran.reason === null) continue;
      // A later repo never gated: its gates are told apart from the failed ones, so nothing re-runs a subset (T1315).
      report = i < planned.length - 1 ? { ...ran, incomplete: true } : ran;
      break;
    }
  } finally {
    // Stryker disable next-line ConditionalExpression,LogicalOperator: openRun opens a run only for an evidence target, so a run id and an evidence target are one condition
    if (runId !== null && d.evidence) {
      finishDeliverRun(d.evidence.store, runId, report.reason === null ? 'passed' : d.signal?.aborted ? 'stopped' : 'failed', nowIso());
      d.onProgress?.();
    }
  }
  return report;
}

function cutByBaseDelta(gates: readonly ResolvedGate[], uiChanged: boolean): { kept: ResolvedGate[]; skipped: ResolvedGate[] } {
  if (uiChanged) return { kept: [...gates], skipped: [] };
  return { kept: gates.filter((g) => !isUiGate(g)), skipped: gates.filter(isUiGate) };
}

async function openRun(planned: readonly PlannedRepo[], d: ShipGatesDeps): Promise<number | null> {
  if (!d.evidence || planned.length === 0) return null;
  const head = planned[0] && d.headSha ? await d.headSha(planned[0].pr.cwd) : null;
  if (d.signal?.aborted) return null; // aborted while the head was read
  const id = openDeliverRun(d.evidence.store, {
    ticketId: d.evidence.ticketId, headSha: head, pid: process.pid, now: nowIso(), ...(d.kind ? { kind: d.kind } : {}),
    gates: planned.flatMap((p) => [...p.gates, ...p.skipped].map((g) => g.name)),
  });
  d.onProgress?.();
  return id;
}

async function runRepo(p: PlannedRepo, d: ShipGatesDeps, runId: number | null): Promise<ShipGateReport> {
  const { pr, probe } = p;
  const store = d.evidence?.store;
  const head = d.headSha ? await d.headSha(pr.cwd) : null;
  const env = d.gateEnv?.(pr);
  if (store && runId !== null) {
    for (const g of p.skipped) {
      const at = nowIso();
      recordDeliverGate(store, runId, { gateName: g.name, repo: pr.repo, exitCode: null, headSha: head, summary: d.uiSkipReason ?? NO_UI_CHANGE_REASON, startedAt: at, endedAt: at });
    }
  }
  // A gate that is stopped or throws never completes, so its live entry would outlive the run.
  // Stryker disable next-line ConditionalExpression,LogicalOperator: a store always comes with a run id while a gate runs (a null id means an abort before any gate), so the two halves are one condition
  const markCurrent = (name: string): void => { if (store && runId !== null) setDeliverProgress(store, runId, name); };
  const ended = new Set<string>();
  const clearLive = (): void => { for (const g of p.gates) if (!ended.has(g.name)) d.live?.end(g.name); };
  const ran = await runGateList(p.gates, pr.cwd, {
    ...(env ? { prBody: env.prBody } : {}),
    ...(env?.baseRef ? { baseRef: env.baseRef } : {}),
    ...(d.mergedBaseSha ? { mergedBaseSha: d.mergedBaseSha } : {}),
    scriptsAvailable: (script, derived) => (probe.kind === 'ok' ? probe.scripts[script] !== undefined : derived),
    ...(d.runProcess ? { runProcess: d.runProcess } : {}),
    ...(d.hostProcess ? { hostProcess: d.hostProcess } : {}),
    ...(d.debug ? { onDebug: d.debug } : {}),
    ...(d.signal ? { signal: d.signal } : {}),
    ...(d.onOutput ? { onGateOutput: d.onOutput } : {}),
    onGateStart: (name) => {
      markCurrent(name);
      d.live?.start(name);
      d.onProgress?.();
    },
    onGateWait: (name, wait) => {
      // A survivor that waits is the running gate now: current_gate must not keep the name of a gate that ended.
      markCurrent(name);
      d.live?.wait(name, wait);
      d.onProgress?.();
    },
    onGateComplete: (name, exitCode, startedAt, endedAt, _index, output, waitMs) => {
      ended.add(name);
      d.live?.end(name);
      if (store && runId !== null) {
        const failed = exitCode !== null && exitCode !== 0;
        recordDeliverGate(store, runId, {
          gateName: name, repo: pr.repo, exitCode, headSha: head,
          summary: gateSummary(failed ? summarizeGateFailure(output ?? '') ?? null : null, d.mergedBaseSha ? scopeLinesOf(output ?? '') : null), startedAt, endedAt, waitMs: waitMs ?? null,
        });
      }
      d.onProgress?.();
    },
  }).finally(clearLive);
  if (ran.kind === 'stopped') return { reason: `${pr.repo}: gate run was stopped`, failed: [] };
  // A refused gate never ran (no exit code, `@arch:GATE-CAPABILITY`): no verdict, and nothing a re-run could ask for.
  // It is checked before any failure, so an earlier failed gate never hides it from the environment re-run (T1315).
  const refused = ran.results.find((r) => r.hostRefused);
  if (refused) return { reason: `${pr.repo}: gate "${refused.name}" could not run (refused by the host boundary), so the merge is not verified`, failed: [] };
  for (const r of ran.results) {
    if (r.exitCode === null || r.exitCode === 0) continue;
    // The list runs no short-circuit (a gate list runs to the end), so every failed gate is known here: the environment
    // re-run needs all of them, and the first one in run order is the reason the deliver path shows (T1315).
    return {
      reason: `${pr.repo}: gate "${r.name}" failed (exit ${r.exitCode})${summaryOf(r.output)}`,
      failed: ran.results.filter((x) => x.exitCode !== null && x.exitCode !== 0).map((x) => ({ name: x.name, repo: pr.repo, output: x.output, summary: summarizeGateFailure(x.output) })),
    };
  }
  return PASSED;
}

/**
 * The scope and selection lines a sweep gate prints (`full: ...`, `visual: 12 files, delta since ...`, `unit: 8 files, delta since ...`, `visual: running ...`,
 * `layout: skipped, ...`), or null. A base-moved row keeps them: the deliver output is not stored (@arch:GATE-BASE-MOVED).
 */
const SCOPE_LINE = /^(?:full: .+|skipped: no UI change .+|(?:visual|layout): (?:running|skipped|\d+ files).+|(?:test:)?(?:unit|integration): \d+ files.+)$/;
export function scopeLinesOf(output: string): string | null {
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => SCOPE_LINE.test(l));
  return lines.length === 0 ? null : lines.join('\n');
}

const gateSummary = (failure: string | null, scope: string | null): string | null =>
  scope === null ? failure : failure === null ? scope : `${scope}\n${failure}`;

const summaryOf = (output: string): string => {
  const summary = summarizeGateFailure(output);
  return summary === null ? '' : ` — ${summary}`;
};
