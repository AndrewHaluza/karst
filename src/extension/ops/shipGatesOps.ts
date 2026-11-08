import { probeScripts } from '../../workflow/gates/probe.js';
import { runGateList } from '../../workflow/gates/runList.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { resolveTargetGates } from '../../workflow/stages/uat.js';
import type { ResolvedGate } from '../../workflow/gates/resolve.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import type { UatConfig } from '../../manifest/types.js';
import type { DeliverPr } from '../../workflow/deliverState.js';
import type { GateOutputChunk } from '../../workflow/gates/run.js';
import type { Store } from '../../store/db.js';
import { finishDeliverRun, openDeliverRun, recordDeliverGate, setDeliverProgress } from '../../store/deliverRuns.js';
import { nowIso } from '../../model/time.js';
import type { GitRunner } from '../../integrations/git.js';
import { cutGatesWithoutUiChange } from '../../workflow/gates/uiDiff.js';
import { NO_UI_CHANGE_REASON } from '../../workflow/gates/uiScope.js';

/**
 * The gate set a resolved merge must pass before Karst pushes it (arch:AC-39,
 * D247). Ship has no gate list of its own, so this is the ticket's UAT gate set
 * (declared `uat.gates`, else the probed scripts) run against each PR's merged
 * worktree. With `evidence` the run is recorded (T1018, @arch:EVIDENCE-WHEN): a
 * `deliver_runs` row opens before the first gate and one `deliver_gate_results` row
 * (with the head SHA) is appended as each gate finishes. A failure leaves the merge
 * undelivered with the reason shown, and its record stays.
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
  /** Aborts the running gate process (a manual Deliver takes over). */
  readonly signal?: AbortSignal;
  /** Live gate output for the ship console (@arch:GATE-OUTPUT). */
  readonly onOutput?: (gateName: string, chunk: GateOutputChunk) => void;
  /** A gate started or finished: the host pushes the dashboard state. */
  readonly onProgress?: () => void;
  /**
   * The ticket's rendered arch citations and base branch for one PR, so the
   * `docs:gate` gate reads the same `PR_BODY` and `BASE_REF` it reads in UAT.
   */
  /**
   * Reads the merged diff so the UI gates are cut when no UI path changed, as UAT does
   * (@arch:AP-01). Absent → every gate runs.
   */
  readonly git?: GitRunner;
  readonly gateEnv?: (pr: DeliverPr) => { readonly prBody: string; readonly baseRef?: string };
}

interface PlannedRepo {
  readonly pr: DeliverPr;
  readonly probe: ReturnType<typeof probeScripts>;
  readonly gates: readonly ResolvedGate[];
  /** Gates cut by the UI-path rule: kept in the run plan, recorded as skipped, never run. */
  readonly skipped: readonly ResolvedGate[];
}

/** Null when every gate passed (or there is nothing to run); else the first failure. */
export async function runShipGates(prs: readonly DeliverPr[], d: ShipGatesDeps): Promise<string | null> {
  const planned: PlannedRepo[] = [];
  for (const pr of prs) {
    const probe = probeScripts(pr.cwd, d.debug);
    const resolution = resolveTargetGates(probe, d.uat, [pr.repo], [], d.debug);
    if (resolution.kind === 'unavailable') {
      if (resolution.blocker === 'nothing-to-run') continue;
      return `${pr.repo}: ${resolution.reason}`;
    }
    const baseRef = d.gateEnv?.(pr).baseRef;
    const cut = d.git && baseRef
      ? await cutGatesWithoutUiChange(resolution.gates, d.git, pr.cwd, baseRef, d.debug)
      : { kept: [...resolution.gates], skipped: [] };
    planned.push({ pr, probe, gates: cut.kept, skipped: cut.skipped });
  }
  const runId = await openRun(planned, d);
  let failure: string | null = null;
  try {
    for (const p of planned) {
      failure = await runRepo(p, d, runId);
      if (failure !== null) break;
    }
  } finally {
    if (runId !== null && d.evidence) {
      finishDeliverRun(d.evidence.store, runId, failure === null ? 'passed' : d.signal?.aborted ? 'stopped' : 'failed', nowIso());
      d.onProgress?.();
    }
  }
  return failure;
}

async function openRun(planned: readonly PlannedRepo[], d: ShipGatesDeps): Promise<number | null> {
  if (!d.evidence || planned.length === 0) return null;
  const head = planned[0] && d.headSha ? await d.headSha(planned[0].pr.cwd) : null;
  const id = openDeliverRun(d.evidence.store, {
    ticketId: d.evidence.ticketId, headSha: head, pid: process.pid, now: nowIso(),
    gates: planned.flatMap((p) => [...p.gates, ...p.skipped].map((g) => g.name)),
  });
  d.onProgress?.();
  return id;
}

async function runRepo(p: PlannedRepo, d: ShipGatesDeps, runId: number | null): Promise<string | null> {
  const { pr, probe } = p;
  const store = d.evidence?.store;
  const head = d.headSha ? await d.headSha(pr.cwd) : null;
  const env = d.gateEnv?.(pr);
  if (store && runId !== null) {
    for (const g of p.skipped) {
      const at = nowIso();
      recordDeliverGate(store, runId, { gateName: g.name, repo: pr.repo, exitCode: null, headSha: head, summary: NO_UI_CHANGE_REASON, startedAt: at, endedAt: at });
    }
  }
  const ran = await runGateList(p.gates, pr.cwd, {
    ...(env ? { prBody: env.prBody } : {}),
    ...(env?.baseRef ? { baseRef: env.baseRef } : {}),
    scriptsAvailable: (script, derived) => (probe.kind === 'ok' ? probe.scripts[script] !== undefined : derived),
    ...(d.runProcess ? { runProcess: d.runProcess } : {}),
    ...(d.hostProcess ? { hostProcess: d.hostProcess } : {}),
    ...(d.debug ? { onDebug: d.debug } : {}),
    ...(d.signal ? { signal: d.signal } : {}),
    ...(d.onOutput ? { onGateOutput: d.onOutput } : {}),
    onGateStart: (name) => {
      if (store && runId !== null) setDeliverProgress(store, runId, name);
      d.onProgress?.();
    },
    onGateComplete: (name, exitCode, startedAt, endedAt, _index, output) => {
      if (store && runId !== null) {
        const failed = exitCode !== null && exitCode !== 0;
        recordDeliverGate(store, runId, {
          gateName: name, repo: pr.repo, exitCode, headSha: head,
          summary: failed ? summarizeGateFailure(output ?? '') ?? null : null, startedAt, endedAt,
        });
      }
      d.onProgress?.();
    },
  });
  if (ran.kind === 'stopped') return `${pr.repo}: gate run was stopped`;
  for (const r of ran.results) {
    if (r.exitCode === null && r.hostRefused) return `${pr.repo}: gate "${r.name}" could not run (refused by the host boundary), so the merge is not verified`;
    if (r.exitCode === null || r.exitCode === 0) continue;
    return `${pr.repo}: gate "${r.name}" failed (exit ${r.exitCode})${summaryOf(r.output)}`;
  }
  return null;
}

const summaryOf = (output: string): string => {
  const summary = summarizeGateFailure(output);
  return summary === null ? '' : ` — ${summary}`;
};
