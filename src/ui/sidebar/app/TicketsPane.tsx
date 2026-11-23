/**
 * The Tickets pane: the filter funnel and `+` in the header, the "N need you ·
 * M failed" shortcut under it (All only, only when a count is above zero; one
 * input reads "1 needs you", and a zero part is hidden), and the ticket list as
 * the scrolling body.
 */
import { plural } from '../../../model/notifyText.js';
import { GLYPH_WORD } from '../../../model/glyph.js';
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
  const parts: string[] = [];
  if (input > 0) parts.push(plural(input, 'needs you', 'need you'));
  // The red word comes from the shared table (RD-2, SB-13), so the header and the
  // badge tooltip name the same state; `summary.text` keeps the union count (D746).
  if (failed > 0) parts.push(`${failed} ${GLYPH_WORD.red.toLowerCase()}`);
  return (
    <button type="button" className="pane-attention" data-attention="1" onClick={() => applyPreset('attention')}>
      {parts.join(' · ')}
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
  // Unlinked cloud sessions have their own section under the rows, so the pane is
  // not empty while they exist even though the count (`allRows`) counts tickets.
  const showsCloud = (state.unlinkedCloudSessions?.length ?? 0) > 0;
  return (
    <Pane pane="tickets" title="Tickets" count={allRows(state).length} actions={actions} empty={allRows(state).length === 0 && !showsCloud} sub={<AttentionLine />}>
      <TicketList />
    </Pane>
  );
}
