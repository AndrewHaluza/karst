import type { Store } from '../../store/db.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { stageAttempt } from '../../store/stages.js';
import { recordReviewStallHint } from '../../store/reviewStallHint.js';
import { resetGateStage } from '../../workflow/resetStage.js';
import { formatId } from '../../model/entityId.js';
import { nowIso } from '../../model/time.js';

export interface ReviewStallActionDeps {
  store: Store;
  ticketId: number;
  /** Refreshes the dashboard on EVERY exit so the webview's pending item settles. */
  afterServerChange: () => void;
  logError: (message: string, err: unknown) => void;
  debug: (message: string) => void;
  /** Re-drive the ticket after the stall is answered. */
  drive: () => void;
  info: (message: string) => void;
  error: (message: string) => void;
  confirm: (title: string, detail: string) => Promise<boolean>;
  /** Asks for the hint text; undefined/blank = cancelled. */
  promptHint: () => Promise<string | undefined>;
  now?: () => string;
}

function isStalled(store: Store, ticketId: number): boolean {
  return stageBlock(store, ticketId, 'fix')?.kind === 'review-stalled';
}

async function answerStall(
  deps: ReviewStallActionDeps,
  ask: () => Promise<string | null | undefined>,
  hint: boolean,
): Promise<void> {
  const label = formatId('ticket', deps.ticketId);
  try {
    if (!isStalled(deps.store, deps.ticketId)) {
      deps.info(`Ticket ${label} is not parked on a review stall.`);
      return;
    }
    const answer = await ask();
    if (answer === undefined || answer === null) return;
    const at = (deps.now ?? nowIso)();
    if (hint) {
      recordReviewStallHint(
        deps.store, deps.ticketId, stageAttempt(deps.store, deps.ticketId, 'review'), at, answer,
      );
    }
    // Counter reset = the reset round ends the episode and the stall window.
    resetGateStage(deps.store, deps.ticketId, { now: () => at, debug: deps.debug });
    deps.drive();
  } catch (e) {
    deps.logError('review stall action failed', e);
    deps.error(`Could not resume ticket ${label}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    deps.afterServerChange();
  }
}

/** 'Redesign hint…': note to the fix agent, counter reset, rounds resume. */
export function redesignHintAction(deps: ReviewStallActionDeps): void {
  void answerStall(
    deps,
    async () => {
      const text = (await deps.promptHint())?.trim();
      return text ? text : undefined;
    },
    true,
  );
}

/** 'Continue anyway': counter reset, rounds resume. */
export function continueAnywayAction(deps: ReviewStallActionDeps): void {
  void answerStall(
    deps,
    async () =>
      (await deps.confirm(
        'Continue anyway?',
        'Resets the stall counter and re-runs review; fix rounds resume. Existing evidence stays in history.',
      ))
        ? ''
        : undefined,
    false,
  );
}
