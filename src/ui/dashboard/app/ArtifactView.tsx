/**
 * The artifact index / detail / stored surface: the SAME webview, never a second tab. While one is open it replaces the
 * dashboard body (`body.art-nav` hides the stepper and the grid) and is drawn into the static `#artView` root; Back and
 * Escape return to the ticket dashboard (spec §7-8). Which surface is open, Back's answer and every surface's scroll
 * position live in the overlay stack (`overlayStack.ts`); this view draws what the stack says and puts the document back
 * where the surface now showing was left once that surface is on screen (spec §9).
 *
 * The index lists the artifacts grouped by producing stage, empty groups omitted (spec §10). Rows are real buttons
 * (UI-R09), each carrying its semantic name, one useful summary line, status and staleness, and the origin chip.
 */
import { memo, useLayoutEffect } from 'react';
import type { ArtifactSummary } from '../../../model/artifacts.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { OriginChip, StaleChip, StatusChip } from './ArtifactChips.js';
import { BackButton, useHeading } from './ArtifactParts.js';
import { ART_STAGE_LABEL, Baselines, Commits, Details, Files, Findings, Gates, Metrics, Prs, Tasks } from './ArtifactSections.js';
import { useOverlay, useOverlays } from './DashboardAppContext.js';
import { RegionPortal } from './RegionPortal.js';
import { StoredView } from './StoredView.js';
import { useOverlayRoot } from './useOverlayRoot.js';
import { useSlice } from './useSlice.js';
import type { ArtView } from './overlayStack.js';
import './ArtifactView.css';

const NO_ARTIFACTS: readonly ArtifactSummary[] = [];
const selectReady = (snapshot: DashboardSnapshot): boolean => snapshot.state !== null;
const selectArtifacts = (snapshot: DashboardSnapshot): readonly ArtifactSummary[] => snapshot.state?.artifacts ?? NO_ARTIFACTS;

const STAGES = ['impl', 'uat', 'review', 'ship'] as const;

const Index = memo(function Index({ artifacts }: { readonly artifacts: readonly ArtifactSummary[] }) {
  const overlays = useOverlays();
  const heading = useHeading();
  const groups = STAGES.map((stage) => ({ stage, items: artifacts.filter((a) => a.stage === stage) })).filter((g) => g.items.length > 0);
  return (
    <>
      <div className="arthead">
        <BackButton to="ticket" />
        <h2>{heading}</h2>
        <span className="artsub">{`Artifacts · ${artifacts.length}`}</span>
      </div>
      {groups.map((g) => (
        <section key={g.stage} className="artgroup" aria-label={`${ART_STAGE_LABEL[g.stage]} artifacts`}>
          <div className="artgroup-title">{ART_STAGE_LABEL[g.stage]}</div>
          <ul className="artrows">
            {g.items.map((a) => (
              <li key={a.id}>
                <button type="button" className="artrow" data-art-open={a.id} onClick={() => overlays.openArtifact(a.id)}>
                  <span className="artrow-body">
                    <span className="artrow-title">{a.title}</span>
                    <span className="artrow-summary">{a.summary}</span>
                  </span>
                  <StatusChip status={a.status} />
                  <StaleChip stale={a.freshness === 'stale'} />
                  <OriginChip origin={a.origin} />
                  <span className="arw" aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
});

/** Detail is semantic-first, files last (spec §11): the result, the metrics, artifact-specific content, provenance, then the raw files. */
const Detail = memo(function Detail({ a, from }: { readonly a: ArtifactSummary; readonly from: 'index' | 'ticket' }) {
  return (
    <>
      <div className="arthead">
        <BackButton to={from} />
      </div>
      <div className="artdetail">
        <div className="arthero">
          <span className="art-title">{a.title}</span>
          <StatusChip status={a.status} />
          <StaleChip stale={a.freshness === 'stale'} />
        </div>
        <div className="artcard-summary">{a.summary}</div>
        {a.freshness === 'stale' ? <p className="art-stale art-stale-note">Implementation changed after this verification — rerun the stage before treating this result as evidence for the current code.</p> : null}
        <Metrics a={a} />
        <Tasks a={a} />
        <Baselines a={a} />
        <Findings key={a.id} a={a} />
        <Gates a={a} />
        <Prs a={a} />
        <Commits a={a} />
        <Details a={a} />
        <Files a={a} />
      </div>
    </>
  );
});

function Surface({ art }: { readonly art: ArtView }) {
  const overlays = useOverlays();
  const artifacts = useSlice(selectArtifacts);
  const detail = typeof art === 'object' ? (artifacts.find((a) => a.id === art.id) ?? null) : null;
  // A restored view whose artifact has since vanished (the evidence was deleted) shows the index rather than a dead detail.
  const vanished = typeof art === 'object' && detail === null;
  useLayoutEffect(() => {
    if (vanished) overlays.fallbackToIndex();
  }, [vanished, overlays]);
  if (art === 'stored') return <StoredView />;
  if (typeof art === 'object' && detail) return <Detail a={detail} from={art.from} />;
  return <Index artifacts={artifacts} />;
}

export function ArtifactOverlay() {
  const overlays = useOverlays();
  const art = useOverlay((s) => s.art);
  const ready = useSlice(selectReady);
  const shown = art !== null && ready ? art : null;
  useOverlayRoot('artView', shown !== null, 'art-nav');
  // Declared after the root's own layout effect, so the body swap has happened before the document is scrolled.
  useLayoutEffect(() => {
    overlays.restoreScroll();
  }, [overlays, art]);
  return <RegionPortal id="artView">{shown !== null ? <Surface art={shown} /> : null}</RegionPortal>;
}
