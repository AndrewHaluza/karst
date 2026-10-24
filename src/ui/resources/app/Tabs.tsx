/**
 * The two panel tabs, WAI-ARIA tabs pattern: `role=tablist`, roving tabindex,
 * Left/Right (wrapping) and Home/End move focus AND selection (automatic
 * activation — switching is instant and local, so there is nothing to confirm).
 */
import { useRef, type KeyboardEvent } from 'react';
import type { PanelTab } from '../messages.js';

export interface TabSpec {
  readonly id: PanelTab;
  readonly label: string;
}

export const TABS: readonly TabSpec[] = [
  { id: 'servers', label: 'Servers' },
  { id: 'resources', label: 'Resources' },
];

export const tabDomId = (id: PanelTab): string => `tab-${id}`;
export const panelDomId = (id: PanelTab): string => `panel-${id}`;

export function Tabs({ selected, onSelect }: { selected: PanelTab; onSelect: (tab: PanelTab) => void }) {
  const refs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});

  const move = (to: PanelTab): void => {
    onSelect(to);
    refs.current[to]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = TABS.findIndex((t) => t.id === selected);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    move(TABS[next]!.id);
  };

  return (
    <div className="tabs" role="tablist" aria-label="Servers and resources">
      {TABS.map((tab) => {
        const active = tab.id === selected;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[tab.id] = node;
            }}
            type="button"
            role="tab"
            id={tabDomId(tab.id)}
            className="tab"
            aria-selected={active}
            aria-controls={panelDomId(tab.id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
