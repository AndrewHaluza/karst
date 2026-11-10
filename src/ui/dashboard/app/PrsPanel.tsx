/**
 * The dashboard's Pull requests panel: a `Section` (count, summary, Refresh) of `PrRow`s rendered by React
 * into the static `.panel[data-region="prs"]` root in `webview.html` through `RegionPortal`.
 *
 * The operations in flight (dismiss, refresh) live in `usePrPending`, Merge and Send CI failure in `pendingOps.ts` (shared with the stage rail and the Inside stage menu); the merge-check
 * disclosures the user opened are panel state, so they outlive the line that holds them.
 */
import { memo, useCallback, useState } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { MERGE_ALL_NONE_READY, MERGE_ALL_ROUND_RUNNING } from '../../../model/mergeAll.js';
import { MergeAllButton, RefreshButton } from './PrActionButtons.js';
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
  /** The branch every worktree shares (shown once in the Worktrees header), or null. */
  readonly headerBranch: string | null;
  /** An auto-fix round runs now (Merge all is disabled meanwhile). */
  readonly roundRunning: boolean;
}

/** null before the first host snapshot: the body is empty. */
const selectPrs = (snapshot: DashboardSnapshot): PrsSlice | null => {
  const state = snapshot.state;
  if (!state) return null;
  return { prs: state.prs ?? [], headerBranch: sharedBranch(state.worktrees ?? null), roundRunning: state.autopilot?.roundRunning === true };
};

export interface MergeAllView {
  readonly label: string;
  readonly primary: boolean;
  /** Why the button is disabled, or null when it can be clicked. */
  readonly disabledWhy: string | null;
}

/** The header's Merge all: null below two open pull requests. The host re-checks every fact before it asks. */
export function mergeAllView(prs: DashboardState['prs'], roundRunning: boolean): MergeAllView | null {
  const open = prs.filter((p) => p.status !== 'merged' && p.status !== 'closed' && !p.dismissed);
  if (open.length < 2) return null;
  const ready = open.filter((p) => p.readiness.ready).length;
  const label = ready === open.length ? 'Merge all' : ready === 0 ? 'Merge all' : `Merge ${ready} ready`;
  const disabledWhy = roundRunning ? MERGE_ALL_ROUND_RUNNING : ready === 0 ? MERGE_ALL_NONE_READY : null;
  return { label, primary: ready > 0, disabledWhy };
}

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
  const prs = slice?.prs ?? [];
  const summary = prsSummary(prs);
  const mergeAll = mergeAllView(prs, slice?.roundRunning === true);
  return (
    <RegionPortal region="prs">
      <Section
        title="Pull requests"
        count={prs.length}
        summary={summary || null}
        summaryTitle={summary || undefined}
        bodyId="prs"
        // The refresh stays live even with zero PRs, and before the first snapshot: "none yet" is exactly the answer a user wants to re-ask right after a ship.
        actions={
          <>
            {mergeAll ? <MergeAllButton label={mergeAll.label} primary={mergeAll.primary} disabledWhy={mergeAll.disabledWhy} /> : null}
            <RefreshButton api={api} busy={pending.refreshing} />
          </>
        }
      >
        {slice === null ? null : prs.length === 0 ? (
          <EmptyState icon="git-pull-request" heading="No pull requests." sub="Ship opens one per repository with changes." />
        ) : (
          prs.map((p) => (
            <PrRow
              key={p.repo}
              p={p}
              headerBranch={slice.headerBranch}
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
