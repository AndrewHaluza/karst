import type { Store } from '../../store/db.js';
import { listGateRuns, type GateRun } from '../../store/gateRuns.js';
import type { StageKey } from '../../model/types.js';

/** The refusals a run recorded: gate name + reason, sorted, or '' when the run had none. */
function refusalSignature(rows: readonly GateRun[]): string {
  return rows
    .filter((r) => r.exitCode === null && !r.skipped && r.summary !== null)
    .map((r) => `${r.gateName}: ${r.summary}`)
    .sort()
    .join('\n');
}

/** Whether the run before `runId` for this stage was refused with the very same reasons. */
export function hostRefusalRepeats(store: Store, ticketId: number, stageKey: StageKey, runId: number): boolean {
  const rows = listGateRuns(store, ticketId).filter((r) => r.stageKey === stageKey && r.stageRunId !== null);
  const current = refusalSignature(rows.filter((r) => r.stageRunId === runId));
  if (current === '') return false;
  const earlier = rows.filter((r) => r.stageRunId! < runId);
  if (earlier.length === 0) return false;
  const previousId = Math.max(...earlier.map((r) => r.stageRunId!));
  return refusalSignature(earlier.filter((r) => r.stageRunId === previousId)) === current;
}

/**
 * The park reason for a host-gate refusal. A refusal identical to the previous
 * run's will not clear by itself, so the reason says it repeats and names the
 * manual action instead of inviting another round.
 */
export function escalatedRefusalReason(reason: string, repeats: boolean, cwd: string): string {
  if (!repeats) return reason;
  const action = reason.includes('uncommitted changes')
    ? `remove or commit these files in ${cwd}, then retry`
    : `fix the cause named above (worktree ${cwd}), then retry`;
  return `${reason} — this refusal repeats unchanged and re-running will not clear it: ${action}`;
}
