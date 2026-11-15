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
import { PriorityChip } from './PriorityChip.js';
import { priorityMenuItem } from './priority.js';
import { TicketRefs } from './TicketRefs.js';
import { useSidebar } from './SidebarContext.js';
import type { ActionSpec } from './action.js';

export const QUEUE_EMPTY_TEXT = 'Nothing waits. New drafts and not-started tickets show here.';

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
  if (row.whyKind === 'waits' && row.waitsOnRefs.length) {
    return <TicketRefs refs={row.waitsOnRefs} className="q-rel q-rel--waits" />;
  }
  return null;
}

function QueueRow({ row }: { readonly row: QueueRowView }) {
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
          {row.idLabel}
          {row.sessionLabel ? <span className="q-sx"> · {row.sessionLabel}</span> : null}
        </span>
        <span className="q-title" title={row.title} aria-label={row.title}>{row.title}</span>
      </button>
      <QueueRelation row={row} />
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
  const { state } = useSidebar();
  const rows = state.queue?.rows ?? [];
  return (
    <Pane pane="queue" title="Queue" count={rows.length} actions={null}>
      {rows.length ? (
        <div className="q-list" data-region="queue">
          {rows.map((r) => <QueueRow key={r.idLabel} row={r} />)}
        </div>
      ) : (
        <div className="pane-empty" data-region="queue">{QUEUE_EMPTY_TEXT}</div>
      )}
    </Pane>
  );
}
