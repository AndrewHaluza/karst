/**
 * The dashboard's Artifacts shelf, rendered by React into the page's existing containers (the "View all N"
 * button in the header, `#artifacts`) through `RegionPortal`s. Same DOM as the vanilla renderer it replaced
 * (`renderArtifacts`, `artifactCardHtml`). The static root `#artPanel` keeps its `hidden` toggle in a layout
 * effect (the region parity snapshot pins the root as static markup). A click opens the full-screen index or detail, the overlay stack's
 * artifact view (`ArtifactView.tsx`).
 *
 * The shelf is absent while the ticket has no artifact (spec §4.1, never an empty section). The host sorts
 * `state.artifacts` by semantic priority, so the first three ARE the three most useful outputs (spec §5).
 */
import { memo, useLayoutEffect } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { OriginChip, StaleChip, StatusChip, type Origin } from './ArtifactChips.js';
import { ART_STAGE_LABEL } from './ArtifactSections.js';
import { Icon } from './Icon.js';
import { useOverlays } from './DashboardAppContext.js';
import { RegionPortal } from './RegionPortal.js';
import { useSlice } from './useSlice.js';
import './ArtifactsPanels.css';

interface Card {
  readonly id: string;
  readonly title: string;
  readonly scope: string | null;
  readonly summary: string;
  readonly status: string;
  readonly stale: boolean;
  readonly origin: Origin | null;
  readonly kind: string;
  /** 'Stage · vN', the card's second line. */
  readonly stageLine: string;
}

const KIND_ICON: Readonly<Record<string, string>> = { plan: 'list-tree', 'uat-report': 'circle-check', review: 'eye', 'ship-summary': 'git-compare' };
const GENERIC_KIND_ICON = 'file-text';

interface ShelfSlice {
  readonly total: number;
  readonly cards: readonly Card[];
}

const SHELF_SIZE = 3;

const selectShelf = (snapshot: DashboardSnapshot): ShelfSlice | null => {
  const all = snapshot.state?.artifacts;
  if (!all) return null;
  return {
    total: all.length,
    cards: all.slice(0, SHELF_SIZE).map((a) => ({
      id: a.id,
      title: a.title,
      scope: a.scope,
      summary: a.summary,
      status: a.status,
      stale: a.freshness === 'stale',
      origin: a.origin,
      kind: a.kind,
      stageLine: `${ART_STAGE_LABEL[a.stage] ?? a.stage} · ${a.currentVersionLabel}`,
    })),
  };
};

// A preview card. The semantic title is the subject; raw filenames NEVER appear on the shelf (spec §4.4).
const ArtCard = memo(function ArtCard({ a }: { readonly a: Card }) {
  const overlays = useOverlays();
  return (
    <button type="button" className="artcard" data-art-open={a.id} aria-label={`Open ${a.title}`} onClick={() => overlays.openArtifact(a.id)}>
      <span className="artcard-top">
        <span className="artcard-kind">
          <Icon name={KIND_ICON[a.kind] ?? GENERIC_KIND_ICON} size={15} />
        </span>
        <span className="artcard-id">
          <span className="artcard-title">
            {a.title}
            {a.scope ? <span className="art-sub">· {a.scope}</span> : null}
          </span>
          <span className="artcard-stage">{a.stageLine}</span>
        </span>
      </span>
      <span className="artcard-summary">{a.summary}</span>
      <span className="artcard-meta">
        <StatusChip status={a.status} />
        <StaleChip stale={a.stale} />
        <OriginChip origin={a.origin} />
      </span>
    </button>
  );
});

export const ArtifactsShelf = memo(function ArtifactsShelf() {
  const overlays = useOverlays();
  const slice = useSlice(selectShelf);
  const total = slice?.total ?? 0;
  useLayoutEffect(() => {
    document.getElementById('artPanel')?.classList.toggle('hidden', total === 0);
  }, [total]);
  return (
    <>
      {/* The "View all N" button IS the counter: the header carries no `.count` of its own. */}
      <RegionPortal id="artPanel" into=".phead">
        <button id="artViewAll" type="button" className="k-btn k-btn--ghost k-btn--sm" data-art="index" title="Show every artifact this ticket has produced" onClick={overlays.openIndex}>
          View all <span id="artTotal">{total ? total : null}</span> ›
        </button>
      </RegionPortal>
      <RegionPortal id="artifacts">
        {slice && total ? (
          <div className="artcards">
            {slice.cards.map((a) => (
              <ArtCard key={a.id} a={a} />
            ))}
          </div>
        ) : null}
      </RegionPortal>
    </>
  );
});
