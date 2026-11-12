import type { MouseEvent } from 'react';
import type { Glyph } from '../../model/glyph.js';
import { chipClass, refChipParts, ticketRefView, type RefChipParts, type TicketRefView } from './ticketRefView.js';

export interface TicketRefChipProps {
  /**
   * The shared view. The prop is typed to the view but a restored pre-upgrade
   * sidebar snapshot can still hold the old string label, so a string (and a
   * nullish value) is accepted defensively.
   */
  readonly refView: TicketRefView | string | null | undefined;
  /** Selects link vs plain text. Default true. */
  readonly link?: boolean;
  /**
   * Where the link lives. `id` (default) links only the id, so the chip can sit
   * inside a row's click target; `chip` makes the whole chip the control, as the
   * planning draft dependency needs (it reveals the draft card).
   */
  readonly linkTarget?: 'id' | 'chip';
  /** Leading text, e.g. 'Blocked by ' on the sidebar row and dashboard header. */
  readonly prefix?: string;
  /** Whether to show the key part in the visible text (defaults to true; sidebar row passes false to keep key in tooltip). */
  readonly showKey?: boolean;
  /** Optional custom click handler. */
  readonly onClick?: (e: MouseEvent<HTMLElement>) => void;
  /** Data attribute for ticket id on the link: 'data-ticket' (default) or 'data-id'. */
  readonly dataIdAttr?: 'data-ticket' | 'data-id';
  /** Data action on the link: 'open-dependency' (default). */
  readonly dataAct?: string;
  /** Optional class name to append. */
  readonly className?: string;
}

/**
 * A planning dependency persisted by the pre-upgrade build: `{ id, label, kind,
 * ticketId, ticketLabel, stage, glyph }`. The old chip read the draft id from
 * `label`; passing the object to `ticketRefView` as an input would render the
 * bare ticket label (wrong id) and lose the draft action, so rebuild the view
 * from the fields it carries.
 */
function legacyDepView(raw: Record<string, unknown>): TicketRefView | null {
  if (typeof raw.id !== 'number' || typeof raw.label !== 'string' || !('kind' in raw)) return null;
  const draftId = raw.id;
  const draftLabel = raw.label;
  if (typeof raw.ticketId !== 'number') return ticketRefView({ draftId, draftLabel });
  const ticketLabel = typeof raw.ticketLabel === 'string' ? raw.ticketLabel : null;
  const glyph = typeof raw.glyph === 'string' ? (raw.glyph as Glyph) : null;
  let stage = typeof raw.stage === 'string' ? raw.stage : null;
  // A `done` dep stored no stage; its dot carried the finished colour.
  if (raw.kind === 'done') stage = glyph === 'gray' ? 'closed' : 'done';
  const accessibleName = stage && (stage === 'done' || stage === 'closed')
    ? `${draftLabel}, ticket ${ticketLabel ?? raw.ticketId} ${stage}`
    : `${draftLabel}, ticket ${ticketLabel ?? raw.ticketId} in ${stage || 'progress'}`;
  const sessionLabel = typeof raw.sessionLabel === 'string' ? raw.sessionLabel : null;
  return ticketRefView({ ticketId: raw.ticketId, draftId, draftLabel, idLabel: ticketLabel, stage, glyph, accessibleName, sessionLabel });
}

/**
 * Coerce the runtime value to a view. A restored pre-upgrade snapshot stored
 * blockers as plain strings, and `in` throws on a primitive, so guard the type
 * before probing it (a snapshot must never crash a render).
 */
function toRefView(raw: TicketRefChipProps['refView']): TicketRefView | null {
  if (typeof raw === 'string') return ticketRefView({ ref: raw });
  if (typeof raw !== 'object' || raw === null) return null;
  if ('displayTextParts' in raw) return raw;
  return legacyDepView(raw) ?? ticketRefView(raw);
}

/**
 * Shared reference chip component for tickets, drafts and dangling references.
 * Used by Sidebar row, Dashboard header (BlockerChip), and Planning draft (DepChip).
 */
export function TicketRefChip({
  refView: rawRefView,
  link = true,
  linkTarget = 'id',
  prefix = '',
  showKey = true,
  onClick,
  dataIdAttr = 'data-ticket',
  dataAct = 'open-dependency',
  className,
}: TicketRefChipProps) {
  const refView = toRefView(rawRefView);
  if (!refView) return null;
  const isLink = link;
  const tooltip = !showKey && refView.keyOrRef ? refView.keyOrRef : undefined;
  const parts = refChipParts(refView);
  const cls = chipClass(parts, className);
  const name = refView.accessibleName;
  const idText = refView.displayTextParts.id;
  const key = showKey ? refView.displayTextParts.key : null;
  const session = refView.displayTextParts.session;
  const prefixNode = prefix ? <span className="k-ticket-ref-prefix">{prefix}</span> : null;
  const pause = parts.state === 'needs' ? <PauseMark /> : null;
  // `tail` is the part after the id: key, the stage word (one span, the host
  // width picks full or short in CSS, @ui:UI-R51) and the cross-session label.
  const tail = (
    <>
      {key ? <span className="k-ticket-ref-x">{` · ${key}`}</span> : null}
      <StageWord parts={parts} />
      {session ? <span className="k-ticket-ref-x">{` · ${session}`}</span> : null}
    </>
  );

  // Whole-chip link: the planning draft dependency reveals its draft card. Only
  // an explicit `linkTarget="chip"` takes this path, so a plain row chip can
  // never become a nested button (@ui:UI-R09). A plain chip stays text.
  if (isLink && linkTarget === 'chip' && (refView.ticketId !== null || refView.draftId != null)) {
    const draftOnly = refView.draftId != null && refView.ticketId === null;
    const dataProps = draftOnly
      ? { 'data-dep-draft': Number(refView.draftId) }
      : { 'data-act': dataAct, 'data-id': Number(refView.ticketId) };
    return (
      <button type="button" className={cls} tabIndex={-1} {...dataProps} aria-label={name} title={tooltip} onClick={onClick}>
        {prefixNode}
        {pause}
        <span className="k-ticket-ref-id">{idText}</span>
        {tail}
      </button>
    );
  }

  // Inline link: the id part opens the ticket and carries the accessible name;
  // the rest is text inside the caller's click target (@ui:UI-R09c).
  const linked = isLink && refView.ticketId !== null;
  const linkProps = {
    href: '#',
    'data-act': dataAct,
    ...(dataIdAttr === 'data-id' ? { 'data-id': refView.ticketId } : { 'data-ticket': refView.ticketId }),
    'aria-label': name,
    onClick,
  };
  return (
    <span className={cls} aria-label={linked ? undefined : name} title={tooltip}>
      {prefixNode}
      {pause}
      {linked ? <a {...linkProps}>{idText}</a> : <span className="k-ticket-ref-id">{idText}</span>}
      {tail}
    </span>
  );
}

function PauseMark() {
  return (
    <svg className="k-ticket-ref-pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="5" y="3" width="5" height="18" rx="1" />
      <rect x="14" y="3" width="5" height="18" rx="1" />
    </svg>
  );
}

function StageWord({ parts }: { readonly parts: RefChipParts }) {
  if (!parts.full) return null;
  return <span className="k-ticket-ref-word" data-full={parts.full} data-short={parts.short} aria-hidden="true" />;
}
