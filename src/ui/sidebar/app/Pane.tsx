/**
 * One collapsible pane of the sidebar (Planning, Tickets). The header is ALWAYS
 * rendered, even with nothing to list: a chevron toggle (a real button carrying
 * `aria-expanded`/`aria-controls`), the title, the count, then the pane's own
 * actions. The body scrolls on its own. Collapsing is pure view state.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { useSidebar } from './SidebarContext.js';
import type { PaneKey } from './viewState.js';

export interface PaneProps {
  readonly pane: PaneKey;
  readonly title: string;
  /** The count text: a number, or `shown / total` while a filter is active. */
  readonly count: number | string;
  readonly actions: ReactNode;
  /** Open the pane although the user collapsed it (a search that matches a row inside). */
  readonly revealed?: boolean;
  /** Rendered between the header and the body while expanded (the Tickets attention line). */
  readonly sub?: ReactNode;
  readonly children: ReactNode;
}

export function Pane({ pane, title, count, actions, sub, revealed, children }: PaneProps) {
  const { view, togglePane } = useSidebar();
  // A search reveal opens a collapsed pane without touching the saved state. A click on the
  // header of a revealed pane closes it for the length of the reveal and never flips the saved state.
  const [dismissed, setDismissed] = useState(false);
  const reveal = revealed === true;
  useEffect(() => {
    if (!reveal) setDismissed(false);
  }, [reveal]);
  const forced = reveal && view.collapsed[pane];
  const collapsed = forced ? dismissed : view.collapsed[pane];
  const bodyId = `pane-body-${pane}`;
  return (
    <section className="pane" data-pane={pane} data-collapsed={collapsed} aria-label={title}>
      <div className="pane-head">
        <button
          type="button"
          className="pane-toggle"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          onClick={() => (forced ? setDismissed((d) => !d) : togglePane(pane))}
        >
          <span className="pane-chev"><Icon name="chevron-right" size={12} /></span>
          <span className="pane-title">{title}</span>
          <span className="pane-count">{count}</span>
        </button>
        <span className="pane-acts">{actions}</span>
      </div>
      {collapsed ? null : (
        <>
          {sub}
          <div className="pane-body" id={bodyId}>{children}</div>
        </>
      )}
    </section>
  );
}
