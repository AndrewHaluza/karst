/**
 * The scrolling list — the one thing that scrolls (UI-R38). Which shape it takes
 * follows the facet selection:
 *
 * - All: Current / Awaiting review / Recently done, and Older Completed behind
 *   a disclosure. Empty sections are omitted entirely.
 * - Done: every completed ticket at once, newest first, no hierarchy.
 * - Anything else (Archived, derived-status unions): the flat filtered list.
 *
 * Planning sessions are not here: they have their own pane.
 */
import type { ReactNode } from 'react';
import type { TicketRow as Row } from '../state.js';
import { ActButton } from './action.js';
import { CloudSessionRows } from './CloudSessions.js';
import { visibleRows } from './format.js';
import { Icon } from './Icon.js';
import { useSidebar } from './SidebarContext.js';
import { TicketRow } from './TicketRow.js';

/** Lightweight section header: "CURRENT · 7". The count is what is rendered BELOW it. */
function Section({ name, count }: { readonly name: string; readonly count: number }) {
  return (
    <div className="sec" role="presentation">
      <span className="sec-name">{name}</span>
      <span className="sec-n">· {count}</span>
    </div>
  );
}

function Empty({ view }: { readonly view: 'all' | 'archived' | 'done' }) {
  const { state } = useSidebar();
  if (state.filter) return <div className="k-empty"><div className="k-empty-title">No tickets match</div></div>;
  if (view === 'archived') return <div className="k-empty"><div className="k-empty-title">No archived tickets</div></div>;
  if (view === 'done') return <div className="k-empty"><div className="k-empty-title">No done tickets</div></div>;
  return (
    <div className="k-empty">
      <div className="k-empty-title">No tickets yet</div>
      <div className="k-empty-hint">
        <ActButton spec={{ act: 'create' }} className="k-btn k-btn--link">Create ticket</ActButton>
      </div>
    </div>
  );
}

/**
 * The Older Completed disclosure. The whole row is the button (UI-R09); its
 * chevron rotates when open. `aria-controls` names the list only while it exists.
 */
function HistoryToggle({ expanded, count }: { readonly expanded: boolean; readonly count: number }) {
  const { toggleHist } = useSidebar();
  return (
    <button
      type="button"
      className="k-btn k-btn--ghost hist"
      data-history="1"
      aria-expanded={expanded}
      aria-controls={expanded ? 'histlist' : undefined}
      onClick={toggleHist}
    >
      <span className="hist-chev"><Icon name="chevron-right" size={12} /></span>
      <span>{count} more completed</span>
    </button>
  );
}

function Rows({ rows, compact = false, time = false, older = false }: { readonly rows: readonly Row[]; readonly compact?: boolean; readonly time?: boolean; readonly older?: boolean }): ReactNode {
  return rows.map((r) => <TicketRow key={r.ticketId} row={r} compact={compact} time={time} older={older} />);
}

function AllView() {
  const { state, collapsedSubtrees: c, hist } = useSidebar();
  const secs = state.sections;
  const current = visibleRows((secs && secs.current) || state.rows || [], c);
  const awaiting = visibleRows((secs && secs.awaitingReview) || [], c);
  const recent = visibleRows((secs && secs.recentlyDone) || [], c);
  const older = visibleRows((secs && secs.olderDone) || [], c);
  const cloud = state.unlinkedCloudSessions || [];
  if (!current.length && !awaiting.length && !recent.length && !older.length && !cloud.length) return <Empty view="all" />;
  const query = (state.filter || '').trim();
  // Auto-reveal: a query that matches Older Completed expands the section so the
  // match is visible, but that is NOT the user's explicit choice — clearing the
  // search restores the default collapsed state.
  const expanded = hist.user ? hist.open : query !== '' && older.length > 0;
  return (
    <>
      {current.length ? <><Section name="Current" count={current.length} /><Rows rows={current} /></> : null}
      {cloud.length ? <><Section name="Cloud sessions" count={cloud.length} /><CloudSessionRows sessions={cloud} /></> : null}
      {awaiting.length ? <><Section name="Awaiting review" count={awaiting.length} /><Rows rows={awaiting} /></> : null}
      {recent.length ? <><Section name="Recently done" count={recent.length} /><Rows rows={recent} compact time /></> : null}
      {older.length ? (
        <>
          <HistoryToggle expanded={expanded} count={older.length} />
          {expanded ? <div className="histlist" id="histlist"><Rows rows={older} compact older /></div> : null}
        </>
      ) : null}
    </>
  );
}

function DoneView() {
  const { state } = useSidebar();
  const rows = state.done || [];
  if (!rows.length) return <Empty view="done" />;
  return <><Section name="Done" count={rows.length} /><Rows rows={rows} compact time /></>;
}

function FlatView() {
  const { state, collapsedSubtrees } = useSidebar();
  const rows = visibleRows(state.rows || [], collapsedSubtrees);
  if (!rows.length) return <Empty view={(state.facets || []).includes('archived') ? 'archived' : 'all'} />;
  return <Rows rows={rows} />;
}

export function TicketList() {
  const { state } = useSidebar();
  const sel = new Set(state.facets || ['all']);
  const only = (key: string): boolean => sel.size === 1 && sel.has(key as never);
  return (
    <div className="list" id="list">
      {only('all') ? <AllView /> : only('done') ? <DoneView /> : <FlatView />}
    </div>
  );
}
