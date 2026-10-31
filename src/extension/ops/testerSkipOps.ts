import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { clearStageBlock, stageBlock } from '../../store/stageBlocks.js';
import { latestStageRun } from '../../store/stageRuns.js';
import { commitGateOutcome } from '../../workflow/gates/commit.js';
import { nowIso } from '../../model/time.js';
import { formatId } from '../../model/entityId.js';
import type { Notify } from './notify.js';

/** The stage log line an accepted skip leaves behind. */
export const TESTER_SKIP_ACCEPTED_LOG = 'uat: tester skip accepted by user';

export type TesterSkipRequest = 'rerun' | 'accept';

export interface TesterSkipDeps {
  store: Store;
  ticketId: number;
  notify: Notify;
  /** Drive the ticket (the trigger Resume uses) after the block is cleared. */
  redrive: (ticketId: number) => void;
  /** Repaint the panel after the action. */
  refresh: (ticketId: number) => void;
  now?: () => string;
  debug?: (message: string) => void;
}

/**
 * The two actions of a `tester-skipped` block (@arch:UAT-OBS-RUNS). Both refuse
 * unless UAT is still parked on that block. Neither is a verdict about the
 * code: Accept commits a PASSED UAT verdict (clearing the block in the same
 * transaction), Re-run clears the block and re-drives UAT, which then follows
 * the same `onSkip` rule.
 */
export function decideTesterSkip(deps: TesterSkipDeps, request: TesterSkipRequest): 'refused' | TesterSkipRequest {
  const { store, ticketId } = deps;
  const now = deps.now ?? nowIso;
  const debug = deps.debug ?? (() => {});
  const label = formatId('ticket', ticketId);
  if (getTicket(store, ticketId).stageCurrent !== 'uat' || stageBlock(store, ticketId, 'uat')?.kind !== 'tester-skipped') {
    deps.notify.warn(`${label} is no longer waiting on a skipped tester.`);
    debug(`[gate] tester skip ticket ${ticketId}: refused (not parked)`);
    return 'refused';
  }
  if (request === 'rerun') {
    clearStageBlock(store, ticketId, 'uat');
    debug(`[gate] tester skip ticket ${ticketId}: re-running the tester`);
    deps.redrive(ticketId);
    return 'rerun';
  }
  const run = latestStageRun(store, ticketId, 'uat');
  const stage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'uat');
  commitGateOutcome(store, {
    ticketId,
    stageKey: 'uat',
    runAt: now(),
    artifactPath: stage?.artifactPath ?? '',
    gates: [],
    outcome: { kind: 'verdict', verdict: { kind: 'passed' } },
    stageRunId: run?.id ?? null,
    now,
    debug,
  });
  debug(`[gate] tester skip ticket ${ticketId}: ${TESTER_SKIP_ACCEPTED_LOG}`);
  deps.notify.info(`${label}: ${TESTER_SKIP_ACCEPTED_LOG}`);
  deps.redrive(ticketId);
  return 'accept';
}

/** The two dashboard actions, ready to spread into `DashboardActions`. */
export function makeTesterSkipActions(deps: TesterSkipDeps): {
  testerSkippedRerun: () => void;
  testerSkippedAccept: () => void;
} {
  const run = (request: TesterSkipRequest): void => {
    decideTesterSkip(deps, request);
    deps.refresh(deps.ticketId);
  };
  return {
    testerSkippedRerun: () => run('rerun'),
    testerSkippedAccept: () => run('accept'),
  };
}
