import type { MouseEvent, ReactNode } from 'react';
import { ticketRefView, type TicketRefView } from './ticketRefView.js';

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
 * Coerce the runtime value to a view. A restored pre-upgrade snapshot stored
 * blockers as plain strings, and `in` throws on a primitive, so guard the type
 * before probing it (a snapshot must never crash a render).
 */
function toRefView(raw: TicketRefChipProps['refView']): TicketRefView | null {
  if (typeof raw === 'string') return ticketRefView({ ref: raw });
  if (typeof raw !== 'object' || raw === null) return null;
  return 'displayTextParts' in raw ? raw : ticketRefView(raw);
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
  const cls = `k-ticket-ref${className ? ` ${className}` : ''}`;
  const dot = <span className={`k-ticket-ref-dot g-${refView.glyph}`} aria-hidden="true" />;
  const keyPart = showKey && refView.displayTextParts.key ? ` · ${refView.displayTextParts.key}` : '';
  const stagePart = refView.displayTextParts.stage ? ` · ${refView.displayTextParts.stage}` : '';
  const idText = refView.displayTextParts.id;

  // Whole-chip link: the planning draft dependency reveals its draft card. Only
  // an explicit `linkTarget="chip"` takes this path, so a plain row chip can
  // never become a nested button (@ui:UI-R09). A plain chip stays text.
  if (isLink && linkTarget === 'chip' && (refView.ticketId !== null || refView.draftId != null)) {
    const draftOnly = refView.draftId != null && refView.ticketId === null;
    const dataProps = draftOnly
      ? { 'data-dep-draft': Number(refView.draftId) }
      : { 'data-act': dataAct, 'data-id': Number(refView.ticketId) };
    return (
      <button type="button" className={cls} tabIndex={-1} aria-label={refView.accessibleName} title={tooltip} onClick={onClick} {...dataProps}>
        {prefix ? <span>{prefix}</span> : null}
        {dot}
        <span>{`${idText}${keyPart}${stagePart}`}</span>
      </button>
    );
  }

  // Inline link: the id part opens the ticket; the rest is text inside the
  // caller's click target (@ui:UI-R09c).
  let idNode: ReactNode = idText;
  if (isLink && refView.ticketId !== null) {
    const linkProps = {
      href: '#',
      'data-act': dataAct,
      ...(dataIdAttr === 'data-id'
        ? { 'data-id': refView.ticketId }
        : { 'data-ticket': refView.ticketId }),
      onClick,
    };
    idNode = <a {...linkProps}>{idText}</a>;
  }

  return (
    <span className={cls} aria-label={refView.accessibleName} title={tooltip}>
      {prefix ? <span>{prefix}</span> : null}
      {dot}
      <span>
        {idNode}
        {keyPart}
        {stagePart}
      </span>
    </span>
  );
}
