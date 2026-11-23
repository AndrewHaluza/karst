/**
 * The Activity pane: what Karst did and told the person, newest first, grouped by day. The host
 * sends the rows and the counts (`state.activity`); this view draws them. It sits after Tickets
 * and starts collapsed. Opening the pane marks nothing read: a click on a ticket row opens the
 * ticket's dashboard and marks that row read, and "Mark all read" marks every row.
 *
 * The level filter is view state (SB-9), like the Queue filters, and narrows the drawn rows
 * only. The ticket reference is plain text: the row's button already opens the dashboard (SB-17).
 */
import { useEffect } from 'react';
import type { ActivityRowView } from '../activity.js';
import { Icon } from './Icon.js';
import { FilterMenu } from './FilterMenu.js';
import { Pane } from './Pane.js';
import { PaneEmpty } from './PaneEmpty.js';
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
      {row.ticketLabel ? <span className="a-ref">{row.ticketLabel}</span> : null}
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
  const { state, post, now, activityReveal, view, setActivityLevel } = useSidebar();
  const { rows, unread, total, hasMore } = state.activity;
  const level = view.activityLevel;
  // `karst.showActivity`: the context expanded the pane; scroll it into view once it is drawn.
  useEffect(() => {
    if (activityReveal > 0) document.querySelector('[data-pane="activity"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activityReveal]);
  const shown = rows.filter((r) => matchesLevel(r, level));
  const oldest = rows[rows.length - 1];
  const count = level === 'all' ? activityCount(unread, total) : `${shown.length} / ${rows.length}`;
  return (
    <Pane
        pane="activity"
        title="Activity"
        count={count}
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
                <Icon name="checks" />
              </button>
            ) : null}
            {rows.length ? (
              <FilterMenu
                options={CHOICES}
                value={level === 'all' ? null : level}
                filtered={level !== 'all'}
                onChange={(id) => setActivityLevel(id as ActivityLevelFilter)}
                label="Filter activity"
                menuLabel="Activity filter"
                triggerAttr="data-activity-filter-menu"
                optionAttr="data-activity-level"
                dotAttr="data-activity-filter-dot"
              />
            ) : null}
          </>
        }
      >
        {!rows.length ? (
          <PaneEmpty title={ACTIVITY_EMPTY_TEXT} region="activity" />
        ) : !shown.length ? (
          <PaneEmpty title={ACTIVITY_NO_MATCH_TEXT} region="activity" />
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
