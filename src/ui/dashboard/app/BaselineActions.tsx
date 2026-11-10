/**
 * The review overlay's sticky action bar (@arch:BASELINE-REVIEW): Prev / Next with "i / n", Reject, "Approve <k> themes"
 * when the screenshot has more than one pending theme, and Approve. Reject opens its reason form in this bar, for the
 * selected entry. Every decision message names only the block id and entry indices (`baseline-approve` takes an index
 * list, `baseline-reject` one index and the reason). Approve moves the selection to the next pending entry.
 */
import { useCallback, useEffect, useRef, type MouseEvent } from 'react';
import { BASELINE_BLOCK_ID } from './BaselineBanner.js';
import type { BaselineDrafts } from './baselineDrafts.js';
import { nextOpen, stepFrom, type Row } from './baselineGroups.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { beginPending, usePendingAction } from './usePendingAction.js';
import type { BaselineModel } from './useBaselineModel.js';

/** Approve the given entries, and move the selection on to the next pending entry that is not among them. */
export function useApprove(model: BaselineModel, drafts: BaselineDrafts) {
  const send = useDashboardSend();
  const from = model.selected?.index ?? -1;
  return useCallback(
    (indices: readonly number[], requestId: string): void => {
      const next = nextOpen(model.visible, from, new Set(indices));
      if (next !== null) drafts.select(next);
      send.baselineApprove(BASELINE_BLOCK_ID, [...indices], requestId);
    },
    [send, drafts, model.visible, from],
  );
}

export function ApproveButton({ indices, label, primary, approve }: { readonly indices: readonly number[]; readonly label: string; readonly primary: boolean; readonly approve: ReturnType<typeof useApprove> }) {
  const onClick = usePendingAction(useCallback((requestId: string) => approve(indices, requestId), [approve, indices]));
  return (
    <button
      type="button"
      className={primary ? 'k-btn k-btn--primary k-btn--sm' : 'k-btn k-btn--secondary k-btn--sm'}
      data-act="baseline-approve"
      data-role={primary ? 'approve' : undefined}
      data-block-id={BASELINE_BLOCK_ID}
      data-indices={indices.join(',')}
      onClick={onClick}
    >
      <Icon name="check" size={14} /> {label}
    </button>
  );
}

function RejectForm({ r, drafts }: { readonly r: Row; readonly drafts: BaselineDrafts }) {
  const send = useDashboardSend();
  const field = useRef<HTMLTextAreaElement>(null);
  const invalid = drafts.invalid === r.index;
  useEffect(() => {
    field.current?.focus();
  }, []);
  // A rejection needs the user's reason (the fix agent reads it): an empty one is refused locally, before any
  // pending state or host message, and the field is named.
  const onSend = (e: MouseEvent<HTMLButtonElement>): void => {
    const reason = (drafts.reasons.current[r.index] ?? '').trim();
    if (!reason) {
      drafts.setInvalid(r.index);
      field.current?.focus();
      return;
    }
    const requestId = beginPending(e);
    if (requestId !== null) send.baselineReject(BASELINE_BLOCK_ID, r.index, reason, requestId);
  };
  return (
    <div className="blreject k-field">
      <label htmlFor={`blreason-${r.index}`}>Why is this wrong? The fix agent reads this.</label>
      <textarea
        ref={field}
        className="k-input"
        id={`blreason-${r.index}`}
        rows={3}
        data-bl-reason={r.index}
        required
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={invalid ? `blreason-err-${r.index}` : undefined}
        defaultValue={drafts.reasons.current[r.index] ?? ''}
        onInput={(e) => {
          drafts.reasons.current[r.index] = e.currentTarget.value;
        }}
      />
      {invalid ? (
        <div className="k-field-error" id={`blreason-err-${r.index}`} role="alert">
          A reason is required.
        </div>
      ) : null}
      <div className="blactions">
        <button type="button" className="k-btn k-btn--danger k-btn--sm" data-act="baseline-reject" data-block-id={BASELINE_BLOCK_ID} data-index={r.index} onClick={onSend}>
          Send rejection
        </button>
        <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-act="baseline-reject-cancel" onClick={drafts.closeReject}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function BaselineActions({ model, row, drafts, approve }: { readonly model: BaselineModel; readonly row: Row; readonly drafts: BaselineDrafts; readonly approve: ReturnType<typeof useApprove> }) {
  const rejectOpen = drafts.rejectOpen === row.index && row.decision !== 'rejected';
  const prev = stepFrom(model.visible, row.index, -1);
  const next = stepFrom(model.visible, row.index, 1);
  return (
    <div className="blact" data-region="baseline-actions">
      {rejectOpen ? <RejectForm key={row.index} r={row} drafts={drafts} /> : null}
      <div className="blactrow">
        <div className="blnav">
          <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-act="baseline-prev" disabled={prev === null || prev === row.index} onClick={() => prev !== null && drafts.select(prev)}>
            <Icon name="chevron-left" size={14} /> Prev
          </button>
          <span className="blpos" aria-live="polite">{`${model.position} / ${model.visible.length}`}</span>
          <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-act="baseline-next" disabled={next === null || next === row.index} onClick={() => next !== null && drafts.select(next)}>
            Next <Icon name="chevron-right" size={14} />
          </button>
        </div>
        <div className="blactions">
          {rejectOpen || row.decision === 'rejected' ? null : (
            <button type="button" className="k-btn k-btn--danger k-btn--sm" data-act="baseline-reject-open" data-index={row.index} onClick={() => drafts.openReject(row.index)}>
              <Icon name="x" size={14} /> Reject
            </button>
          )}
          {model.groupPending.length > 1 ? <ApproveButton indices={model.groupPending.map((r) => r.index)} label={`Approve ${model.groupPending.length} themes`} primary={false} approve={approve} /> : null}
          {row.decision === 'approved' ? null : <ApproveButton indices={[row.index]} label="Approve" primary approve={approve} />}
        </div>
      </div>
    </div>
  );
}
