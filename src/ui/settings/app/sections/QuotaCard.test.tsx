/**
 * COMPONENT-mode tests for the Subscription quota card on the Accounts tab.
 *
 * Q4-SAVE: these three settings apply AT ONCE through `set-quota` (they are not
 * part of the Agents Save). The threshold commits on blur or Enter, never per
 * keystroke; the host's `quota-saved` acknowledgement places a "Saved" note
 * beside the control that produced it.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { buildSettingsState } from '../../state.js';
import { SAVED_ACK_MS } from './AppShell.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';
import { AccountsTab } from './AccountsTab.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const BASE = { ...FIXTURE_MANIFEST } as unknown as Manifest;

function mount(manifest: Manifest = BASE): { bridge: TestBridge; probe: () => AppProbeShape } {
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
  return { bridge, probe: () => readProbe(view.baseElement) };
}

const threshold = (): HTMLInputElement => screen.getByLabelText('Warn at % used') as HTMLInputElement;
const lastQuota = (bridge: TestBridge) => bridge.last('set-quota') as { patch: Record<string, unknown> } | undefined;

describe('Subscription quota card — the threshold saves on change (Q4-SAVE)', () => {
  it('renders the threshold with the loader default as its placeholder', () => {
    mount();
    const field = threshold();
    expect(field.getAttribute('type')).toBe('number');
    expect(field.getAttribute('min')).toBe('1');
    expect(field.getAttribute('max')).toBe('100');
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('80');
    expect(screen.getByText('Warn at % used')).toBeTruthy();
  });

  it('typing alone posts nothing and leaves the draft alone', () => {
    const { bridge } = mount();
    fireEvent.change(threshold(), { target: { value: '95' } });
    expect(bridge.last('set-quota')).toBeUndefined();
    expect(screen.queryByRole('button', { name: /saved/i })).toBeNull();
  });

  it('commits a whole number on blur', () => {
    const { bridge } = mount();
    const field = threshold();
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.blur(field);
    expect(lastQuota(bridge)?.patch).toEqual({ warnThresholdPct: 90 });
  });

  it('commits on Enter with the live value', () => {
    const { bridge } = mount();
    const field = threshold();
    fireEvent.change(field, { target: { value: '70' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(lastQuota(bridge)?.patch).toEqual({ warnThresholdPct: 70 });
  });

  it('flags an invalid value inline and posts nothing', () => {
    const { bridge } = mount();
    const field = threshold();
    for (const bad of ['0', '101', '2.5']) {
      fireEvent.change(field, { target: { value: bad } });
      fireEvent.blur(field);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByText('Enter a whole number from 1 to 100.')).toBeTruthy();
      expect(bridge.last('set-quota')).toBeUndefined();
    }
    fireEvent.change(field, { target: { value: '80' } });
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('posts nothing when the committed value did not change', () => {
    const { bridge } = mount({ ...BASE, quota: { warnThresholdPct: 90 } } as unknown as Manifest);
    const field = threshold();
    expect(field.value).toBe('90');
    fireEvent.blur(field);
    expect(bridge.last('set-quota')).toBeUndefined();
  });

  it('a blank value deletes the key only when one is set', () => {
    const defined = mount({ ...BASE, quota: { warnThresholdPct: 90 } } as unknown as Manifest);
    fireEvent.change(threshold(), { target: { value: '' } });
    fireEvent.blur(threshold());
    expect(lastQuota(defined.bridge)?.patch).toEqual({ warnThresholdPct: null });
    cleanup();
    const blank = mount();
    fireEvent.blur(threshold());
    expect(blank.bridge.last('set-quota')).toBeUndefined();
  });

  it('shows "Saved" next to the threshold after the host acknowledges, then hides it', () => {
    vi.useFakeTimers();
    const { bridge } = mount();
    fireEvent.change(threshold(), { target: { value: '90' } });
    fireEvent.blur(threshold());
    const sent = bridge.last('set-quota')!;
    act(() => {
      bridge.push({ type: 'quota-saved', patch: { warnThresholdPct: 90 } });
      bridge.push({ type: 'action-result', requestId: sent.requestId!, ok: true });
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('Saved').getAttribute('role')).toBe('status');
    act(() => vi.advanceTimersByTime(SAVED_ACK_MS));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('exposes aria-busy while pending and drops the Enter-then-blur duplicate', () => {
    const { bridge } = mount();
    const field = threshold();
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.getAttribute('aria-busy')).toBe('true');
    // The blur that follows Enter is the same write; the pending guard drops it.
    fireEvent.blur(field);
    const sent = bridge.all('set-quota');
    expect(sent).toHaveLength(1);
    act(() => bridge.push({ type: 'action-result', requestId: sent[0]!.requestId!, ok: true }));
    expect(field.getAttribute('aria-busy')).toBeNull();
  });

  it('places "Saved" beside the control whose own write was acknowledged (UI-R15)', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByLabelText('Install for all Claude sessions'));
    fireEvent.click(screen.getByLabelText('Use the Claude usage API'));
    const [statusline, usage] = bridge.all('set-quota') as unknown as Array<{
      patch: Record<string, unknown>;
      requestId?: string;
    }>;
    expect(statusline?.patch).toEqual({ claudeGlobalStatusline: true });
    expect(usage?.patch).toEqual({ claudeOauthUsageApi: true });
    act(() => {
      bridge.push({ type: 'quota-saved', patch: { claudeGlobalStatusline: true } });
      bridge.push({ type: 'action-result', requestId: statusline!.requestId!, ok: true });
    });
    const note = screen.getByText('Saved');
    expect(note.previousElementSibling?.textContent).toContain('Install for all Claude sessions');
  });

  it('never claims "Saved" when the host refuses the write', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByLabelText('Install for all Claude sessions'));
    const sent = bridge.last('set-quota')!;
    act(() => bridge.push({ type: 'action-result', requestId: sent.requestId!, ok: false, message: 'refused' }));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('does not write the quota into the draft — the host owns it (no lost update)', () => {
    const { bridge, probe } = mount();
    fireEvent.change(threshold(), { target: { value: '90' } });
    fireEvent.blur(threshold());
    expect(bridge.last('set-quota')).toBeTruthy();
    expect(probe().draft).not.toHaveProperty('quota');
    expect(probe().dirtySections).not.toContain('agents');
  });
});

describe('Subscription quota card — the two opt-ins save at once (Q4-SAVE)', () => {
  it('posts the statusline flag in onChange, with no Save step', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByLabelText('Install for all Claude sessions'));
    expect(lastQuota(bridge)?.patch).toEqual({ claudeGlobalStatusline: true });
  });

  it('posts the usage API flag in onChange, with no Save step', () => {
    const { bridge } = mount({ ...BASE, quota: { claudeOauthUsageApi: true } } as unknown as Manifest);
    const toggle = screen.getByLabelText('Use the Claude usage API') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(lastQuota(bridge)?.patch).toEqual({ claudeOauthUsageApi: false });
  });

  it('renders a form checkbox, not a list-item switch', () => {
    mount();
    for (const label of ['Install for all Claude sessions', 'Use the Claude usage API']) {
      const toggle = screen.getByLabelText(label) as HTMLInputElement;
      expect(toggle.getAttribute('type')).toBe('checkbox');
      expect(toggle.closest('.k-check')).not.toBeNull();
    }
  });
});

describe('Subscription quota card — copy and links (SET-45, US-30-QC)', () => {
  it('never claims the quota needs Save Agents, and explains the commit gesture', () => {
    mount();
    const card = document.querySelector('[data-region="accounts-quota"]') as HTMLElement;
    expect(card.textContent).not.toContain('Saved with Save Agents.');
    expect(card.textContent).toContain('Blank = 80.');
    expect(card.textContent).toContain('Saves when you leave the field or press Enter.');
    expect(card.textContent).toContain("Karst compares the tightest window");
  });

  it('links to the current quota through the host', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'See current quota' }));
    expect(bridge.last('open-quota')).toBeTruthy();
  });

  it('capitalizes Karst in the statusline help (SET-11)', () => {
    mount();
    expect(screen.getByText(/Adds Karst's statusline wrapper/)).toBeTruthy();
  });
});
