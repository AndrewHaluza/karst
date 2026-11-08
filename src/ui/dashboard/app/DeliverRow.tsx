/**
 * "Deliver to PR": the count line and its action, Ship only, hidden while nothing is undelivered. The host syncs the
 * sandbox and pushes, reports through notifications, then sends a state push; the request carries no id on the wire,
 * so it is held in `pendingOps.ts` and settles on that push (a second click cannot start a second delivery).
 *
 * T1018: the same row carries the auto-deliver of a resolved merge — one progress line (`deliver-progress`), the
 * takeover line, and the gate failures kept on record (`deliver-gate-failures`), grouped by the head where they failed.
 * The host supplies the facts; this component only words them (UI-R31). The row is the live region (UI-R27): a change
 * of the progress line is announced. The button stays enabled during an auto-deliver; its title is the hint.
 */
import { useCallback, type MouseEvent } from 'react';
import { useDashboardSend, useOps, useOverlays, usePendingOps } from './DashboardAppContext.js';
import { beginPending } from './usePendingAction.js';
import {
  deliverFailureLine, deliverHint, deliverProgressLine, deliverTakeOverLine, groupFailuresByHead, shortSha,
  type DeliverFacts,
} from '../../../model/inside/deliver.js';
import './Deliver.css';

const DEFAULT_TITLE = 'Sync the sandbox, then push the branch onto the open pull request';

export function DeliverRow({ notOnPr, inSandbox, canDeliver, auto }: {
  readonly notOnPr: number;
  readonly inSandbox: number;
  /** The host found commits to push; false when only the auto-deliver record is shown. */
  readonly canDeliver: boolean;
  readonly auto: DeliverFacts | null;
}) {
  const send = useDashboardSend();
  const overlays = useOverlays();
  const ops = usePendingOps();
  const busy = useOps().running.has('deliver');
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (ops.isRunning('deliver')) return;
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginAction('deliver', requestId);
      send.deliverToPr();
    },
    [ops, send],
  );
  const progress = auto ? deliverProgressLine(auto) : null;
  const takenOver = auto?.takenOver ? deliverTakeOverLine(auto.takenOver) : null;
  const groups = auto ? groupFailuresByHead(auto.failures) : [];
  return (
    <div className="inside-deliver" role="status">
      {canDeliver ? (
        <span>{`${notOnPr} commit${notOnPr === 1 ? '' : 's'} not on the PR${inSandbox > 0 ? ` (${inSandbox} still in the sandbox)` : ''}`}</span>
      ) : null}
      {canDeliver ? (
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          data-act="deliver-to-pr"
          aria-busy={busy ? 'true' : undefined}
          disabled={busy}
          title={(auto ? deliverHint(auto) : null) ?? DEFAULT_TITLE}
          onClick={onClick}
        >
          Deliver to PR
        </button>
      ) : null}
      {auto ? (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--sm"
          data-act="console"
          onClick={() => overlays.openConsole('ship', null)}
        >
          Gate output
        </button>
      ) : null}
      {progress || takenOver ? (
        <p className="deliver-progress" data-region="deliver-progress">{progress ?? takenOver}</p>
      ) : null}
      {groups.length > 0 && auto ? (
        <div className="deliver-gate-failures" data-region="deliver-gate-failures">
          {groups.map((g) => (
            <section key={g.headSha ?? 'none'} className="deliver-failure-group">
              <h4 className="deliver-failure-head">
                {g.headSha !== null && g.headSha === auto.headSha ? `On the current head ${shortSha(g.headSha)}` : `On an older head ${shortSha(g.headSha)}`}
              </h4>
              <ul>
                {g.items.map((f) => (
                  <li key={`${f.repo}:${f.gate}`}>
                    <span className="deliver-failure-line">{deliverFailureLine(f)}</span>
                    {f.summary ? <span className="deliver-failure-summary">{f.summary}</span> : null}
                    <button
                      type="button"
                      className="k-btn k-btn--ghost k-btn--sm"
                      data-act="dismiss-deliver-failures"
                      aria-label={`Dismiss the failure of gate ${f.gate}`}
                      onClick={() => send.dismissDeliverFailures(f.gate)}
                    >
                      Dismiss
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
