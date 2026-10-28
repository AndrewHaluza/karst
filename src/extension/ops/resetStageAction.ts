import type { Store } from '../../store/db.js';
import { resetStageState, resetGateStage } from '../../workflow/resetStage.js';
import { formatId } from '../../model/entityId.js';

export interface ResetStageActionDeps {
  store: Store;
  ticketId: number;
  /** Refreshes the dashboard on EVERY exit so the webview's pending item settles. */
  afterServerChange: () => void;
  logError: (message: string, err: unknown) => void;
  debug: (message: string) => void;
  /** Re-drive the ticket after the reset. */
  drive: () => void;
  info: (message: string) => void;
  error: (message: string) => void;
  confirm: (title: string, detail: string) => Promise<boolean>;
}

/**
 * The dashboard "Reset stage" recovery (T831): host-confirmed, availability
 * re-derived inside the mutation, then the ticket is re-driven at the gate.
 */
export function resetStageAction(deps: ResetStageActionDeps): void {
  void (async () => {
    const label = formatId('ticket', deps.ticketId);
    try {
      const state = resetStageState(deps.store, deps.ticketId);
      if (!state.available) {
        deps.info(`Ticket ${label} cannot be reset right now (${state.reason}).`);
        return;
      }
      const ok = await deps.confirm(
        `Reset ${state.stage === 'uat' ? 'UAT' : 'Review'}?`,
        'Starts a fresh recovery episode at round 1 and re-runs the stage. Existing evidence stays in history.',
      );
      if (!ok) return;
      resetGateStage(deps.store, deps.ticketId, { debug: deps.debug });
      deps.drive();
    } catch (e) {
      deps.logError('reset stage failed', e);
      deps.error(`Could not reset ticket ${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      deps.afterServerChange();
    }
  })();
}
