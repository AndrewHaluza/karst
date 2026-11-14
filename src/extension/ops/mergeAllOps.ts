import type { Store } from '../../store/db.js';
import {
  mergeAllPrs,
  type MergeAllDeps,
  type MergeAllItem,
  type MergeAllOutcome,
  type MergeAllPlan,
} from '../../workflow/mergePr.js';

/**
 * The host action "Merge all" — command logic behind the dashboard's `merge-all-prs` message (ops/ with a Notify
 * seam; `vscode`-free). `workflow/mergePr.ts` owns the merge sequence; this owns the one confirmation modal's wording
 * and the toasts. The modal is host-side (UI-R33): the webview sends no payload, so it cannot pick a PR or skip it.
 */

export interface MergeAllModal {
  readonly title: string;
  readonly detail: string;
  readonly confirm: string;
}

const plural = (n: number): string => `${n} pull request${n === 1 ? '' : 's'}`;

const label = (item: MergeAllItem): string => `${item.name}${item.number != null ? ` #${item.number}` : ''}`;

/** `<repo> #<n> → <base>`, the base left out when it is unknown. */
function line(item: MergeAllItem): string {
  return item.baseRef ? `${label(item)} → ${item.baseRef}` : label(item);
}

export function mergeAllModal(plan: MergeAllPlan): MergeAllModal {
  const parts = [plan.ready.map(line).join('\n')];
  if (plan.skipped.length > 0) parts.push(`Skipped (blocked): ${plan.skipped.map(label).join(', ')}`);
  parts.push('Each is squash-merged into its own base, one after another. If one fails, the rest stop and the failure is shown on its row.');
  return { title: `Merge ${plural(plan.ready.length)}?`, detail: parts.join('\n\n'), confirm: `Merge ${plan.ready.length}` };
}

export interface MergeAllOpsDeps {
  readonly store: Store;
  readonly ticketId: number;
  readonly repoOrder: () => readonly string[];
  readonly repoNameFor: (repo: string) => string | undefined;
  readonly now: () => string;
  readonly refresh: () => Promise<void>;
  readonly autofixRunning: () => boolean;
  /** Commits the ticket holds that its PRs lack (the undelivered tracker); absent = 0. */
  readonly unpushed?: () => number;
  /** Shows the modal; true on the confirm button, false on Cancel or dismiss. */
  /** Merges one repo's PR; defaults to `mergeTicketPr` (a seam for tests). */
  readonly merge?: MergeAllDeps['merge'];
  readonly askModal: (modal: MergeAllModal) => Promise<boolean>;
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
  readonly logError: (message: string, err: unknown) => void;
  readonly debug: (message: string) => void;
  /** Pushes the post-delivery status once, when the last merge finished the ticket. */
  readonly onTicketCompleted: () => Promise<void>;
  /** Settles the webview's pending state. Runs on EVERY exit. */
  readonly afterServerChange: () => void;
}

function report(outcome: MergeAllOutcome, d: MergeAllOpsDeps): void {
  if (outcome.kind === 'cancelled') return;
  if (outcome.kind === 'refused') {
    d.info(outcome.reason);
    return;
  }
  if (outcome.failed) {
    const done = outcome.merged.length > 0 ? ` ${plural(outcome.merged.length)} merged before it.` : '';
    d.error(`Merge failed for ${label(outcome.failed.item)}: ${outcome.failed.reason}${done} The rest were not merged.`);
    return;
  }
  d.info(
    outcome.completedTicket
      ? `Merged ${plural(outcome.merged.length)} — ticket done.`
      : `Merged ${plural(outcome.merged.length)}.`,
  );
}

export async function mergeAllOp(d: MergeAllOpsDeps): Promise<void> {
  try {
    const outcome = await mergeAllPrs(d.store, {
      ticketId: d.ticketId,
      repoOrder: d.repoOrder(),
      repoNameFor: d.repoNameFor,
      now: d.now,
      refresh: d.refresh,
      autofixRunning: d.autofixRunning,
      ...(d.unpushed ? { unpushed: d.unpushed } : {}),
      confirm: (plan) => d.askModal(mergeAllModal(plan)),
      debug: d.debug,
      ...(d.merge ? { merge: d.merge } : {}),
    });
    report(outcome, d);
    // `done` is reached where the work lands, so the provider status is pushed here, once.
    if (outcome.kind === 'done' && outcome.completedTicket) await d.onTicketCompleted();
  } catch (e) {
    d.logError('merge all failed', e);
    d.error(`Merge all failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    d.afterServerChange();
  }
}
