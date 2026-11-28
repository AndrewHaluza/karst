/**
 * COMPONENT-mode test for the Channels tab (T1405, `@arch:CHANNEL-MAP`).
 *
 * Proves the wiring and the prototype's region order, plus the two facts the
 * ticket names: the antigravity view reads its MCP cell as "No" with the real
 * surface reason, and an unknown core falls back to the first core.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge } from '../testBridge.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { buildSettingsState } from '../../state.js';
import { ChannelsTab } from './ChannelsTab.js';
import type { AgentsRoute } from './agentsRoute.js';

afterEach(cleanup);

function mount(route: AgentsRoute, navigate = vi.fn()): { navigate: ReturnType<typeof vi.fn> } {
  const bridge = createTestBridge();
  const state = buildSettingsState(FIXTURE_MANIFEST as unknown as Manifest, null, [], true, ['claude'], [], {}, undefined, '/repo/karst.yml');
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <ChannelsTab route={route} navigate={navigate} />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state }));
  return { navigate };
}

const mcpCellOfFirstRow = (): HTMLElement =>
  document.querySelector('[data-region="channels-map"] tbody tr td[data-col="Karst MCP"]') as HTMLElement;

describe('ChannelsTab — the read-only map', () => {
  it('renders the three prototype regions in order', () => {
    mount({ tab: 'channels' });
    const regions = Array.from(document.querySelectorAll('[data-region]')).map((el) => el.getAttribute('data-region'));
    expect(regions).toEqual(['channels-layers', 'channels-core', 'channels-map']);
  });

  it('shows the three-layer legend and the map column heads', () => {
    mount({ tab: 'channels' });
    expect(screen.getByText('How agents talk to Karst')).toBeTruthy();
    for (const label of ['Commands', 'Signals', 'Messages']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('columnheader', { name: 'Karst MCP' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Parent / sub-task mail' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Ticket session' })).toBeTruthy();
  });

  it('reads the antigravity ticket MCP cell as No with the surface reason', () => {
    mount({ tab: 'channels', selected: 'antigravity' });
    expect(screen.getByRole('radio', { name: 'Antigravity' }).getAttribute('aria-checked')).toBe('true');
    const cell = mcpCellOfFirstRow();
    expect(cell.textContent).toContain('No');
    expect(cell.textContent).toContain('karst mcp install');
  });

  it('choosing another core navigates to its channels hash', () => {
    const { navigate } = mount({ tab: 'channels', selected: 'antigravity' });
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(navigate).toHaveBeenCalledWith({ tab: 'channels', selected: 'codex' });
  });

  it('falls back to the first core for an unknown hash value', () => {
    mount({ tab: 'channels', selected: 'retired-core' });
    expect(screen.getByRole('radio', { name: 'Claude' }).getAttribute('aria-checked')).toBe('true');
    expect(mcpCellOfFirstRow().textContent).toContain('Yes');
  });

  it('renders a muted line when the pushed state carries no channel map', () => {
    const bridge = createTestBridge();
    const state = buildSettingsState(FIXTURE_MANIFEST as unknown as Manifest);
    render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="agents">
          <ChannelsTab route={{ tab: 'channels' }} navigate={() => {}} />
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    act(() => bridge.push({ type: 'state', state: { ...state, channels: undefined } as never }));
    expect(screen.getByText('No channel data.')).toBeTruthy();
    expect(document.querySelector('[data-region="channels-map"]')).toBeNull();
  });
});
