/**
 * The Tickets pane: the filter funnel and `+` in the header, the "N need you ·
 * M blocked" shortcut under it (All only, only when a count is above zero), and
 * the ticket list as the scrolling body.
 */
import { ActButton } from './action.js';
import { FilterMenu } from './FilterMenu.js';
import { allRows } from './format.js';
import { Icon } from './Icon.js';
import { Pane } from './Pane.js';
import { activePreset } from './presets.js';
import { useSidebar } from './SidebarContext.js';
import { TicketList } from './TicketList.js';

function AttentionLine() {
  const { state, applyPreset } = useSidebar();
  const input = state.counts?.input ?? 0;
  const failed = state.counts?.failed ?? 0;
  if (activePreset(state.facets || ['all'])?.id !== 'all' || (input === 0 && failed === 0)) return null;
  return (
    <button type="button" className="pane-attention" data-attention="1" onClick={() => applyPreset('attention')}>
      {input} need you · {failed} blocked
    </button>
  );
}

export function TicketsPane() {
  const { state } = useSidebar();
  const actions = (
    <>
      <FilterMenu />
      <ActButton spec={{ act: 'create' }} className="k-iconbtn" aria-label="Create ticket" title="Create ticket">
        <Icon name="plus" />
      </ActButton>
    </>
  );
  return (
    <Pane pane="tickets" title="Tickets" count={allRows(state).length} actions={actions} sub={<AttentionLine />}>
      <TicketList />
    </Pane>
  );
}
