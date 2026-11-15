/**
 * The funnel in the Queue header: a menu button offering the multi-select
 * filters (menuitemcheckbox), in four groups with a count on each entry: Kind,
 * Session, Priority and State. A dot marks any active filter. The menu stays
 * open while the user ticks entries. Arrows/Home/End move, Escape closes
 * returning focus to the funnel, an outside click or Tab closes. It follows the
 * pattern of `FilterMenu`; the choices are view state and are never posted.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAnchoredPopover } from '../../shared/useAnchoredPopover.js';
import type { QueueRowView } from '../state.js';
import { ToolbarGlyph } from './Icon.js';
import { hasQueueFilters, liveFilters, isBlocked, queueSessions, sessionText, toggledValue, type QueueFilters } from './queueFilter.js';
import { levelLabel, LEVELS } from './priority.js';
import { useSidebar } from './SidebarContext.js';

const FUNNEL = ['M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227'];

interface Entry {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly checked: boolean;
  readonly toggle: (f: QueueFilters) => QueueFilters;
}
interface Group {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly Entry[];
}

const countOf = (rows: readonly QueueRowView[], test: (r: QueueRowView) => boolean): number => rows.filter(test).length;

/** The four groups with the count of each entry over the WHOLE queue. */
export function queueFilterGroups(rows: readonly QueueRowView[], f: QueueFilters): Group[] {
  return [
    {
      id: 'kind',
      label: 'Kind',
      entries: [
        { key: 'draft', label: 'Drafts', count: countOf(rows, (r) => r.kind === 'draft'), checked: f.kinds.includes('draft'), toggle: (x) => ({ ...x, kinds: toggledValue(x.kinds, 'draft') }) },
        { key: 'ticket', label: 'Tickets', count: countOf(rows, (r) => r.kind === 'ticket'), checked: f.kinds.includes('ticket'), toggle: (x) => ({ ...x, kinds: toggledValue(x.kinds, 'ticket') }) },
      ],
    },
    {
      id: 'session',
      label: 'Session',
      entries: queueSessions(rows).map((s) => ({
        key: s.label,
        label: sessionText(s.label, s.title),
        count: s.count,
        checked: f.sessions.includes(s.label),
        toggle: (x: QueueFilters) => ({ ...x, sessions: toggledValue(x.sessions, s.label) }),
      })),
    },
    {
      id: 'priority',
      label: 'Priority',
      entries: LEVELS.map((level) => ({
        key: level,
        label: levelLabel(level),
        count: countOf(rows, (r) => r.level === level),
        checked: f.levels.includes(level),
        toggle: (x: QueueFilters) => ({ ...x, levels: toggledValue(x.levels, level) }),
      })),
    },
    {
      id: 'state',
      label: 'State',
      entries: [
        { key: 'free', label: 'Not blocked', count: countOf(rows, (r) => !isBlocked(r)), checked: f.blocked.includes('free'), toggle: (x) => ({ ...x, blocked: toggledValue(x.blocked, 'free') }) },
        { key: 'blocked', label: 'Blocked', count: countOf(rows, isBlocked), checked: f.blocked.includes('blocked'), toggle: (x) => ({ ...x, blocked: toggledValue(x.blocked, 'blocked') }) },
      ],
    },
  ];
}

export function QueueFilterMenu({ rows }: { readonly rows: readonly QueueRowView[] }) {
  const { view, updateQueueFilters } = useSidebar();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  useAnchoredPopover(open, pop, button, () => setOpen(false));
  const filters = liveFilters(rows, view.queueFilters);
  const filtered = hasQueueFilters(filters);

  useLayoutEffect(() => {
    if (!open) return;
    const items = wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]');
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
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
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

  const label = `Filter the queue${filtered ? ' (active)' : ''}`;
  return (
    <span className="filter-menu" ref={wrap}>
      <button
        type="button"
        className="k-iconbtn"
        data-queue-filter-menu="1"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <ToolbarGlyph paths={FUNNEL} />
        {filtered ? <span className="filter-dot" data-queue-filter-dot="1" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="filter-pop" ref={pop} role="menu" aria-label="Queue filter" onKeyDown={onKeyDown}>
          {queueFilterGroups(rows, filters).filter((g) => g.entries.length > 0).map((g) => (
            <div key={g.id} role="group" aria-label={g.label} data-filter-group={g.id}>
              <div className="filter-group-label" aria-hidden="true">{g.label}</div>
              {g.entries.map((en) => (
                <button
                  type="button"
                  key={en.key}
                  className="ctxitem"
                  role="menuitemcheckbox"
                  aria-checked={en.checked}
                  data-queue-filter={`${g.id}:${en.key}`}
                  tabIndex={-1}
                  onClick={() => updateQueueFilters(en.toggle)}
                >
                  <span className="filter-entry">{en.label}</span>
                  <span className="filter-count">{en.count}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
}
