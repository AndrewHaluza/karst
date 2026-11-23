/**
 * The Queue pane: ONE computed order of the project's pending drafts (every
 * planning session) and not-started tickets. The host computes the order and
 * the reason of every place (`queueOrder.ts`); this view only draws it. Placed
 * between Planning and Tickets, collapsed by default; collapsing is pure view
 * state. A click opens a draft's Review or a ticket's dashboard.
 */
import type { QueueRowView } from '../state.js';
import { Icon } from './Icon.js';
import { Pane } from './Pane.js';
import { PaneEmpty } from './PaneEmpty.js';
import { PriorityChip } from './PriorityChip.js';
import { priorityMenuItem } from './priority.js';
import { TicketRefs } from './TicketRefs.js';
import { QueueFilterChips } from './QueueFilterChips.js';
import { QueueFilterMenu } from './QueueFilterMenu.js';
import { filterQueue, hasChain, hasQueueFilters, liveFilters, matchesQuery, NO_QUEUE_FILTERS } from './queueFilter.js';
import { useSidebar } from './SidebarContext.js';
import type { ActionSpec } from './action.js';

export const QUEUE_EMPTY_TEXT = 'Nothing waits. New drafts and not-started tickets show here.';
export const QUEUE_NO_MATCH_TEXT = 'No queue items match.';

