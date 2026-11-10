/**
 * The baseline review overlay's derived model (@arch:BASELINE-REVIEW): the host rows from the snapshot plus the
 * user's view drafts (`baselineDrafts.ts`) folded into what the overlay draws. Rows are HOST-DERIVED (UI-R31); only
 * the chip, the selection, the compare view and the zoom are the user's, and none of them reaches the host.
 */
import { useMemo } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { buildGroups, countRows, defaultView, effectiveFilter, filterRows, groupKey, normaliseRows, pickSelected, type Counts, type Filter, type Group, type Row, type View } from './baselineGroups.js';
import { useBaselineDraftsState } from './DashboardAppContext.js';
import { useSlice } from './useSlice.js';
import type { BaselineReviewRow } from '../baselineRows.js';

export interface BaselineSlice {
  readonly ticketLabel: string;
  readonly stageKey: string;
  readonly rows: readonly BaselineReviewRow[];
}

export const selectBaselines = (snapshot: DashboardSnapshot): BaselineSlice | null => {
  const s = snapshot.state;
  if (!s || s.currentStage?.blocked?.kind !== 'baseline-review') return null;
  return { ticketLabel: s.idLabel, stageKey: s.currentStage.stageKey, rows: s.baselineReview ?? [] };
};

export interface BaselineModel {
  readonly ticketLabel: string;
  readonly stageKey: string;
  readonly rows: readonly Row[];
  readonly counts: Counts;
  readonly filter: Filter;
  /** The rows the chip lets through, in list order. */
  readonly visible: readonly Row[];
  readonly groups: readonly Group[];
  readonly selected: Row | null;
  /** 1-based position of the selection in `visible`, 0 when there is none. */
  readonly position: number;
  readonly view: View;
  /** The pending entries of the selected entry's screenshot, across every theme. */
  readonly groupPending: readonly Row[];
}

export function useBaselineModel(): BaselineModel | null {
  const slice = useSlice(selectBaselines);
  const drafts = useBaselineDraftsState();
  return useMemo(() => {
    if (!slice) return null;
    const rows = normaliseRows(slice.rows);
    const counts = countRows(rows);
    const filter = effectiveFilter(drafts.filter, counts);
    const visible = filterRows(rows, filter);
    const selected = pickSelected(visible, drafts.selected);
    const name = selected ? groupKey(selected.label) : null;
    return {
      ticketLabel: slice.ticketLabel,
      stageKey: slice.stageKey,
      rows,
      counts,
      filter,
      visible,
      groups: buildGroups(visible),
      selected,
      position: selected ? visible.indexOf(selected) + 1 : 0,
      view: selected ? (drafts.views[selected.index] ?? defaultView(selected.status)) : 'diff',
      groupPending: name === null ? [] : rows.filter((r) => groupKey(r.label) === name && r.decision === 'pending'),
    };
  }, [slice, drafts.filter, drafts.selected, drafts.views]);
}
