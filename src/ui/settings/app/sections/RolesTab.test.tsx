// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import type { Manifest } from '../../../../manifest/types.js';
import type { AgentsRoute } from './agentsRoute.js';
import { RolesTab } from './RolesTab.js';

const MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  agentProvider: 'opencode',
  defaultModel: 'deepseek',
  activeAgentPreset: 'Preset1',
  agentPresets: {
    Preset1: {
      slots: { planning: { provider: 'claude', model: 'claude-opus-5' } },
    },
    Preset2: {
      slots: { planning: { provider: 'antigravity', model: 'gemini-3.8-flash' } },
    },
  },
};

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = () => {};
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as Record<string, unknown>).mountAgentPicker;
  delete (globalThis as unknown as Record<string, unknown>).AP_ROUTES;
});

function mount(route: AgentsRoute = { tab: 'roles' }) {
  const bridge = createTestBridge();
  const navigate = vi.fn();
  const result = render(
    <SettingsAppProvider bridge={bridge} initialSection="agents">
      <RolesTab route={route} navigate={navigate} />
    </SettingsAppProvider>,
  );
  act(() => {
    bridge.push({
      type: 'state',
      state: buildSettingsState(MANIFEST),
    });
  });
  return { ...result, navigate };
}

describe('RolesTab — presets toolbar and compare bar', () => {
  it('renders compare controls inside the toolbar compare group with updated labels', () => {
    mount();

    // Group exists
    const compareGroup = screen.getByRole('group', { name: 'Compare' });
    expect(compareGroup).toBeDefined();

    // Select has label "Compare"
    const compareSelect = screen.getByRole('combobox', { name: 'Compare' });
    expect(compareSelect).toBeDefined();

    // Empty option is "None"
    const options = Array.from(compareSelect.querySelectorAll('option'));
    expect(options[0]!.textContent).toBe('None');

    // Matrix button is "Show all presets" with ghost variant
    const showMatrixBtn = screen.getByRole('button', { name: 'Show all presets' });
    expect(showMatrixBtn).toBeDefined();
    expect(showMatrixBtn.className).toContain('k-btn--ghost');
    expect(showMatrixBtn.className).toContain('k-btn--lg');
  });

  it('renders diffs summary, Only show differences, and Swap A/B button when compare preset is selected', () => {
    mount({ tab: 'roles', compare: 'Preset2' });

    expect(screen.getByRole('status').textContent).toContain('roles differ');
    expect(screen.getByLabelText('Only show differences')).toBeDefined();
    const swapBtn = screen.getByRole('button', { name: 'Swap A/B' });
    expect(swapBtn.className).toContain('k-btn--ghost');
    expect(swapBtn.className).toContain('k-btn--lg');
  });

  it('toggles matrix when Show all presets is clicked', () => {
    mount();
    const showMatrixBtn = screen.getByRole('button', { name: 'Show all presets' });
    expect(showMatrixBtn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Presets matrix')).toBeNull();

    fireEvent.click(showMatrixBtn);
    expect(showMatrixBtn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('RolesTab — route identity reaches every picker', () => {
  it('passes the host route map into the picker options', () => {
    const routes = { openrouter: { name: 'OpenRouter' } };
    const seen: unknown[] = [];
    (globalThis as unknown as Record<string, unknown>).AP_ROUTES = routes;
    (globalThis as unknown as Record<string, unknown>).mountAgentPicker = (
      _root: HTMLElement,
      opts: { routes?: unknown },
    ) => {
      seen.push(opts.routes);
    };

    mount();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual(routes);
  });
});
