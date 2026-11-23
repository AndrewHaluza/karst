/**
 * One collapsible pane of the sidebar (Planning, Queue, Tickets, Activity). The
 * header is ALWAYS rendered, even with nothing to list: a chevron toggle (a real
 * button carrying `aria-expanded`/`aria-controls`), the title, the count, then
 * the pane's own actions. The body scrolls on its own. Collapsing is pure view
 * state.
 *
 * Two states sit on top of the data (SB-2, @ui:UI-R46):
 * - before the first host `state` the body paints three skeleton bars, never an
 *   empty message, so a cold start does not read as "there is nothing";
 * - once loaded, a pane whose count is 0 folds to its header by default, and its
 *   empty text shows only after the user opens it.
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
  /**
   * Whether the pane has nothing to show. Defaults to `count === 0`; a pane whose
   * count ignores some rendered content (Tickets counts tickets, not the unlinked
   * cloud sessions under them) passes the real answer.
   */
  readonly empty?: boolean;
  readonly children: ReactNode;
}

/** Three row-height bars: the loaded layout, minus the data (@ui:UI-R46, UI-R57 `loading`). */
function Skeleton() {
  return (
    <div className="pane-skel" aria-hidden="true">
      <span className="pane-skel-bar" />
      <span className="pane-skel-bar" />
      <span className="pane-skel-bar" />
    </div>
  );
}

export function Pane({ pane, title, count, actions, sub, revealed, empty, children }: PaneProps) {
  const { view, togglePane, loaded } = useSidebar();
  // A search reveal opens a collapsed pane without touching the saved state. A click on the
  // header of a revealed pane closes it for the length of the reveal and never flips the saved state.
  const [dismissed, setDismissed] = useState(false);
  // An empty pane folds by default but can still be opened; that choice is view-local.
  const [emptyOpen, setEmptyOpen] = useState(false);
  const reveal = revealed === true;
  useEffect(() => {
    if (!reveal) setDismissed(false);
  }, [reveal]);
  const forced = reveal && view.collapsed[pane];
  // While loading, the panes keep their normal shape and show skeletons instead.
  const zero = loaded && (empty ?? count === 0);
  const collapsed = forced ? dismissed : zero ? !emptyOpen : view.collapsed[pane];
  const bodyId = `pane-body-${pane}`;
  const toggle = (): void => {
    if (forced) setDismissed((d) => !d);
    else if (zero) setEmptyOpen((o) => !o);
    else togglePane(pane);
  };
  return (
    <section className="pane" data-pane={pane} data-collapsed={collapsed} data-loading={!loaded} aria-label={title}>
      <div className="pane-head">
        <button
          type="button"
          className="pane-toggle"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          onClick={toggle}
        >
          <span className="pane-chev"><Icon name="chevron-right" size={12} /></span>
          <span className="pane-title">{title}</span>
          <span className="pane-count">{count}</span>
        </button>
        <span className="pane-acts">{actions}</span>
      </div>
      {collapsed ? null : (
        <>
          {loaded ? sub : null}
          <div className="pane-body" id={bodyId}>{loaded ? children : <Skeleton />}</div>
        </>
      )}
    </section>
  );
}
