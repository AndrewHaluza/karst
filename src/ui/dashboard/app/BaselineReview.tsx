/**
 * The blocked banner's baseline review surface (@arch:BASELINE-REVIEW). Rows are HOST-DERIVED (UI-R31): the
 * decision state, the image URIs and the entry indices all come from the snapshot, and every decision message
 * names only the block id and those indices. Approving lives HERE, never in the artifact (@arch:SHELF).
 *
 * What the user is doing in it is view state, not host state, and outlives a repaint: the chosen
 * Old | New | Difference tab, the one row whose reject form is open, and the reason drafts (typed text survives
 * closing the form and the 1 Hz pushes). The drafts live in `useBaselineDrafts`, owned by the always-mounted
 * banner, so they outlive this surface too.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { BaselineReviewRow } from '../baselineRows.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { beginPending, usePendingAction } from './usePendingAction.js';

const BLOCK_ID = 'baseline-review';
const STATE_WORD: Readonly<Record<string, string>> = { pending: '○ Needs review', approved: '✓ Approved', rejected: '✕ Rejected' };
const STATUS_WORD: Readonly<Record<string, string>> = { added: 'new file', modified: 'modified', deleted: 'deleted' };
const VIEW_WORD = { old: 'Old', new: 'New', diff: 'Difference' } as const;
type View = keyof typeof VIEW_WORD;

interface Row {
  readonly index: number;
  readonly status: string;
  readonly decision: string;
  readonly label: string;
  readonly reason: string;
  readonly oldSrc: string;
  readonly newSrc: string;
}

/** Index to an integer and the enums to their allowlists, so nothing but a known word and digits reaches the ids and attributes. */
const normalise = (r: BaselineReviewRow): Row => ({
  index: Number(r.index) | 0,
  status: Object.hasOwn(STATUS_WORD, r.status) ? r.status : 'modified',
  decision: Object.hasOwn(STATE_WORD, r.decision) ? r.decision : 'pending',
  label: String(r.label || ''),
  reason: String(r.reason || ''),
  oldSrc: r.oldSrc ? String(r.oldSrc) : '',
  newSrc: r.newSrc ? String(r.newSrc) : '',
});

export interface BaselineDrafts {
  readonly views: Readonly<Record<number, View>>;
  readonly setView: (index: number, view: View) => void;
  readonly rejectOpen: number | null;
  readonly openReject: (index: number) => void;
  readonly closeReject: () => void;
  readonly invalid: number | null;
  readonly setInvalid: (index: number | null) => void;
  /** What was typed, per entry index. The field is uncontrolled: this is read at click time, never rendered from. */
  readonly reasons: { readonly current: Record<number, string> };
}

export function useBaselineDrafts(): BaselineDrafts {
  const [views, setViews] = useState<Readonly<Record<number, View>>>({});
  const [rejectOpen, setRejectOpen] = useState<number | null>(null);
  const [invalid, setInvalid] = useState<number | null>(null);
  const reasons = useRef<Record<number, string>>({});
  const setView = useCallback((index: number, view: View) => setViews((v) => ({ ...v, [index]: view })), []);
  const openReject = useCallback((index: number) => {
    setRejectOpen(index);
    setInvalid(null);
  }, []);
  const closeReject = useCallback(() => {
    setRejectOpen(null);
    setInvalid(null);
  }, []);
  return { views, setView, rejectOpen, openReject, closeReject, invalid, setInvalid, reasons };
}

/** One side of a row's stage: an image, or the sentence that says why there is none. */
const Side = ({ src, alt, missing }: { readonly src: string; readonly alt: string; readonly missing: string }) =>
  src ? <img src={src} alt={alt} /> : <div className="blnote">{missing}</div>;

function Stage({ r, view }: { readonly r: Row; readonly view: View }) {
  if (view === 'old') return <Side src={r.oldSrc} alt={`Old ${r.label}`} missing="New file — there is no old image." />;
  if (view === 'new') return <Side src={r.newSrc} alt={`New ${r.label}`} missing="Deleted — there is no new image." />;
  // Difference: the two images stacked, `mix-blend-mode: difference` on the top one, so an unchanged pixel renders black.
  if (!r.oldSrc || !r.newSrc) return <div className="blnote">{`${r.oldSrc ? 'Deleted' : 'New file'} — nothing to compare.`}</div>;
  return (
    <>
      <div className="bldiff">
        <img src={r.oldSrc} alt={`Old ${r.label}`} />
        <img src={r.newSrc} alt={`Difference for ${r.label}`} />
      </div>
      <div className="blnote">Unchanged pixels are black.</div>
    </>
  );
}

