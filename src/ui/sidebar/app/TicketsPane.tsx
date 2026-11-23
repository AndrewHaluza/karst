/**
 * The Tickets pane: the filter funnel and `+` in the header, the "N need you ·
 * M failed" shortcut and the active-filter line under it, and the ticket list as
 * the scrolling body. The header count reads `shown / total` while a preset or a
 * search is active (SB-9), like the Queue pane.
 */
import { plural } from '../../../model/notifyText.js';
import { GLYPH_WORD } from '../../../model/glyph.js';
import type { SidebarState } from '../state.js';
import { ActButton } from './action.js';
import { FilterMenu } from './FilterMenu.js';
import { allRows } from './format.js';
import { Icon } from './Icon.js';
import { Pane } from './Pane.js';
import { activePreset, PRESETS, type PresetId } from './presets.js';
import { useSidebar } from './SidebarContext.js';
import { TicketList } from './TicketList.js';

/** The unfiltered total of the active facet selection (the header's `total`). */
function totalFor(state: SidebarState): number {
  const sel = state.facets || ['all'];
  const counts = state.counts || {};
  if (sel.includes('archived')) return counts.archived ?? 0;
  if (sel.includes('all')) return counts.all ?? 0;
  return sel.reduce((n, facet) => n + (counts[facet] ?? 0), 0);
}

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

/** "Showing: <preset> · Clear" while a preset or the search narrows the list (SB-9). */
function FilterLine() {
  const { state, clearTicketFilters } = useSidebar();
  const preset = activePreset(state.facets || ['all']);
  const query = (state.filter || '').trim();
  if (preset?.id === 'all' && query === '') return null;
  const parts: string[] = [];
  if (preset && preset.id !== 'all') parts.push(preset.label);
  else if (!preset) parts.push('Custom');
  if (query) parts.push(`“${query}”`);
  return (
    <div className="filter-line" data-filter-line="1">
      <span className="filter-line-text">Showing: {parts.join(' · ')}</span>
      <button type="button" className="k-link" data-clear-filters="1" onClick={clearTicketFilters}>Clear</button>
    </div>
  );
}

export function TicketsPane() {
  const { state, applyPreset } = useSidebar();
  const current = activePreset(state.facets || ['all']);
  const filtered = current?.id !== 'all';
  const active = filtered || (state.filter || '').trim() !== '';
  const shown = allRows(state).length;
  const count = active ? `${shown} / ${totalFor(state)}` : shown;
  const actions = (
    <>
      <FilterMenu
        options={PRESETS}
        value={current?.id ?? null}
        filtered={filtered}
        onChange={(id) => applyPreset(id as PresetId)}
        label="Filter tickets"
        menuLabel="Ticket filter"
        triggerAttr="data-filter-menu"
        optionAttr="data-preset"
        dotAttr="data-filter-dot"
      />
      <ActButton spec={{ act: 'create' }} className="k-iconbtn" aria-label="Create ticket" title="Create ticket">
        <Icon name="plus" />
      </ActButton>
    </>
  );
  // Unlinked cloud sessions have their own section under the rows, so the pane is
  // not empty while they exist even though the count (`allRows`) counts tickets.
  const showsCloud = (state.unlinkedCloudSessions?.length ?? 0) > 0;
  return (
    <Pane
      pane="tickets"
      title="Tickets"
      count={count}
      actions={actions}
      empty={shown === 0 && !showsCloud}
      sub={<><AttentionLine /><FilterLine /></>}
    >
      <TicketList />
    </Pane>
  );
}
