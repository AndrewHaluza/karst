/**
 * The dashboard's Sub-tasks panel, rendered by React into the page's existing containers
 * (`#subtaskCount`, the header after it, `#subtasks`) through `RegionPortal`s. Same DOM as the
 * vanilla renderer it replaced (`renderSubtasks`, `subtaskRowHtml`). The awaiting-subtask header
 * chip (`#subtaskWait`) is not part of this panel: it stays vanilla until the header slice.
 */
import { memo, useLayoutEffect, useRef } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { SubtaskRow, type SubtaskRowData } from './SubtaskRow.js';
import { Icon } from './Icon.js';
import { RegionPortal } from './RegionPortal.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';
import './SubtasksPanel.css';

interface SubtasksSlice {
  readonly subtasks: readonly SubtaskRowData[];
  readonly parentKey: string;
  readonly done: number;
  readonly total: number;
  readonly canAdd: boolean;
}

/** null before the first host snapshot: the panel stays hidden and empty. */
const selectSubtasks = (snapshot: DashboardSnapshot): SubtasksSlice | null =>
  snapshot.state
    ? {
        subtasks: snapshot.state.subtasks ?? [],
        parentKey: snapshot.state.key ?? '',
        done: snapshot.state.subtaskProgress?.done ?? 0,
        total: snapshot.state.subtaskProgress?.total ?? 0,
        canAdd: !!snapshot.state.canAddSubtask,
      }
    : null;

type Seg = 'passed' | 'running' | 'failed' | 'rest';
const SEGMENTS: readonly Seg[] = ['passed', 'running', 'failed', 'rest'];

const segOf = (s: SubtaskRowData): Seg =>
  s.done ? 'passed' : s.fault ? 'failed' : s.glyph === 'blue' || s.glyph === 'amber' ? 'running' : 'rest';

/** The 72px segmented bar: done / running / blocked / the rest, proportional by sub-task count. Decoration only. */
function Progress({ subtasks }: { readonly subtasks: readonly SubtaskRowData[] }) {
  if (!subtasks.length) return null;
  const counts = new Map<Seg, number>();
  for (const s of subtasks) counts.set(segOf(s), (counts.get(segOf(s)) ?? 0) + 1);
  return (
    <span className="subtask-progress" aria-hidden="true">
      {SEGMENTS.filter((k) => counts.has(k)).map((k) => (
        <span key={k} className={`seg seg--${k}`} style={{ flexGrow: counts.get(k) }} />
      ))}
    </span>
  );
}

/**
 * The button never changes its className: a runtime-pending control keeps the runtime's `is-pending`
 * class, which React rewriting `className` would wipe. Visibility is toggled on the DOM node instead.
 */
function AddButton({ canAdd }: { readonly canAdd: boolean }) {
  const send = useDashboardSend();
  const ref = useRef<HTMLButtonElement>(null);
  const onClick = usePendingAction((requestId) => send.createSubtask(requestId));
  useLayoutEffect(() => {
    ref.current?.classList.toggle('hidden', !canAdd);
  }, [canAdd]);
  return (
    <button
      ref={ref}
      id="addSubtask"
      type="button"
      className="k-btn k-btn--ghost k-btn--sm"
      data-act="create-subtask"
      aria-label="Add sub-task"
      title="Create a sub-task under this ticket"
      onClick={onClick}
    >
      <Icon name="plus" size={14} />
      <span className="k-btn-label">Add sub-task</span>
    </button>
  );
}

export const SubtasksPanel = memo(function SubtasksPanel() {
  const slice = useSlice(selectSubtasks);
  const subtasks = slice?.subtasks ?? [];
  const canAdd = slice?.canAdd ?? false;
  const hidden = subtasks.length === 0 && !canAdd;
  // The panel root is static in webview.html (the region parity snapshot pins it as markup), so its visibility is
  // toggled on the node here.
  useLayoutEffect(() => {
    document.getElementById('subtaskPanel')?.classList.toggle('hidden', hidden);
  }, [hidden]);
  return (
    <>
      <RegionPortal id="subtaskCount">{slice?.total ? `${slice.done}/${slice.total} done` : null}</RegionPortal>
      <RegionPortal id="subtaskCount" inParent>
        <Progress subtasks={subtasks} />
        <AddButton canAdd={canAdd} />
      </RegionPortal>
      <RegionPortal id="subtasks">
        {slice ? (
          subtasks.length ? (
            subtasks.map((s) => <SubtaskRow key={s.id} s={s} parentKey={slice?.parentKey ?? ''} />)
          ) : (
            <div className="subtask-empty">No sub-tasks yet. Add one to split off unfinished work.</div>
          )
        ) : null}
      </RegionPortal>
    </>
  );
});
