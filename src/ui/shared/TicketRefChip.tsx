import type { MouseEvent, ReactNode } from 'react';
import { ticketRefView, type TicketRefView } from './ticketRefView.js';

export interface TicketRefChipProps {
  readonly refView: TicketRefView;
  /** Selects link vs plain text. Default true. */
  readonly link?: boolean;
  readonly as?: 'link' | 'text';
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
 * Shared reference chip component for tickets, drafts and dangling references.
 * Used by Sidebar row, Dashboard header (BlockerChip), and Planning draft (DepChip).
 */
export function TicketRefChip({
  refView: rawRefView,
  link = true,
  as,
  prefix = '',
  showKey = true,
  onClick,
  dataIdAttr = 'data-ticket',
  dataAct = 'open-dependency',
  className,
}: TicketRefChipProps) {
  const refView = 'displayTextParts' in rawRefView ? rawRefView : ticketRefView(rawRefView);
  const isPlain = as === 'text' || link === false;
  const isLink = !isPlain;
  const tooltip = !showKey && refView.keyOrRef ? refView.keyOrRef : undefined;

  // Planning draft chip: entire chip is an interactive button / link (as it was before).
  if (refView.draftId != null) {
    const dot = <span className={`k-ticket-ref-dot g-${refView.glyph}`} aria-hidden="true" />;
    const stage = refView.stage ? ` · ${refView.stage}` : '';
    const label = `${refView.displayTextParts.id}${stage}`;
    const cls = `k-ticket-ref${className ? ` ${className}` : ''}`;

    if (refView.kind === 'draft') {
      return (
        <button
          type="button"
          className={cls}
          tabIndex={-1}
          data-dep-draft={Number(refView.draftId)}
          aria-label={refView.accessibleName}
          onClick={onClick}
        >
          {dot}
          <span>{refView.displayTextParts.id}</span>
        </button>
      );
    }

    return (
      <button
        type="button"
        className={cls}
        tabIndex={-1}
        data-act="open-dashboard"
        data-id={Number(refView.ticketId)}
        aria-label={refView.accessibleName}
        onClick={onClick}
      >
        {dot}
        <span>{label}</span>
      </button>
    );
  }

  // Dashboard header, sidebar row, and ticket form reference chips:
  const idText = refView.displayTextParts.id;
  const dot = <span className={`k-ticket-ref-dot g-${refView.glyph}`} aria-hidden="true" />;
  const keyPart = showKey && refView.displayTextParts.key ? ` · ${refView.displayTextParts.key}` : null;
  const stagePart = refView.displayTextParts.stage ? ` · ${refView.displayTextParts.stage}` : null;

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

  const cls = `k-ticket-ref${className ? ` ${className}` : ''}`;
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
