/**
 * The Planning pane: sessions and their drafts as a tree. Independent of the
 * Tickets presets. Archived sessions arrive with the snapshot and are listed
 * only while the header's "show archived" toggle is on (view state).
 */
import { ActButton } from './action.js';
import { Icon } from './Icon.js';
import { Pane } from './Pane.js';
import { PlanningTree } from './PlanningTree.js';
import { useSidebar } from './SidebarContext.js';

export function PlanningPane() {
  const { state, view, toggleShowArchivedPlans, collapseAllPlans } = useSidebar();
  const all = state.planning || [];
  const archived = all.filter((p) => p.status === 'archived').length;
  const plans = view.showArchivedPlans ? all : all.filter((p) => p.status !== 'archived');
  const actions = (
    <>
      {archived > 0 ? (
        <button
          type="button"
          className="k-iconbtn"
          data-show-archived="1"
          aria-pressed={view.showArchivedPlans}
          aria-label="Show archived planning sessions"
          title={view.showArchivedPlans ? `Hide ${archived} archived` : `Show ${archived} archived`}
          onClick={toggleShowArchivedPlans}
        >
          <Icon name="archive" />
        </button>
      ) : null}
      <button type="button" className="k-iconbtn" data-plan-collapse-all="1" aria-label="Collapse all planning sessions" title="Collapse all" onClick={collapseAllPlans}>
        <Icon name="chevrons-up" />
      </button>
      <ActButton spec={{ act: 'plan-create' }} className="k-iconbtn" aria-label="Start planning session" title="Start planning session">
        <Icon name="plus" />
      </ActButton>
    </>
  );
  return (
    <Pane pane="planning" title="Planning" count={plans.length} actions={actions}>
      {plans.length ? <PlanningTree plans={plans} /> : <div className="pane-empty">No planning sessions</div>}
    </Pane>
  );
}
