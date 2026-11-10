/**
 * The dashboard's Pull requests panel: a `Section` (count, summary, Refresh) of `PrRow`s rendered by React
 * into the static `.panel[data-region="prs"]` root in `webview.html` through `RegionPortal`.
 *
 * The operations in flight (dismiss, refresh) live in `usePrPending`, Merge and Send CI failure in `pendingOps.ts` (shared with the stage rail and the Inside stage menu); the merge-check
 * disclosures the user opened are panel state, so they outlive the line that holds them.
 */
import { memo, useCallback, useState } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { RefreshButton } from './PrActionButtons.js';
import { PrRow } from './PrRow.js';
import { useOps } from './DashboardAppContext.js';
import { EmptyState } from './EmptyState.js';
import { RegionPortal } from './RegionPortal.js';
import { Section } from './Section.js';
import { sharedBranch } from './WorktreesPanel.js';
import './Section.css';
import { useSlice } from './useSlice.js';
import { usePrPending } from './usePrPending.js';
import type { DashboardState } from '../state.js';
import './PrsPanel.css';

interface PrsSlice {
  readonly prs: DashboardState['prs'];
  readonly mergeChecks: DashboardState['mergeChecks'];
  /** Repos whose failing CI the host offers to send to the agent (empty when unavailable). */
  readonly ciRepos: readonly string[];
  /** The branch every worktree shares (shown once in the Worktrees header), or null. */
  readonly headerBranch: string | null;
}

/** null before the first host snapshot: the body is empty. */
const selectPrs = (snapshot: DashboardSnapshot): PrsSlice | null => {
  const state = snapshot.state;
  if (!state) return null;
  const ci = state.ciFailure;
  return { prs: state.prs ?? [], mergeChecks: state.mergeChecks ?? [], ciRepos: ci && ci.available ? ci.repos : [], headerBranch: sharedBranch(state.worktrees ?? null) };
};

/** `N ready · N blocked · N dismissed`, non-zero parts only. A merged PR counts as none of them. */
export function prsSummary(prs: DashboardState['prs']): string {
  const open = prs.filter((p) => p.status !== 'merged');
  const dismissed = open.filter((p) => p.dismissed).length;
  const live = open.filter((p) => !p.dismissed);
  const ready = live.filter((p) => p.canMerge).length;
  const parts: Array<readonly [number, string]> = [
    [ready, 'ready'],
    [live.length - ready, 'blocked'],
    [dismissed, 'dismissed'],
  ];
  return parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(' · ');
}

export const PrsPanel = memo(function PrsPanel() {
  const slice = useSlice(selectPrs);
  const { pending, api } = usePrPending();
  // Merge and Send CI failure are held in the state the stage rail's Merge and the Inside stage menu share (pendingOps.ts).
  const { merging, running } = useOps();
  const [openMerge, toggleMerge] = useOpenSet();
  const [openInfo, toggleInfo] = useOpenSet();
  const checks = new Map((slice?.mergeChecks ?? []).map((m) => [m.repo, m]));
  const prs = slice?.prs ?? [];
  const summary = prsSummary(prs);
  return (
    <RegionPortal region="prs">
      <Section
        title="Pull requests"
        count={prs.length}
        summary={summary || null}
        summaryTitle={summary || undefined}
        bodyId="prs"
        // The refresh stays live even with zero PRs, and before the first snapshot: "none yet" is exactly the answer a user wants to re-ask right after a ship.
        actions={<RefreshButton api={api} busy={pending.refreshing} />}
      >
        {slice === null ? null : prs.length === 0 ? (
          <EmptyState icon="git-pull-request" heading="No pull requests." sub="Ship opens one per repository with changes." />
        ) : (
          prs.map((p) => (
            <PrRow
              key={p.repo}
              p={p}
              m={checks.get(p.repo)}
              headerBranch={slice.headerBranch}
              ciOffer={slice.ciRepos.includes(p.repo)}
              mergeBusy={merging.has(p.repo)}
              dismissBusy={pending.dismiss.has(p.repo)}
              ciBusy={running.has('ci')}
              mergeOpen={openMerge.has(p.repo)}
              infoOpen={openInfo.has(p.repo)}
              onMergeToggle={toggleMerge}
              onInfoToggle={toggleInfo}
              api={api}
            />
          ))
        )}
      </Section>
    </RegionPortal>
  );
});

/** A set of repo keys the user opened (merge disclosures, info popovers): panel state, so it outlives the line. */
function useOpenSet(): readonly [ReadonlySet<string>, (repo: string, open: boolean) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (repo: string, next: boolean) =>
      setOpen((current) => {
        if (current.has(repo) === next) return current;
        const copy = new Set(current);
        if (next) copy.add(repo);
        else copy.delete(repo);
        return copy;
      }),
    [],
  );
  return [open, toggle];
}
