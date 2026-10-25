/**
 * The dashboard's Sub-tasks panel, rendered by React into the page's existing containers
 * (`#subtaskCount`, the header after it, `#subtasks`) through `RegionPortal`s. Same DOM as the
 * vanilla renderer it replaced (`renderSubtasks`, `subtaskRowHtml`). The awaiting-subtask header
 * chip (`#subtaskWait`) is not part of this panel: it stays vanilla until the header slice.
 */
import { memo, useLayoutEffect, useRef } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { RegionPortal } from './RegionPortal.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';
import './SubtasksPanel.css';

interface SubtaskRow {
  readonly id: number;
  readonly idLabel: string;
  readonly key: string;
  readonly title: string | null;
  readonly stage: string | null;
  readonly glyph: string;
  readonly stageClass: string;
  readonly blocking: boolean;
  readonly done: boolean;
  readonly autostart: string | null;
}

interface SubtasksSlice {
  readonly subtasks: readonly SubtaskRow[];
  readonly done: number;
  readonly total: number;
  readonly canAdd: boolean;
}

/** null before the first host snapshot: the panel stays hidden and empty. */
const selectSubtasks = (snapshot: DashboardSnapshot): SubtasksSlice | null =>
  snapshot.state
    ? {
        subtasks: snapshot.state.subtasks ?? [],
        done: snapshot.state.subtaskProgress?.done ?? 0,
        total: snapshot.state.subtaskProgress?.total ?? 0,
        canAdd: !!snapshot.state.canAddSubtask,
      }
    : null;

// The status glyph a row paints: the shipped `.k-dot` primitive, recoloured per state. `gray` (no signal yet) keeps the ringless default.
const DOT: Record<string, string> = { blue: 'k-dot--running', amber: 'k-dot--attention', green: 'k-dot--passed', red: 'k-dot--failed' };

// `autostart` is host-derived (UI-R31): a sub-task waiting at scope for the autostart sweep reads "Queued", one being started "Starting".
const AUTOSTART_WORD: Record<string, string> = { queued: 'Queued', starting: 'Starting' };

const Row = memo(function Row({ s }: { readonly s: SubtaskRow }) {
  const stage = (s.autostart ? AUTOSTART_WORD[s.autostart] : undefined) || s.stage || 'none';
  const dot = DOT[s.glyph];
  return (
    <div className="subtask" data-id={s.id}>
      <span className={dot ? `k-dot ${dot}` : 'k-dot'} role="img" aria-label={s.done ? 'done' : stage} />
      <span className="k-id">{s.idLabel}</span>
      <span className="subtask-key">{s.key}</span>
      <span className="subtask-title">{s.title || '(untitled)'}</span>
      {s.blocking ? (
        <span className="subtaskBlock" title="Holds the parent before it leaves implement">
          Blocking
        </span>
      ) : null}
      <span className={`stage ${s.stageClass}`} title={stage}>
        {stage}
      </span>
    </div>
  );
});

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
      title="Create a sub-task under this ticket"
      onClick={onClick}
    >
      Add sub-task…
    </button>
  );
}

export const SubtasksPanel = memo(function SubtasksPanel() {
  const slice = useSlice(selectSubtasks);
  const subtasks = slice?.subtasks ?? [];
  const canAdd = slice?.canAdd ?? false;
  const hidden = subtasks.length === 0 && !canAdd;
  // TRANSITIONAL (until the shell owns the grid, plan Phase 12): the panel root is static in webview.html, because the
  // region parity snapshot pins it without any data-* attribute, so its visibility is toggled on the node here.
  useLayoutEffect(() => {
    document.getElementById('subtaskPanel')?.classList.toggle('hidden', hidden);
  }, [hidden]);
  return (
    <>
      <RegionPortal id="subtaskCount">{slice?.total ? `${slice.done}/${slice.total} done` : null}</RegionPortal>
      <RegionPortal id="subtaskCount" inParent>
        <AddButton canAdd={canAdd} />
      </RegionPortal>
      <RegionPortal id="subtasks">
        {slice ? (
          subtasks.length ? (
            subtasks.map((s) => <Row key={s.id} s={s} />)
          ) : (
            <div className="subtask-empty">No sub-tasks yet. Add one to split off unfinished work.</div>
          )
        ) : null}
      </RegionPortal>
    </>
  );
});
