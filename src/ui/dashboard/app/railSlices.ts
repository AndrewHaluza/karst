/**
 * The slice of the host snapshot the stage rail renders (`useSlice` needs a module-level selector). Compared
 * structurally, so the 1 Hz full-snapshot push re-renders the rail only when a segment, the approach or the
 * default selection actually changed.
 */
import type { DashboardSnapshot } from './dashboardStore.js';
import type { Approach, RailSeg } from './railText.js';

export interface RailSlice {
  readonly main: readonly RailSeg[];
  readonly approach: Approach | null;
  readonly presentedStage: string;
  readonly stageCurrent: string;
  /** The current stage is blocked on a kind the strip renders (resumable fault, usage-limit). */
  readonly faulted: boolean;
}

/** The blocks the banner draws as a strip: a resumable fault or a usage-limit park. */
export const isStripBlock = (b: { readonly kind: string; readonly resumable?: boolean } | null | undefined): boolean =>
  !!b && b.kind !== 'baseline-review' && b.kind !== 'awaiting-merge' && (b.resumable !== false || b.kind === 'usage-limit');

/** null before the first host snapshot: the rail is empty. */
export const selectRail = (snapshot: DashboardSnapshot): RailSlice | null => {
  const s = snapshot.state;
  if (!s) return null;
  return {
    main: s.rail?.main ?? [],
    approach: s.approach ?? null,
    presentedStage: s.presentedStage || '',
    stageCurrent: s.stageCurrent || '',
    faulted: isStripBlock(s.currentStage?.blocked),
  };
};
