import type { Store } from '../../store/db.js';
import { getTicket, setAgentState, setStageCurrent, updateTicketFields } from '../../store/tickets.js';
import { clearStageBlock, stageBlock } from '../../store/stageBlocks.js';
import { setStage, stageAttempt } from '../../store/stages.js';
import { latestStageRun } from '../../store/stageRuns.js';
import { openRecoveryRound } from '../../store/recoveryRounds.js';
import { recordStallAccept, recordStallNote } from '../../store/stallNote.js';
import { commitGateOutcome } from '../../workflow/gates/commit.js';
import { openBlockingCount, stallRounds, isDocsOnlyDiff } from '../../workflow/stallSuggestion.js';
import type { StallOptionKind } from '../../model/stallSuggestion.js';
import type { Severity } from '../../manifest/types.js';
import { nowIso } from '../../model/time.js';
import { formatId } from '../../model/entityId.js';
import type { Notify } from './notify.js';

/** One Apply, as the banner sends it: the chosen option with the user's edits. */
export interface StallApplyRequest {
  kind: StallOptionKind;
  label: string;
  note: string;
  /** Full replacement text; blank or absent = unchanged. */
  description?: string;
  acceptanceCheck?: string;
}

export type StallApplyResult = { ok: true } | { ok: false; reason: string };

export interface StallApplyDeps {
  store: Store;
  ticketId: number;
  notify: Notify;
  /** Drive the ticket (the trigger Resume uses) after the park is cleared. */
  redrive: (ticketId: number) => void;
  /** Repaint the panel after the action. */
  refresh: (ticketId: number) => void;
  /** The files of the ticket's live diff, or null when it cannot be read. */
  diffFiles: () => Promise<readonly string[] | null>;
  /** The fix-round budget for a review-sourced round. */
  maxRounds: () => number;
  /** Findings at or above this severity block review. */
  blockingSeverity: Severity | 'none';
  now?: () => string;
  debug?: (message: string) => void;
}

const REFUSED_NOT_STALLED = 'The ticket is no longer parked on a review stall.';
const REFUSED_SESSION = 'An agent session is running on this ticket. Stop it first, then apply.';
const REFUSED_NO_NOTE = 'The option has no note for the fix agent.';
const REFUSED_NOT_DOCS = 'The diff holds a file outside docs/. The report cannot pass with open findings.';
const REFUSED_DIFF = 'The diff could not be read. Try again.';

/** Mark every review recovery round that is not history as `reset`: this ends the episode. */
function endReviewEpisode(store: Store, ticketId: number, at: string): void {
  store.db
    .prepare(
      `UPDATE recovery_rounds
          SET status = 'reset', ended_at = ?
        WHERE ticket_id = ? AND source_stage = 'review'
          AND status IN ('pending','fixing','revalidating','exhausted')`,
    )
    .run(at, ticketId);
}

function refusal(deps: StallApplyDeps, reason: string): StallApplyResult {
  deps.notify.warn(`${formatId('ticket', deps.ticketId)}: ${reason}`);
  deps.debug?.(`[stall] apply ticket ${deps.ticketId}: refused (${reason})`);
  return { ok: false, reason };
}

/** The guards both options share: still parked on a stall, and no agent session running. */
function sharedRefusal(deps: StallApplyDeps): string | null {
  const { store, ticketId } = deps;
  if (getTicket(store, ticketId).stageCurrent !== 'fix' || stageBlock(store, ticketId, 'fix')?.kind !== 'review-stalled') {
    return REFUSED_NOT_STALLED;
  }
  if (getTicket(store, ticketId).agentState === 'running') return REFUSED_SESSION;
  return null;
}

function applyAgentOption(deps: StallApplyDeps, req: StallApplyRequest, at: string): StallApplyResult {
  const { store, ticketId } = deps;
  const note = req.note.trim();
  if (note === '') return refusal(deps, REFUSED_NO_NOTE);
  const description = req.description?.trim() ?? '';
  const acceptanceCheck = req.acceptanceCheck?.trim() ?? '';
  const review = latestStageRun(store, ticketId, 'review');
  store.db.transaction(() => {
    updateTicketFields(store, ticketId, {
      ...(description === '' ? {} : { description }),
      ...(acceptanceCheck === '' ? {} : { intent: acceptanceCheck }),
    });
    recordStallNote(store, ticketId, stageAttempt(store, ticketId, 'review'), at, note);
    endReviewEpisode(store, ticketId, at);
    clearStageBlock(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { status: 'running', verdict: null, endedAt: null });
    openRecoveryRound(store, {
      ticketId,
      sourceStage: 'review',
      sourceProcessId: 'review',
      sourceStageRunId: review?.id ?? null,
      sourceProcessRunId: null,
      triggerKind: 'blocking-review-findings',
      triggerDetail: `stall option applied: ${req.label}`,
      maxRounds: deps.maxRounds(),
      startedAt: at,
    });
  })();
  deps.notify.info(`${formatId('ticket', ticketId)}: stall answered — "${req.label}". A fix round opens.`);
  return { ok: true };
}

async function applyAccept(deps: StallApplyDeps, at: string): Promise<StallApplyResult> {
  const { store, ticketId } = deps;
  const files = await deps.diffFiles();
  if (files === null) return refusal(deps, REFUSED_DIFF);
  if (!isDocsOnlyDiff(files)) return refusal(deps, REFUSED_NOT_DOCS);
  const open = openBlockingCount(stallRounds(store, ticketId, deps.blockingSeverity));
  const run = latestStageRun(store, ticketId, 'review');
  const stage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'review');
  store.db.transaction(() => {
    recordStallAccept(store, ticketId, stageAttempt(store, ticketId, 'review'), at, open);
    endReviewEpisode(store, ticketId, at);
    clearStageBlock(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { status: 'pending', verdict: null, attempt: 0, startedAt: null, endedAt: null });
    // The verdict belongs to review: the machine moves the ticket from there.
    setStageCurrent(store, ticketId, 'review');
    setStage(store, ticketId, 'review', { status: 'running' });
    commitGateOutcome(store, {
      ticketId,
      stageKey: 'review',
      runAt: at,
      artifactPath: stage?.artifactPath ?? '',
      gates: [],
      outcome: { kind: 'verdict', verdict: { kind: 'passed' } },
      stageRunId: run?.id ?? null,
      now: () => at,
      ...(deps.debug === undefined ? {} : { debug: deps.debug }),
    });
  })();
  deps.notify.info(
    `${formatId('ticket', ticketId)}: report accepted with ${open} open blocking finding(s). They stay unfixed.`,
  );
  return { ok: true };
}

/**
 * The one Apply of a review stall. It refuses unless the ticket is still parked
 * on the stall and no agent session runs. An agent option stores the changed
 * fields, records the note, ends the episode and opens a fix round with no
 * review first. The host option "Accept the report as it is" re-checks the
 * docs-only rule on the live diff and passes review without a fix round.
 */
export async function applyStallOption(deps: StallApplyDeps, req: StallApplyRequest): Promise<StallApplyResult> {
  const at = (deps.now ?? nowIso)();
  try {
    const blocked = sharedRefusal(deps);
    if (blocked !== null) return refusal(deps, blocked);
    const result = req.kind === 'accept-docs' ? await applyAccept(deps, at) : applyAgentOption(deps, req, at);
    if (result.ok) {
      setAgentState(deps.store, deps.ticketId, 'idle');
      deps.redrive(deps.ticketId);
    }
    return result;
  } finally {
    deps.refresh(deps.ticketId);
  }
}
