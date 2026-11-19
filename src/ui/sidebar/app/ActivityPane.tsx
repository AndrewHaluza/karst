/**
 * The Activity pane: what Karst did and told the person, newest first, grouped by day. The host
 * sends the rows and the counts (`state.activity`); this view draws them. It sits after Tickets
 * and starts collapsed. Opening the pane marks nothing read: a click on a ticket row opens the
 * ticket's dashboard and marks that row read, and "Mark all read" marks every row.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAnchoredPopover } from '../../shared/useAnchoredPopover.js';
import { TicketRefChip } from '../../shared/TicketRefChip.js';
import { ticketRefView } from '../../shared/ticketRefView.js';
import type { ActivityRowView } from '../activity.js';
import { Icon, ToolbarGlyph } from './Icon.js';
import { Pane } from './Pane.js';
import { useSidebar } from './SidebarContext.js';
import {
  ACTIVITY_EMPTY_TEXT,
  ACTIVITY_LEVEL_WORD,
  ACTIVITY_NO_MATCH_TEXT,
  activityCount,
  groupByDay,
  matchesLevel,
  timeText,
  type ActivityLevelFilter,
} from './activityFormat.js';

const FUNNEL = ['M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227'];
const LEVEL_ICON: Readonly<Record<ActivityRowView['level'], string>> = {
  error: 'circle-x',
  warn: 'alert-triangle',
  success: 'circle-check',
  info: 'info-circle',
};
const CHOICES: ReadonlyArray<{ readonly id: ActivityLevelFilter; readonly label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'problems', label: 'Errors and warnings' },
];

function ActivityFilterMenu({ value, onChange }: { readonly value: ActivityLevelFilter; readonly onChange: (v: ActivityLevelFilter) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  useAnchoredPopover(open, pop, button, () => setOpen(false));
  const filtered = value !== 'all';

  useLayoutEffect(() => {
    if (!open) return;
    const items = wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    const checked = [...(items ?? [])].find((i) => i.getAttribute('aria-checked') === 'true');
    (checked ?? items?.[0])?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const at = items.indexOf(e.target as HTMLElement);
    const go = (i: number): void => items[(i + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') close(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
    e.stopPropagation();
  };
  const label = `Filter activity${filtered ? ': Errors and warnings' : ''}`;
  return (
    <span className="filter-menu" ref={wrap}>
      <button
        type="button"
        className="k-iconbtn"
        data-activity-filter-menu="1"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <ToolbarGlyph paths={FUNNEL} />
        {filtered ? <span className="filter-dot" data-activity-filter-dot="1" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="filter-pop" ref={pop} role="menu" aria-label="Activity filter" onKeyDown={onKeyDown}>
          {CHOICES.map((c) => (
            <button
              type="button"
              key={c.id}
              className="ctxitem"
              role="menuitemradio"
              aria-checked={value === c.id}
              data-activity-level={c.id}
              tabIndex={-1}
              onClick={() => {
                close(true);
                onChange(c.id);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

function rowLabel(row: ActivityRowView, time: string): string {
  const ref = row.ticketLabel ? `${row.ticketLabel}, ` : '';
  return `${ACTIVITY_LEVEL_WORD[row.level]}, ${ref}${row.title}, ${time}${row.unread ? ', unread' : ''}`;
}

function ActivityRow({ row }: { readonly row: ActivityRowView }) {
  const { post } = useSidebar();
  const time = timeText(row.createdAt);
  const label = rowLabel(row, time);
  const inner = (
    <>
      <span className={`a-lvl a-lvl--${row.level}`} aria-hidden="true"><Icon name={LEVEL_ICON[row.level]} size={14} /></span>
      {row.ticketId !== null ? (
        <span className="a-ref"><TicketRefChip refView={ticketRefView({ ticketId: row.ticketId })} link={false} showKey={false} /></span>
      ) : null}
      <span className="a-title" title={row.title} aria-label={row.title}>{row.title}</span>
      <span className="a-time">{time}</span>
    </>
  );
  return row.ticketId !== null ? (
    <button
      type="button"
      className="a-row a-row--open"
      data-activity-row={row.id}
      data-unread={row.unread}
      aria-label={label}
      title={label}
      onClick={() => post({ type: 'activity-open', id: row.id })}
    >
      {inner}
    </button>
  ) : (
    <div className="a-row" data-activity-row={row.id} data-unread={row.unread} role="group" aria-label={label} title={label}>
      {inner}
    </div>
  );
}

export function ActivityPane() {
  const { state, post, now, activityReveal } = useSidebar();
  const { rows, unread, total, hasMore } = state.activity;
  const [level, setLevel] = useState<ActivityLevelFilter>('all');
  // `karst.showActivity`: the context expanded the pane; scroll it into view once it is drawn.
  useEffect(() => {
    if (activityReveal > 0) document.querySelector('[data-pane="activity"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activityReveal]);
  const shown = rows.filter((r) => matchesLevel(r, level));
  const oldest = rows[rows.length - 1];
  return (
    <Pane
        pane="activity"
        title="Activity"
        count={activityCount(unread, total)}
        actions={
          <>
            {unread > 0 ? (
              <button
                type="button"
                className="k-iconbtn"
                data-activity-mark-all="1"
                aria-label="Mark all read"
                title="Mark all read"
                onClick={() => post({ type: 'activity-mark-all-read' })}
              >
                <Icon name="circle-check" />
              </button>
            ) : null}
            {rows.length ? <ActivityFilterMenu value={level} onChange={setLevel} /> : null}
          </>
        }
      >
        {!rows.length ? (
          <div className="pane-empty" data-region="activity">{ACTIVITY_EMPTY_TEXT}</div>
        ) : !shown.length ? (
          <div className="pane-empty" data-region="activity">{ACTIVITY_NO_MATCH_TEXT}</div>
        ) : (
          <div className="a-list" data-region="activity">
            {groupByDay(shown, now).map((g) => (
              <div key={g.label + g.rows[0]!.id} role="group" aria-label={g.label}>
                <div className="a-day">{g.label}</div>
                {g.rows.map((r) => <ActivityRow key={r.id} row={r} />)}
              </div>
            ))}
            {hasMore && oldest ? (
              <button type="button" className="k-btn k-btn--link a-more" data-activity-more="1" onClick={() => post({ type: 'activity-more', beforeId: oldest.id })}>
                Show more
              </button>
            ) : null}
          </div>
        )}
      </Pane>
  );
}
