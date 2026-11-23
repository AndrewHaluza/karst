/**
 * The banner of a parked fix round (no-change way out). The fix agent found no code change was right
 * twice on the same heads, so the round waits for the user. Two exits: "Retry gate" runs the source
 * gate again, "Accept and continue" records the open items as accepted and passes the source gate.
 * The host builds `state.fixPark` (`workflow/fixParkExit.ts`); this view never derives it.
 */
import { memo, useCallback, useState } from 'react';
import type { FixParkView } from '../../../workflow/fixParkExit.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { beginPending, usePendingAction } from './usePendingAction.js';
import { MAX_FIX_PARK_NOTE_CHARS } from '../fixParkLimits.js';

/** The banner title of each trigger. */
export function fixParkTitle(view: FixParkView): string {
  switch (view.trigger) {
    case 'gate-failure':
      return `The ${view.sourceStage} gate still fails`;
    case 'blocking-review-findings':
      return 'Review findings stay open';
    case 'blocking-tester-observations':
      return 'Tester observations stay open';
    default:
      return 'The fix round is parked';
  }
}

/** The parked round, or null. */
export const selectFixPark = (snapshot: DashboardSnapshot): FixParkView | null => snapshot.state?.fixPark ?? null;

function AcceptForm({ stageKey, onCancel }: { readonly stageKey: string; readonly onCancel: () => void }) {
  const send = useDashboardSend();
  const [note, setNote] = useState('');
  const onConfirm = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>): void => {
      const requestId = beginPending(e);
      if (requestId !== null) send.fixParkedAccept(note.trim(), requestId);
    },
    [send, note],
  );
  return (
    <div className="fixpark-form k-field">
      <label htmlFor="fixpark-note">Note (optional)</label>
      <textarea
        id="fixpark-note"
        className="k-input"
        rows={3}
        maxLength={MAX_FIX_PARK_NOTE_CHARS}
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
        onInput={(e) => setNote(e.currentTarget.value)}
      />
      <div className="fixpark-actions">
        <button type="button" className="k-btn k-btn--primary k-btn--sm" data-act="fix-parked-accept-confirm" data-stagekey={stageKey} onClick={onConfirm}>
          Accept and continue
        </button>
        <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-act="fix-parked-accept-cancel" data-stagekey={stageKey} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ParkActions({ stageKey }: { readonly stageKey: string }) {
  const send = useDashboardSend();
  const [accepting, setAccepting] = useState(false);
  const onRetry = usePendingAction(useCallback((requestId: string) => send.fixParkedRetry(requestId), [send]));
  const onCancel = useCallback(() => setAccepting(false), []);
  if (accepting) return <AcceptForm stageKey={stageKey} onCancel={onCancel} />;
  return (
    <div className="fixpark-actions">
      <button type="button" className="k-btn k-btn--primary k-btn--sm" data-act="fix-parked-retry" data-stagekey={stageKey} title="Run the source gate again" onClick={onRetry}>
        Retry gate
      </button>
      <button
        type="button"
        className="k-btn k-btn--secondary k-btn--sm"
        data-act="fix-parked-accept"
        data-stagekey={stageKey}
        title="Record the open items as accepted and pass the source gate"
        onClick={() => setAccepting(true)}
      >
        Accept and continue
      </button>
    </div>
  );
}

export const FixParkBanner = memo(function FixParkBanner({ view }: { readonly view: FixParkView }) {
  return (
    <div className="fixpark" data-region="blocked-banner">
      <div className="fixpark-head">
        <span className="fdot" aria-hidden="true" />
        <span className="ftext">
          <span className="ftitle">{fixParkTitle(view)}</span>
          <span className="freason">{` · ${view.reason}`}</span>
        </span>
      </div>
      {view.items.length > 0 ? (
        <ul className="fixpark-items">
          {view.items.map((item, i) => (
            <li key={`${i}-${item}`}>{item}</li>
          ))}
        </ul>
      ) : null}
      <ParkActions stageKey={view.sourceStage} />
    </div>
  );
});
