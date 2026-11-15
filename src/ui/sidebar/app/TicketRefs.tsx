/**
 * The "Waits on" line of a ticket row: one chip, and a `+N` button when more
 * references exist. It is a SIBLING of the row's click target, never inside it,
 * so the button never nests in another button (@ui:UI-R09). The other chips open
 * in a list in the row's flow, not a flyout: the panes scroll and would clip one.
 * Escape closes the list and returns focus; an outside click or focus leaving the
 * row closes it too.
 */
import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import type { TicketRefView } from '../../shared/ticketRefView.js';
import { TicketRefChip } from '../../shared/TicketRefChip.js';
import { useSidebar } from './SidebarContext.js';

export const WAITS_ON = 'Waits on';

function RefChip({ refView }: { readonly refView: TicketRefView }) {
  const { fire } = useSidebar();
  const ticketId = refView.ticketId;
  return (
    <TicketRefChip
      refView={refView}
      link={ticketId !== null}
      showKey={false}
      dataAct="open-dashboard"
      onClick={(e) => {
        e.preventDefault();
        if (ticketId !== null) fire({ act: 'open-dashboard', id: Number(ticketId) }, e.currentTarget, e);
      }}
    />
  );
}

export interface TicketRefsProps {
  readonly refs: readonly TicketRefView[];
  /** The verb before the first chip; the Queue pane also says 'Unblocks' and 'Cycle with'. */
  readonly verb?: string;
  /** Extra class on the root: the Queue pane styles its rows with it. */
  readonly className?: string;
  /** Content before the verb, e.g. the cycle icon. */
  readonly lead?: ReactNode;
}

export function TicketRefs({ refs, verb = WAITS_ON, className, lead }: TicketRefsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const first = refs[0];
  if (!first) return null;
  const rest = refs.slice(1);
  const onKeyDown = (e: { key: string; stopPropagation: () => void }) => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    setOpen(false);
    moreRef.current?.focus();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (open && !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOpen(false);
  };
  return (
    <div ref={rootRef} className={className ? `refs ${className}` : 'refs'} onKeyDown={onKeyDown} onBlur={onBlur}>
      <div className="refs-line">
        {lead}
        <span className="refs-verb">{verb}</span>
        <RefChip refView={first} />
        {rest.length ? (
          <button
            ref={moreRef}
            type="button"
            className="refs-more"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={`${rest.length} more ${verb.toLowerCase()}`}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="refs-more-pill">+{rest.length}</span>
          </button>
        ) : null}
      </div>
      {rest.length ? (
        <ul id={listId} className="refs-list" hidden={!open}>
          {rest.map((r, i) => (
            <li key={r.ticketId ?? r.keyOrRef ?? i}><RefChip refView={r} /></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
