import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { StageKey } from '../model/types.js';
import type { GitRunner } from '../integrations/git.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { listGateRuns, HOST_RERUN_SOURCE, type GateRun } from '../store/gateRuns.js';
import { stageAttempt } from '../store/stages.js';
import { recordUatGatePass } from '../store/uatGatePasses.js';
import { nowIso } from '../model/time.js';
import { fingerprintTicket } from './gates/baselineReviewTicket.js';

export interface HostRerunPassDeps {
  readonly manifest: () => Manifest | undefined;
  readonly git: GitRunner;
  /** Test seam; defaults to `fingerprintTicket`, the fingerprint UAT computes on re-entry. */
  readonly fingerprint?: typeof fingerprintTicket;
  readonly now?: () => string;
}

export type HostRerunPassResult = 'recorded' | 'not-uat' | 'baseline-review-off' | 'no-batch' | 'gate-not-passed' | 'no-fingerprint';

const sameGate = (a: GateRun, b: GateRun): boolean =>
  a.gateName === b.gateName && a.repo === b.repo && a.command === b.command && (a.args ?? []).join('\u0000') === (b.args ?? []).join('\u0000');

const passed = (r: GateRun): boolean => !r.skipped && r.exitCode === 0;

/** The rows of the source stage's latest UAT batch (host re-run rows are not batches). */
function latestBatch(runs: readonly GateRun[], stage: StageKey): GateRun[] {
  const own = runs.filter((r) => r.stageKey === stage);
  const latest = own.reduce((max, r) => (r.runAt > max ? r.runAt : max), '');
  return own.filter((r) => r.runAt === latest);
}

/**
 * After a passing host re-run (@arch:BASELINE-REVIEW): when every gate of the failed batch has a
 * pass, either in the batch or in the re-run, remember it at the working-tree fingerprint, so the
 * UAT re-entry does not run the same gate list again. The row key is the attempt UAT reads on
 * re-entry (`returnToSource` leaves `stages.attempt` as the failed verdict raised it). Without
 * baseline review UAT computes no fingerprint, so nothing is recorded and the full list runs.
 */
export async function recordHostRerunPass(store: Store, ticketId: number, stage: StageKey, deps: HostRerunPassDeps): Promise<HostRerunPassResult> {
  if (stage !== 'uat') return 'not-uat';
  const manifest = deps.manifest();
  if (manifest === undefined || (manifest.uat?.baselineReview?.paths.length ?? 0) === 0) return 'baseline-review-off';
  const batch = latestBatch(listGateRuns(store, ticketId), stage);
  if (batch.length === 0) return 'no-batch';
  const batchAt = batch[0]!.runAt;
  const reruns = listGateRuns(store, ticketId, { includeHostRerun: true }).filter((r) => r.source === HOST_RERUN_SOURCE && r.stageKey === stage && r.runAt >= batchAt);
  const covered = batch.every((row) => passed(row) || reruns.some((r) => passed(r) && sameGate(r, row)));
  if (!covered) return 'gate-not-passed';
  const repos = new Set(batch.map((r) => r.repo));
  const worktrees = listWorktreesByTicket(store, ticketId).filter((w) => repos.has(w.repo));
  const fingerprint = await (deps.fingerprint ?? fingerprintTicket)(store, manifest, ticketId, worktrees.map((w) => ({ repo: w.repo, path: w.path })), { git: deps.git });
  if (fingerprint === null) return 'no-fingerprint';
  recordUatGatePass(store, { ticketId, attempt: stageAttempt(store, ticketId, stage), fingerprint, runAt: (deps.now ?? nowIso)() });
  return 'recorded';
}
