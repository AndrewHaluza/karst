/** The few pieces every artifact surface (index, detail, stored) draws the same way. */
import type { DashboardSnapshot } from './dashboardStore.js';
import { useOverlays } from './DashboardAppContext.js';
import { useSlice } from './useSlice.js';

const selectHeading = (snapshot: DashboardSnapshot): string => {
  const s = snapshot.state;
  return s?.key ? `${s.key} · ${s.title || ''}` : (s?.title ?? '');
};

/** "← Ticket" / "← Artifacts": Back is deterministic (spec §7.3), the label names where it goes. */
export function BackButton({ to }: { readonly to: 'ticket' | 'index' }) {
  const overlays = useOverlays();
  return (
    <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-art="back" title={to === 'index' ? 'Return to the artifacts index' : 'Return to the ticket dashboard'} onClick={overlays.back}>
      {to === 'index' ? '← Artifacts' : '← Ticket'}
    </button>
  );
}

/** The ticket's heading: "KEY · title", or the title alone. */
export function useHeading(): string {
  return useSlice(selectHeading);
}
