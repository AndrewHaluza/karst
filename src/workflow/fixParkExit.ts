import type { Store } from '../store/db.js';
import type { Severity } from '../manifest/types.js';
import type { RecoveryRound } from '../store/recoveryRoundsRead.js';
import { parkedFixRound } from '../store/fixNoChangeRounds.js';
import { recordFixRoundAcceptance } from '../store/fixRoundAcceptances.js';
import { closeRoundPassed } from '../store/hostRerunRound.js';
import { listGateRuns } from '../store/gateRuns.js';
import { getStage, setStage } from '../store/stages.js';
import { latestStageRun } from '../store/stageRuns.js';
import { setAgentState, setStageCurrent } from '../store/tickets.js';
import { nowIso } from '../model/time.js';
import { failedGatesOf } from './fixHostRerun.js';
import { openBlockingItems } from './noChangeClaim.js';
import { commitGateOutcome } from './gates/commit.js';

/** `end_reason` of a parked round when the user retries the source gate. */
export const FIX_PARK_RETRY_END_REASON = (stage: string): string => `no change: the user retried the ${stage} gate`;

/** `end_reason` of a parked round when the user accepts it and continues. */
export const FIX_PARK_ACCEPT_END_REASON = 'accepted by the user';

/** The most items the banner shows. */
export const FIX_PARK_VIEW_MAX_ITEMS = 5;

type SourceStage = 'uat' | 'review';
export type FixParkExitResult = { ok: true; stage: SourceStage } | { ok: false; reason: string };

export interface FixParkView {
  sourceStage: SourceStage;
  trigger: 'gate-failure' | 'blocking-review-findings' | 'blocking-tester-observations' | 'other';
  reason: string;
  items: string[];
}

const NOT_PARKED = 'the fix round is not parked';
/** The manifest threshold of one source stage; absent means the default. */
export type BlockingSeverityOf = (stage: SourceStage) => Severity | 'none' | undefined;

/** The round when it is parked and has a gate source stage, else null. */
function parkedGateRound(store: Store, ticketId: number): (RecoveryRound & { sourceStage: SourceStage }) | null {
  const round = parkedFixRound(store, ticketId);
  return round !== null && (round.sourceStage === 'uat' || round.sourceStage === 'review')
    ? { ...round, sourceStage: round.sourceStage }
    : null;
}

const CLEARED = { verdict: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null } as const;

/** One line for each failed gate, finding or observation the parked round leaves open. */
export function parkedRoundItems(store: Store, ticketId: number, round: RecoveryRound, blockingSeverity?: Severity | 'none'): string[] {
  switch (round.triggerKind) {
    case 'gate-failure':
      return failedGatesOf(listGateRuns(store, ticketId), round.sourceStage).map((g) => g.gateName);
    case 'blocking-review-findings':
      return openBlockingItems(store, ticketId, 'review', blockingSeverity);
    case 'blocking-tester-observations':
      return openBlockingItems(store, ticketId, 'uat', blockingSeverity);
    default:
      return [];
  }
}

/** What the dashboard banner shows for a parked round, or null. */
export function fixParkView(store: Store, ticketId: number, blockingSeverityOf?: BlockingSeverityOf): FixParkView | null {
  const round = parkedGateRound(store, ticketId);
  if (round === null) return null;
  const trigger = round.triggerKind === 'gate-failure' || round.triggerKind === 'blocking-review-findings' || round.triggerKind === 'blocking-tester-observations'
    ? round.triggerKind
    : 'other';
  return {
    sourceStage: round.sourceStage,
    trigger,
    reason: getStage(store, ticketId, 'fix')?.verdict ?? '',
    items: parkedRoundItems(store, ticketId, round, blockingSeverityOf?.(round.sourceStage)).slice(0, FIX_PARK_VIEW_MAX_ITEMS),
  };
}

/** Clear the fix row and put the source stage in charge, as the first writes of both exits. */
function leaveFix(store: Store, ticketId: number, source: SourceStage, at: string): void {
  setStage(store, ticketId, 'fix', { status: 'pending', startedAt: null, attempt: 0, artifactPath: null, ...CLEARED });
  setStageCurrent(store, ticketId, source);
  setStage(store, ticketId, source, { status: 'running', startedAt: at, attempt: 0, ...CLEARED });
}

/**
 * Retry the source gate of a parked round. The round stays `interrupted`, so the next failure opens
 * the next round of the same episode and the budget does not reset.
 */
export function retryParkedFixRound(store: Store, ticketId: number, opts?: { now?: (() => string) | undefined }): FixParkExitResult {
  const at = (opts?.now ?? nowIso)();
  return store.db.transaction((): FixParkExitResult => {
    const round = parkedGateRound(store, ticketId);
    if (round === null) return { ok: false, reason: NOT_PARKED };
    store.db.prepare('UPDATE recovery_rounds SET end_reason = ? WHERE id = ?').run(FIX_PARK_RETRY_END_REASON(round.sourceStage), round.id);
    leaveFix(store, ticketId, round.sourceStage, at);
    setAgentState(store, ticketId, 'idle');
    return { ok: true, stage: round.sourceStage };
  })();
}

/**
 * Accept the parked round: record the user decision, close the round `passed` and commit a PASSED
 * verdict on the source stage, so the machine moves on (uat to review, review to ship).
 */
export function acceptParkedFixRound(store: Store, ticketId: number, note: string | null, opts?: { now?: (() => string) | undefined; blockingSeverityOf?: BlockingSeverityOf | undefined }): FixParkExitResult {
  const at = (opts?.now ?? nowIso)();
  return store.db.transaction((): FixParkExitResult => {
    const round = parkedGateRound(store, ticketId);
    if (round === null) return { ok: false, reason: NOT_PARKED };
    const source = round.sourceStage;
    recordFixRoundAcceptance(store, {
      ticketId, roundId: round.id, sourceStage: source, triggerKind: round.triggerKind,
      items: parkedRoundItems(store, ticketId, round, opts?.blockingSeverityOf?.(source)), note, decidedAt: at,
    });
    closeRoundPassed(store, round.id, FIX_PARK_ACCEPT_END_REASON, at);
    leaveFix(store, ticketId, source, at);
    commitGateOutcome(store, {
      ticketId,
      stageKey: source,
      runAt: at,
      artifactPath: getStage(store, ticketId, source)?.artifactPath ?? '',
      gates: [],
      outcome: { kind: 'verdict', verdict: { kind: 'passed' } },
      stageRunId: latestStageRun(store, ticketId, source)?.id ?? null,
      now: () => at,
    });
    setAgentState(store, ticketId, 'idle');
    return { ok: true, stage: source };
  })();
}
