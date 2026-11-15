/**
 * The chip row under the Queue header: one chip for each active filter (the
 * chain is one chip too), each with a remove button, and a Clear link that
 * removes all. Nothing renders while no filter is active.
 */
import { Icon } from './Icon.js';
import { levelLabel } from './priority.js';
import { activeChain, hasQueueFilters, liveFilters, sessionText, toggledValue, NO_QUEUE_FILTERS, type QueueFilters } from './queueFilter.js';
import type { QueueRowView } from '../state.js';
import { useSidebar } from './SidebarContext.js';

interface ChipSpec {
  readonly key: string;
  readonly text: string;
  readonly remove: (f: QueueFilters) => QueueFilters;
}

function chipSpecs(rows: readonly QueueRowView[], f: QueueFilters): ChipSpec[] {
  const titleOf = (label: string): string | null => rows.find((r) => r.sessionLabel === label)?.sessionTitle ?? null;
  const chain = activeChain(rows, f);
  return [
    ...f.kinds.map((k) => ({ key: `kind:${k}`, text: k === 'draft' ? 'Drafts' : 'Tickets', remove: (x: QueueFilters) => ({ ...x, kinds: toggledValue(x.kinds, k) }) })),
    ...f.sessions.map((s) => ({ key: `session:${s}`, text: sessionText(s, titleOf(s)), remove: (x: QueueFilters) => ({ ...x, sessions: toggledValue(x.sessions, s) }) })),
    ...f.levels.map((l) => ({ key: `level:${l}`, text: levelLabel(l), remove: (x: QueueFilters) => ({ ...x, levels: toggledValue(x.levels, l) }) })),
    ...f.blocked.map((b) => ({ key: `blocked:${b}`, text: b === 'free' ? 'Not blocked' : 'Blocked', remove: (x: QueueFilters) => ({ ...x, blocked: toggledValue(x.blocked, b) }) })),
    ...(f.chain !== null && chain !== null ? [{ key: 'chain', text: `Chain: ${f.chain} · ${chain.size}`, remove: (x: QueueFilters) => ({ ...x, chain: null }) }] : []),
  ];
}

export function QueueFilterChips({ rows }: { readonly rows: readonly QueueRowView[] }) {
  const { view, updateQueueFilters } = useSidebar();
  const filters = liveFilters(rows, view.queueFilters);
  const chips = chipSpecs(rows, filters);
  if (!hasQueueFilters(filters) || chips.length === 0) return null;
  return (
    <div className="q-filters" data-region="queue-filters">
      {chips.map((c) => (
        <span key={c.key} className="k-chip q-fchip" data-queue-chip={c.key}>
          <span className="q-fchip-text">{c.text}</span>
          <button
            type="button"
            className="q-fchip-x"
            aria-label={`Remove filter ${c.text}`}
            title={`Remove filter ${c.text}`}
            onClick={() => updateQueueFilters(c.remove)}
          >
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      <button type="button" className="k-link q-fclear" data-queue-clear="1" onClick={() => updateQueueFilters(() => NO_QUEUE_FILTERS)}>
        Clear
      </button>
    </div>
  );
}
