/**
 * The one header every drill-down surface draws (`data-region="drill-head"`): Back to the previous view · breadcrumb
 * (section › item; middle levels are links) · the surface's actions on the right · the Esc hint. Back answers the
 * overlay stack's history, so its label names the view it returns to (`drillTargets.viewLabel`), the dashboard when
 * the history is empty.
 */
import type { ReactNode } from 'react';
import { useOverlay, useOverlays } from './DashboardAppContext.js';
import { viewLabel } from './drillTargets.js';
import { DASHBOARD, type OverlayView } from './overlayStack.js';
import { useSlice } from './useSlice.js';
import './DrillHeader.css';

export interface Crumb {
  readonly label: string;
  /** Present on a middle level: the crumb is a link that navigates there. */
  readonly to?: OverlayView;
}

const selectState = (s: { readonly state: Parameters<typeof viewLabel>[1] }) => s.state;
const lastOf = (h: readonly OverlayView[]): OverlayView => h[h.length - 1] ?? DASHBOARD;

export function DrillHeader({ trail, actions }: { readonly trail: readonly Crumb[]; readonly actions?: ReactNode }) {
  const overlays = useOverlays();
  const state = useSlice(selectState);
  const previous = useOverlay((s) => viewLabel(lastOf(s.history), state));
  const current = trail[trail.length - 1];
  return (
    <div className="drillhead" data-region="drill-head">
      <button type="button" className="k-btn k-btn--ghost k-btn--sm dh-back" data-art="back" aria-label={`Back to ${previous}`} title={`Back to ${previous}`} onClick={overlays.back}>
        <span aria-hidden="true">←</span>
        <span className="dh-backlabel">{previous}</span>
      </button>
      <nav className="dh-trail" aria-label="Breadcrumb">
        <ol>
          {trail.map((c, i) => {
            const last = c === current;
            return (
              <li key={`${i}:${c.label}`} className={last ? 'dh-current' : 'dh-mid'}>
                {c.to ? (
                  <button type="button" className="dh-link" onClick={() => overlays.goTo(c.to!)}>
                    {c.label}
                  </button>
                ) : (
                  <span title={c.label} aria-current={last ? 'page' : undefined}>
                    {c.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {actions ? <div className="dh-actions">{actions}</div> : null}
      <kbd className="dh-esc" aria-hidden="true">
        Esc
      </kbd>
    </div>
  );
}