/** The text with each match of the search query wrapped in a mark. */
function Marked({ text, query }: { readonly text: string; readonly query: string }) {
  const needle = query.trim().toLowerCase();
  const at = needle === '' ? -1 : text.toLowerCase().indexOf(needle);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="q-hit">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function openSpec(row: QueueRowView): ActionSpec {
  return row.kind === 'draft' ? { act: 'plan-proposal-review', proposal: row.id } : { act: 'open-dashboard', id: row.id };
}

/** The fact the old muted text carried, kept in the main button's name and tooltip. */
function whyTitle(row: QueueRowView): string {
  if (row.whyKind === 'cycle') return 'These items wait on each other. Remove one dependency.';
  if (row.whyKind === 'raised') return `Raised to ${row.level} because ${row.inheritedFrom} waits on it`;
  return row.waitsOn.length ? `Waits on ${row.waitsOn.join(', ')}` : '';
}

/**
 * The relation of a row: the D561 verb and the D560 chip. It is a SIBLING of the
 * main button, never inside it, so no link nests in a button (@ui:UI-R09).
 */
function QueueRelation({ row }: { readonly row: QueueRowView }) {
  // A snapshot restored from the webview state can predate the chip fields
  // (@ui:UI-R31): a missing field draws no relation, never a crash that blanks the page.
  const waitsOnRefs = row.waitsOnRefs ?? [];
  if (row.whyKind === 'cycle') {
    const refs = row.cycleRef ? [row.cycleRef] : [];
    return (
      <TicketRefs
        refs={refs}
        verb="Cycle with"
        className="q-rel q-rel--cycle"
        lead={<Icon name="refresh" size={12} cls="q-rel-icon" />}
      />
    );
  }
  if (row.whyKind === 'raised' && row.inheritedRef) {
    return <TicketRefs refs={[row.inheritedRef]} verb="Unblocks" className="q-rel q-rel--raised" />;
  }
  if (row.whyKind === 'waits' && waitsOnRefs.length) {
    return <TicketRefs refs={waitsOnRefs} className="q-rel q-rel--waits" />;
  }
  return null;
}

interface QueueRowProps {
  readonly row: QueueRowView;
  readonly query: string;
  /** The row shows the chain control. */
  readonly linked: boolean;
  readonly chainOn: boolean;
  readonly onChain: (id: string) => void;
}

function QueueRow({ row, query, linked, chainOn, onChain }: QueueRowProps) {
  const { fire, menu, openMenu, closeMenu } = useSidebar();
  const owner = `q${row.idLabel}`;
  const menuOpen = menu?.owner === owner;
  const target = row.kind === 'draft' ? { proposal: row.id } : { ticket: row.id };
  const fact = whyTitle(row);
  const label = `${row.position}. ${row.idLabel} ${row.title}${fact ? `, ${fact}` : ''}`;
  const spec = openSpec(row);
  return (
    <div className="q-row" data-queue-row={row.idLabel} data-kind={row.kind}>
      <button
        type="button"
        className="q-main"
        aria-label={label}
        title={label}
        data-act={spec.act}
        onClick={(e) => fire(spec, e.currentTarget, e)}
      >
        <span className="q-pos">{row.position}</span>
        <PriorityChip
          level={row.level}
          source={row.level === row.ownLevel ? row.prioritySource : null}
          provider={row.providerLabel === null ? undefined : { label: row.providerLabel, level: row.providerPriority }}
          raised={row.whyKind === 'raised'}
        />
        <span className="q-id">
          <Marked text={row.idLabel} query={query} />
          {row.sessionLabel ? (
            <span className="q-sx">
              {' · '}
              <Marked text={row.sessionLabel} query={query} />
              {row.sessionTitle && query.trim() !== '' && row.sessionTitle.toLowerCase().includes(query.trim().toLowerCase()) ? (
                <span className="q-sx-title"> · <Marked text={row.sessionTitle} query={query} /></span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="q-title" title={row.title} aria-label={row.title}><Marked text={row.title} query={query} /></span>
      </button>
      <QueueRelation row={row} />
      {linked ? (
        <button
          type="button"
          className="k-iconbtn q-chain"
          data-queue-chain={row.idLabel}
          aria-pressed={chainOn}
          aria-label={`Show chain of ${row.idLabel}`}
          title="Show chain"
          onClick={() => onChain(row.idLabel)}
        >
          <Icon name="link" />
        </button>
      ) : null}
      <button
        type="button"
        className="k-iconbtn q-menu"
        data-menu={owner}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`More actions for ${row.idLabel}`}
        title="More actions"
        onClick={(e) => {
          if (menuOpen) closeMenu(true);
          else openMenu(e.currentTarget, owner, [priorityMenuItem(target, row.ownLevel)]);
        }}
      >
        <Icon name="dots" />
      </button>
    </div>
  );
}

export function QueuePane() {
  const { state, view, updateQueueFilters, post } = useSidebar();
  const rows = state.queue?.rows ?? [];
  const query = state.filter || '';
  const filters = liveFilters(rows, view.queueFilters);
  const searching = query.trim() !== '';
  const active = hasQueueFilters(filters) || searching;
  const { shown, items } = filterQueue(rows, filters, query);
  const revealed = searching && rows.some((r) => matchesQuery(r, query));
  const toggleChain = (id: string): void =>
    updateQueueFilters((f) => ({ ...f, chain: f.chain === id ? null : id }));
  const clear = (): void => {
    updateQueueFilters(() => NO_QUEUE_FILTERS);
    if (searching) post({ type: 'set-filter', query: '' });
  };
  return (
    <Pane
      pane="queue"
      title="Queue"
      count={active ? `${shown} / ${rows.length}` : rows.length}
      revealed={revealed}
      actions={rows.length ? <QueueFilterMenu rows={rows} /> : null}
      sub={rows.length ? <QueueFilterChips rows={rows} /> : null}
    >
      {!rows.length ? (
        <PaneEmpty title={QUEUE_EMPTY_TEXT} region="queue" />
      ) : shown === 0 ? (
        <PaneEmpty
          title={QUEUE_NO_MATCH_TEXT}
          region="queue"
          action={<button type="button" className="k-link q-clear-all" data-queue-clear-all="1" onClick={clear}>Clear filters</button>}
        />
      ) : (
        <div className="q-list" data-region="queue">
          {items.map((it, i) =>
            'row' in it ? (
              <QueueRow
                key={it.row.idLabel}
                row={it.row}
                query={query}
                linked={hasChain(it.row, rows)}
                chainOn={filters.chain === it.row.idLabel}
                onChain={toggleChain}
              />
            ) : (
              <div key={`gap-${i}`} className="q-gap" data-queue-gap={it.gap} role="separator" aria-label={`${it.gap} hidden`}>···</div>
            ),
          )}
        </div>
      )}
    </Pane>
  );
}
