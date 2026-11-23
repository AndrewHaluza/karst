/**
 * The scrolling list — the one thing that scrolls (UI-R38). Which shape it takes
 * follows the facet selection:
 *
 * - All: Current / Awaiting review / Recently done, and Older Completed behind
 *   a disclosure. Empty sections are omitted entirely.
 * - Done: every completed ticket at once, newest first, no hierarchy.
 * - Anything else (Archived, derived-status unions): the flat filtered list.
 *
 * The list is a tree with one roving tab stop (@ui:UI-R09, SB-6): every section
 * is a labelled group and every row a treeitem. Planning sessions are not here:
 * they have their own pane.
 */
import { useState, type ReactNode } from 'react';
import type { TicketRow as Row } from '../state.js';
import { ActButton } from './action.js';
import { CloudSessionRows } from './CloudSessions.js';
import { visibleRows } from './format.js';
import { Icon } from './Icon.js';
import { PaneEmpty } from './PaneEmpty.js';
import { useSidebar } from './SidebarContext.js';
import { TicketRow } from './TicketRow.js';
import { useRovingTree } from './useRovingTree.js';

/** A section: a labelled group (SB-6) around its header and rows. */
function Section({ name, count, noun = 'ticket', children }: { readonly name: string; readonly count: number; readonly noun?: string; readonly children: ReactNode }) {
  return (
    <div role="group" aria-label={`${name}, ${count} ${noun}${count === 1 ? '' : 's'}`}>
      <div className="sec" role="presentation">
        <span className="sec-name">{name}</span>
        <span className="sec-n">· {count}</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ view }: { readonly view: 'all' | 'archived' | 'done' }) {
  const { state, clearTicketFilters } = useSidebar();
  if (state.filter) {
    return <PaneEmpty title="No tickets match" action={<button type="button" className="k-link" data-clear-filters="1" onClick={clearTicketFilters}>Clear filters</button>} />;
  }
  if (view === 'archived') return <PaneEmpty title="No archived tickets" />;
  if (view === 'done') return <PaneEmpty title="No done tickets" />;
  return <PaneEmpty title="No tickets yet" hint={<ActButton spec={{ act: 'create' }} className="k-btn k-btn--link">Create ticket</ActButton>} />;
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

function Rows({ rows, stop, compact = false, time = false, older = false }: { readonly rows: readonly Row[]; readonly stop: string | null; readonly compact?: boolean; readonly time?: boolean; readonly older?: boolean }): ReactNode {
  return rows.map((r, i) => <TicketRow key={r.ticketId} row={r} stop={stop} posInSet={i + 1} setSize={rows.length} compact={compact} time={time} older={older} />);
}

function AllView({ sections, expanded, stop }: { readonly sections: { current: readonly Row[]; awaiting: readonly Row[]; recent: readonly Row[]; older: readonly Row[] }; readonly expanded: boolean; readonly stop: string | null }) {
  const { state } = useSidebar();
  const { current, awaiting, recent, older } = sections;
  const cloud = state.unlinkedCloudSessions || [];
  if (!current.length && !awaiting.length && !recent.length && !older.length && !cloud.length) return <Empty view="all" />;
  return (
    <>
      {current.length ? <Section name="Current" count={current.length}><Rows rows={current} stop={stop} /></Section> : null}
      {cloud.length ? <Section name="Cloud sessions" count={cloud.length} noun="session"><CloudSessionRows sessions={cloud} /></Section> : null}
      {awaiting.length ? <Section name="Awaiting review" count={awaiting.length}><Rows rows={awaiting} stop={stop} /></Section> : null}
      {recent.length ? <Section name="Recently done" count={recent.length}><Rows rows={recent} stop={stop} compact time /></Section> : null}
      {older.length ? (
        <div role="group" aria-label={`${older.length} older completed`}>
          <HistoryToggle expanded={expanded} count={older.length} />
          {expanded ? <div className="histlist" id="histlist"><Rows rows={older} stop={stop} compact older /></div> : null}
        </div>
      ) : null}
    </>
  );
}

function DoneView({ rows, stop }: { readonly rows: readonly Row[]; readonly stop: string | null }) {
  if (!rows.length) return <Empty view="done" />;
  return <Section name="Done" count={rows.length}><Rows rows={rows} stop={stop} compact time /></Section>;
}

function FlatView({ rows, stop }: { readonly rows: readonly Row[]; readonly stop: string | null }) {
  const { state } = useSidebar();
  if (!rows.length) return <Empty view={(state.facets || []).includes('archived') ? 'archived' : 'all'} />;
  return <Rows rows={rows} stop={stop} />;
}

export function TicketList() {
  const { state, collapsedSubtrees: c, hist, openIds, toggleOpen } = useSidebar();
  const [focus, setFocus] = useState<string | null>(null);
  const sel = new Set(state.facets || ['all']);
  const only = (key: string): boolean => sel.size === 1 && sel.has(key as never);
  const view = only('all') ? 'all' : only('done') ? 'done' : 'flat';

  // Exactly the rows each view renders: the roving stop must never land on a row
  // that is hidden (a collapsed sub-tree, the closed Older Completed list).
  const secs = state.sections;
  const current = view === 'all' ? visibleRows((secs && secs.current) || state.rows || [], c) : [];
  const awaiting = view === 'all' ? visibleRows((secs && secs.awaitingReview) || [], c) : [];
  const recent = view === 'all' ? visibleRows((secs && secs.recentlyDone) || [], c) : [];
  const older = view === 'all' ? visibleRows((secs && secs.olderDone) || [], c) : [];
  const done = view === 'done' ? state.done || [] : [];
  const flat = view === 'flat' ? visibleRows(state.rows || [], c) : [];
  const query = (state.filter || '').trim();
  // Auto-reveal: a query that matches Older Completed expands the section so the
  // match is visible, but that is NOT the user's explicit choice — clearing the
  // search restores the default collapsed state.
  const expanded = hist.user ? hist.open : query !== '' && older.length > 0;
  const rendered = [...current, ...awaiting, ...recent, ...(expanded ? older : []), ...done, ...flat];
  const nodes = rendered.map((r) => `t${r.ticketId}`);

  const { tree, stop, onKeyDown } = useRovingTree({
    nodes,
    focus,
    setFocus,
    onMenu: (item) => item.querySelector<HTMLElement>('[data-menu]')?.click(),
    onPrimary: (item) => {
      const open = item.querySelector<HTMLElement>('.rowopen');
      if (open?.tagName === 'BUTTON') open.click();
    },
    onExpand: (item, open) => {
      const id = Number((item.dataset.node ?? '').slice(1));
      if (openIds.has(id) !== open) toggleOpen(id);
    },
  });

  const sections = { current, awaiting, recent, older };
  return (
    <div
      className="list"
      id="list"
      role={nodes.length ? 'tree' : undefined}
      aria-label={nodes.length ? 'Tickets' : undefined}
      ref={tree}
      onKeyDown={onKeyDown}
    >
      {view === 'all' ? <AllView sections={sections} expanded={expanded} stop={stop} /> : view === 'done' ? <DoneView rows={done} stop={stop} /> : <FlatView rows={flat} stop={stop} />}
    </div>
  );
}
