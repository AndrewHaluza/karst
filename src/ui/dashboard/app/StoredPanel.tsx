/**
 * The dashboard's Captured artifacts summary panel (T2 store), rendered by React into the page's existing
 * containers (the "Open N" button in the header, `#storedSummary`). Same DOM as the vanilla renderer it
 * replaced (`renderStoredPanel`). The panel shows once the host's first load answers; "Open" asks the page
 * to swap in the still-vanilla stored view through the `karst:openArt` seam. The static root keeps its
 * `hidden` toggle in a layout effect, like the Artifacts shelf.
 */
import { memo, useLayoutEffect } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { announceOpenArt } from './artSeam.js';
import { RegionPortal } from './RegionPortal.js';
import { useSlice } from './useSlice.js';
import './ArtifactsPanels.css';

interface StoredSlice {
  readonly total: number;
  readonly kinds: readonly { readonly kind: string; readonly rows: number }[];
}

const selectStored = (snapshot: DashboardSnapshot): StoredSlice | null => {
  const v = snapshot.state?.storedArtifacts;
  if (!v) return null;
  return {
    total: v.total,
    kinds: v.groups.map((g) => ({ kind: g.kind, rows: g.approaches.reduce((n, a) => n + a.rows.length, 0) })),
  };
};

export const StoredPanel = memo(function StoredPanel() {
  const slice = useSlice(selectStored);
  const loaded = slice !== null;
  useLayoutEffect(() => {
    document.getElementById('storedPanel')?.classList.toggle('hidden', !loaded);
  }, [loaded]);
  return (
    <>
      <RegionPortal id="storedPanel" into=".phead">
        <button id="storedOpen" type="button" className="k-btn k-btn--ghost k-btn--sm" data-art="stored" title="Browse captured output files and their revision history" onClick={() => announceOpenArt({ kind: 'stored' })}>
          Open <span id="storedTotal">{slice ? slice.total : null}</span> ›
        </button>
      </RegionPortal>
      <RegionPortal id="storedSummary">
        {slice ? (
          slice.total === 0 ? (
            <span className="sa-empty">Nothing captured yet.</span>
          ) : (
            <span className="sa-meta">{slice.kinds.map((g) => `${g.kind} ${g.rows}`).join(' · ')}</span>
          )
        ) : null}
      </RegionPortal>
    </>
  );
});
