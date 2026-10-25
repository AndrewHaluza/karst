/**
 * The dashboard's Pull requests panel, rendered by React into the page's existing containers
 * (`#prCount`, `#prOps`, `#prs`) through three `RegionPortal`s. The panel root and its caption stay
 * static in `webview.html`. Same DOM as the vanilla renderer it replaced (`renderPrs`).
 *
 * The operations in flight (dismiss, refresh, CI) live in `usePrPending`, Merge in `pendingOps.ts` (shared with the stage rail); the merge-check
 * disclosures the user opened are panel state, so they outlive the line that holds them.
 */
import { memo, useCallback, useState } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { RefreshButton } from './PrActionButtons.js';
import { PrRow } from './PrRow.js';
import { useOps } from './DashboardAppContext.js';
import { RegionPortal } from './RegionPortal.js';
import { useSlice } from './useSlice.js';
import { usePrPending } from './usePrPending.js';
import type { DashboardState } from '../state.js';
import './PrsPanel.css';

interface PrsSlice {
  readonly prs: DashboardState['prs'];
  readonly mergeChecks: DashboardState['mergeChecks'];
  /** Repos whose failing CI the host offers to send to the agent (empty when unavailable). */
  readonly ciRepos: readonly string[];
}

/** null before the first host snapshot: the body is empty. */
const selectPrs = (snapshot: DashboardSnapshot): PrsSlice | null => {
  const state = snapshot.state;
  if (!state) return null;
  const ci = state.ciFailure;
  return { prs: state.prs ?? [], mergeChecks: state.mergeChecks ?? [], ciRepos: ci && ci.available ? ci.repos : [] };
};

export const PrsPanel = memo(function PrsPanel() {
  const slice = useSlice(selectPrs);
  const { pending, api } = usePrPending();
  // Merge is held in the state the stage rail's Merge shares (pendingOps.ts).
  const { merging } = useOps();
  const [openMerge, setOpenMerge] = useState<ReadonlySet<string>>(new Set());
  const toggleMerge = useCallback(
    (repo: string, open: boolean) =>
      setOpenMerge((current) => {
        if (current.has(repo) === open) return current;
        const next = new Set(current);
        if (open) next.add(repo);
        else next.delete(repo);
        return next;
      }),
    [],
  );
  const checks = new Map((slice?.mergeChecks ?? []).map((m) => [m.repo, m]));
  return (
    <>
      <RegionPortal id="prCount">{slice && slice.prs.length ? String(slice.prs.length) : null}</RegionPortal>
      {/* The refresh stays live even with zero PRs, and before the first snapshot: "none yet" is exactly the answer a user wants to re-ask right after a ship. */}
      <RegionPortal id="prOps">
        <RefreshButton api={api} busy={pending.refreshing} />
      </RegionPortal>
      <RegionPortal id="prs">
        {slice === null ? null : slice.prs.length === 0 ? (
          <div className="k-empty">
            <div className="k-empty-title">No pull requests.</div>
          </div>
        ) : (
          slice.prs.map((p) => (
            <PrRow
              key={p.repo}
              p={p}
              m={checks.get(p.repo)}
              ciOffer={slice.ciRepos.includes(p.repo)}
              mergeBusy={merging.has(p.repo)}
              dismissBusy={pending.dismiss.has(p.repo)}
              ciBusy={pending.ci}
              mergeOpen={openMerge.has(p.repo)}
              onMergeToggle={toggleMerge}
              api={api}
            />
          ))
        )}
      </RegionPortal>
    </>
  );
});
