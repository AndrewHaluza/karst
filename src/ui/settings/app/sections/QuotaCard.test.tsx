/**
 * COMPONENT-mode tests for the Subscription quota card on the Accounts tab (D707).
 * The fields are manifest edits: they mark the draft and Save writes them.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider, useSettingsApp } from '../SettingsAppContext.js';
import { createTestBridge } from '../testBridge.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { buildSettingsState } from '../../state.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';
import { AccountsTab } from './AccountsTab.js';

afterEach(cleanup);

const BASE = { ...FIXTURE_MANIFEST } as unknown as Manifest;

function mount(manifest: Manifest = BASE): { probe: () => AppProbeShape } {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <AccountsTab route={{ tab: 'accounts' }} navigate={() => {}} />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() =>
    bridge.push({
      type: 'state',
      state: buildSettingsState(manifest, null, [], true, ['claude'], [], {}, undefined, '/repo/karst.yml'),
    }),
  );
  return { probe: () => readProbe(view.baseElement) };
}

const draftOf = (probe: () => AppProbeShape): Manifest => probe().draft as Manifest;

describe('Subscription quota card', () => {
  it('renders the warn threshold with the loader default as its placeholder', () => {
    mount();
    const field = screen.getByLabelText('Warn at used %') as HTMLInputElement;
    expect(field.getAttribute('type')).toBe('number');
    expect(field.getAttribute('min')).toBe('1');
    expect(field.getAttribute('max')).toBe('100');
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('80');
  });

  it('writes the threshold as a whole number from 1 to 100', () => {
    const { probe } = mount();
    fireEvent.change(screen.getByLabelText('Warn at used %'), { target: { value: '95' } });
    expect(draftOf(probe)).toMatchObject({ quota: { warnThresholdPct: 95 } });
  });

  it('snaps an out-of-range threshold back to blank and flags it inline', () => {
    const { probe } = mount();
    const field = screen.getByLabelText('Warn at used %') as HTMLInputElement;
    for (const bad of ['0', '101', '2.5']) {
      fireEvent.change(field, { target: { value: '90' } });
      fireEvent.change(field, { target: { value: bad } });
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(probe().draft).not.toHaveProperty('quota');
    }
    fireEvent.change(field, { target: { value: '80' } });
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('renders the global Claude statusline install OFF by default', () => {
    mount();
    const toggle = screen.getByLabelText('Install for all Claude sessions') as HTMLInputElement;
    expect(toggle.getAttribute('type')).toBe('checkbox');
    expect(toggle.checked).toBe(false);
  });

  it('writes the opt-in flag while preserving the warn threshold', () => {
    const { probe } = mount({ ...BASE, quota: { warnThresholdPct: 95 } } as unknown as Manifest);
    fireEvent.click(screen.getByLabelText('Install for all Claude sessions'));
    expect(draftOf(probe).quota).toEqual({ warnThresholdPct: 95, claudeGlobalStatusline: true });
  });

  it('writes OFF when the installed toggle is turned off', () => {
    const { probe } = mount({
      ...BASE,
      quota: { warnThresholdPct: 95, claudeGlobalStatusline: true },
    } as unknown as Manifest);
    const toggle = screen.getByLabelText('Install for all Claude sessions') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(draftOf(probe).quota).toEqual({ warnThresholdPct: 95, claudeGlobalStatusline: false });
  });

  it('renders the Claude usage API fallback OFF by default', () => {
    mount();
    const toggle = screen.getByLabelText('Use the Claude usage API') as HTMLInputElement;
    expect(toggle.getAttribute('type')).toBe('checkbox');
    expect(toggle.checked).toBe(false);
  });

  it('writes the usage API opt-in while preserving the other quota settings', () => {
    const { probe } = mount({
      ...BASE,
      quota: { warnThresholdPct: 95, claudeGlobalStatusline: true },
    } as unknown as Manifest);
    fireEvent.click(screen.getByLabelText('Use the Claude usage API'));
    expect(draftOf(probe).quota).toEqual({
      warnThresholdPct: 95,
      claudeGlobalStatusline: true,
      claudeOauthUsageApi: true,
    });
  });

  it('writes OFF when the usage API toggle is turned off', () => {
    const { probe } = mount({
      ...BASE,
      quota: { warnThresholdPct: 95, claudeOauthUsageApi: true },
    } as unknown as Manifest);
    const toggle = screen.getByLabelText('Use the Claude usage API') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(draftOf(probe).quota).toEqual({ warnThresholdPct: 95, claudeOauthUsageApi: false });
  });
});

describe('Subscription quota card — placement', () => {
  it('is its own card with the Save note, apart from the accounts note', () => {
    mount();
    const card = document.querySelector('[data-region="accounts-quota"]') as HTMLElement;
    expect(card.querySelector('h3')!.textContent).toBe('Subscription quota');
    expect(card.textContent).toContain('Saved with Save Agents.');
    expect(card.textContent).not.toMatch(/apply at once/i);
  });

  it('marks the Agents draft dirty when a field changes', () => {
    const { probe } = mount();
    expect(probe().draft).not.toHaveProperty('quota');
    fireEvent.change(screen.getByLabelText('Warn at used %'), { target: { value: '90' } });
    expect(draftOf(probe).quota).toEqual({ warnThresholdPct: 90 });
  });
});

describe('Subscription quota card — Discard', () => {
  it('clears the threshold error when Discard restores the saved value', () => {
    const bridge = createTestBridge();
    render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="agents">
          <AccountsTab route={{ tab: 'accounts' }} navigate={() => {}} />
          <DiscardButton />
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    act(() =>
      bridge.push({
        type: 'state',
        state: buildSettingsState({ ...FIXTURE_MANIFEST, quota: { warnThresholdPct: 95 } } as unknown as Manifest, null, [], true, ['claude'], [], {}, undefined, '/repo/karst.yml'),
      }),
    );
    const field = screen.getByLabelText('Warn at used %') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '101' } });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'test-discard' }));
    expect(field.value).toBe('95');
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });
});

function DiscardButton() {
  const { discard } = useSettingsApp();
  return <button type="button" onClick={() => discard('agents')}>test-discard</button>;
}