function ApproveButton({ indices, all = false }: { readonly indices: readonly number[]; readonly all?: boolean }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.baselineApprove(BLOCK_ID, [...indices], requestId), [send, indices]));
  return (
    <button
      type="button"
      className={all ? 'k-btn k-btn--primary k-btn--sm bl-all' : 'k-btn k-btn--primary k-btn--sm'}
      data-act="baseline-approve"
      data-block-id={BLOCK_ID}
      data-indices={indices.join(',')}
      onClick={onClick}
    >
      {all ? 'Approve all' : 'Approve'}
    </button>
  );
}

function RejectForm({ r, drafts }: { readonly r: Row; readonly drafts: BaselineDrafts }) {
  const send = useDashboardSend();
  const field = useRef<HTMLTextAreaElement>(null);
  const invalid = drafts.invalid === r.index;
  // Opening the form puts the caret in the reason field.
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
    if (requestId !== null) send.baselineReject(BLOCK_ID, r.index, reason, requestId);
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
        <button type="button" className="k-btn k-btn--danger k-btn--sm" data-act="baseline-reject" data-block-id={BLOCK_ID} data-index={r.index} onClick={onSend}>
          Send rejection
        </button>
        <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-act="baseline-reject-cancel" onClick={drafts.closeReject}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BaselineRow({ r, drafts }: { readonly r: Row; readonly drafts: BaselineDrafts }) {
  const hasImage = !!(r.oldSrc || r.newSrc);
  const view = drafts.views[r.index] ?? (r.status === 'added' ? 'new' : 'diff');
  const rejectOpen = drafts.rejectOpen === r.index && r.decision !== 'rejected';
  const indices = [r.index];
  return (
    <section className="blrow" aria-label={`Baseline ${r.label}`}>
      <div className="blrow-top">
        <span className="bl-label">{r.label}</span>
        <span className="bl-status">{STATUS_WORD[r.status]}</span>
        <span className={`blstate ${r.decision}`}>{STATE_WORD[r.decision]}</span>
      </div>
      {r.decision === 'rejected' && r.reason ? <div className="blnote">{`Rejected: ${r.reason}`}</div> : null}
      {hasImage ? (
        <>
          <div className="blseg" role="group" aria-label={`Compare ${r.label}`}>
            {(['old', 'new', 'diff'] as const).map((v) => (
              <button key={v} type="button" data-act="baseline-view" data-index={r.index} data-view={v} aria-pressed={view === v} onClick={() => drafts.setView(r.index, v)}>
                {VIEW_WORD[v]}
              </button>
            ))}
          </div>
          <div className="blstage">
            <Stage r={r} view={view} />
          </div>
        </>
      ) : (
        <div className="blnote">No preview for this file type — open it from Source Control.</div>
      )}
      <div className="blactions">
        {r.decision === 'approved' ? null : <ApproveButton indices={indices} />}
        {rejectOpen ? null : (
          <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="baseline-reject-open" data-index={r.index} onClick={() => drafts.openReject(r.index)}>
            Reject…
          </button>
        )}
      </div>
      {rejectOpen ? <RejectForm r={r} drafts={drafts} /> : null}
    </section>
  );
}

export function BaselineReview({ entries, reason, drafts }: { readonly entries: readonly BaselineReviewRow[]; readonly reason: string; readonly drafts: BaselineDrafts }) {
  const rows = entries.map(normalise);
  const open = rows.filter((r) => r.decision !== 'approved').map((r) => r.index);
  return (
    <>
      <div className="ftitle">Review baselines</div>
      <div className="freason">{reason}</div>
      <div className="blhead">
        <span>{`${open.length} of ${rows.length} changed baseline${rows.length === 1 ? '' : 's'} need${open.length === 1 ? 's' : ''} your approval`}</span>
        {open.length > 0 ? <ApproveButton indices={open} all /> : null}
      </div>
      {rows.map((r) => (
        <BaselineRow key={r.index} r={r} drafts={drafts} />
      ))}
    </>
  );
}
