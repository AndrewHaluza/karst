import type { Store } from '../../store/db.js';
import { capForGate } from '../../workflow/fixAttempts.js';
import { prFeedbackFixState, enterPrFeedbackFix } from '../../workflow/prFeedbackFix.js';

/**
 * The host action "Address pull request feedback" — the command logic behind
 * the dashboard's `address-pr-feedback` message, extracted here per CLAUDE.md
 * ("command logic belongs in src/extension/ops/ with a Notify seam;
 * extension.ts handlers are bindings only").
 *
 * Lives under ops/ rather than in extension.ts because that file is line-capped
 * (ops/ratchet.test.ts) — and because every collaborator is injected, this is
 * unit-testable with fakes and no `vscode`. The module never imports `vscode`.
 */
export interface PrFeedbackActionDeps {
  readonly store: Store;
  readonly ticketId: number;
  /** Modal confirm. Resolves true only on the affirmative button. */
  readonly confirm: (detail: string) => Promise<boolean>;
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
  readonly logError: (message: string, err: unknown) => void;
  readonly debug: (message: string) => void;
  /**
   * Kick the driver after a successful mutation, so the resumed Fix session is
   * LAUNCHED. Without it the ticket rests at `fix` until some unrelated sweep
   * happens to drive it. Wired to the same host trigger `resumeStage` and
   * Unpause use.
   */
  readonly drive: () => void;
  /** Settles the webview's pending state. Must run on EVERY exit. */
  readonly afterServerChange: () => void;
}

/**
 * Derive availability (host-side, never trusting the webview), confirm with a
 * modal, then enter the recovery round. `enterPrFeedbackFix` re-derives
 * availability INSIDE its transaction, so a ticket a sweep or a teammate's
 * merge moved between the panel rendering and the click is refused rather than
 * mutated underneath its new state.
 */
export async function addressPrFeedback(deps: PrFeedbackActionDeps): Promise<void> {
  try {
    const state = prFeedbackFixState(deps.store, deps.ticketId);
    if (!state.available) {
      deps.info('There is no unresolved pull request feedback to address on this ticket.');
      return;
    }

    // The CAP is not on the derived state: read it from the same `capForGate`
    // call `enterPrFeedbackFix` passes as `maxRounds`, so the modal and the
    // round cannot quote different caps. N and the item count come from the
    // state already derived above.
    const cap = capForGate('ship');
    const confirmed = await deps.confirm(
      'This moves the ticket to Fix, and UAT and Review will run again. ' +
        'The existing pull requests stay open — they are neither merged nor closed — ' +
        'and karst will not reply to or resolve the review conversations. ' +
        `This is round ${state.round} of ${cap}.`,
    );
    if (!confirmed) return;

    const result = enterPrFeedbackFix(deps.store, deps.ticketId, { debug: deps.debug });
    // The ticket now sits at `fix` with a pending round; drive it so the
    // configured Fix session is launched (or nudged) without waiting for an
    // unrelated sweep.
    deps.drive();
    deps.info(
      `Addressing pull request feedback — round ${result.round}, ${result.items} item(s).`,
    );
  } catch (err) {
    deps.logError('karst: address pull request feedback failed', err);
    deps.error(err instanceof Error ? err.message : String(err));
  } finally {
    // Confirm, dismiss, refusal or throw: the webview's pending state is settled
    // by a state push — the same contract `sendBackToImplement` documents.
    deps.afterServerChange();
  }
}
