import { probeScripts } from '../../workflow/gates/probe.js';
import { runGateList } from '../../workflow/gates/runList.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { resolveTargetGates } from '../../workflow/stages/uat.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import type { UatConfig } from '../../manifest/types.js';
import type { DeliverPr } from '../../workflow/deliverState.js';

/**
 * The gate set a resolved merge must pass before Karst pushes it (arch:AC-39,
 * D247). Ship has no gate list of its own, so this is the ticket's UAT gate set
 * (declared `uat.gates`, else the probed scripts) run against each PR's merged
 * worktree. Nothing is recorded as stage evidence: it is a pre-push check, and a
 * failure leaves the merge undelivered with the reason shown.
 */
export interface ShipGatesDeps {
  readonly uat: UatConfig | undefined;
  /** A sandboxed ticket's gates run inside its sandbox, never on the host (arch:AC-39). */
  readonly runProcess?: GateProcessRunner;
  readonly hostProcess?: GateProcessRunner;
  readonly debug?: (message: string) => void;
}

/** Null when every gate passed (or there is nothing to run); else the first failure. */
export async function runShipGates(prs: readonly DeliverPr[], d: ShipGatesDeps): Promise<string | null> {
  for (const pr of prs) {
    const probe = probeScripts(pr.cwd, d.debug);
    const resolution = resolveTargetGates(probe, d.uat, [pr.repo], [], d.debug);
    if (resolution.kind === 'unavailable') {
      if (resolution.blocker === 'nothing-to-run') continue;
      return `${pr.repo}: ${resolution.reason}`;
    }
    const ran = await runGateList(resolution.gates, pr.cwd, {
      scriptsAvailable: (script, derived) => (probe.kind === 'ok' ? probe.scripts[script] !== undefined : derived),
      ...(d.runProcess ? { runProcess: d.runProcess } : {}),
      ...(d.hostProcess ? { hostProcess: d.hostProcess } : {}),
      ...(d.debug ? { onDebug: d.debug } : {}),
    });
    if (ran.kind === 'stopped') return `${pr.repo}: gate run was stopped`;
    for (const r of ran.results) {
      if (r.exitCode === null || r.exitCode === 0) continue;
      return `${pr.repo}: gate "${r.name}" failed (exit ${r.exitCode})${summaryOf(r.output)}`;
    }
  }
  return null;
}

const summaryOf = (output: string): string => {
  const summary = summarizeGateFailure(output);
  return summary === null ? '' : ` — ${summary}`;
};
