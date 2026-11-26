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
    // T1368 (D829): the row label reads "Warn at"; the unit follows the control
    // so the input and the visible suffix read as one control group.
    expect(screen.getByRole('spinbutton', { name: /Warn at % used/ })).toBe(field);
    const suffix = document.querySelector('.accounts-quota-suffix') as HTMLElement;
    expect(suffix.getAttribute('aria-hidden')).toBe('true');
    expect(suffix.textContent).toBe('% used');
    expect(suffix.previousElementSibling).toBe(field);
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
    fireEvent.click(screen.getByLabelText('Show quota in all Claude sessions'));
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
    // The note lands in the row of the control whose write it acknowledges (UI-R15).
    const row = note.closest('.accounts-quota-row');
    expect(row?.textContent).toContain('Show quota in all Claude sessions');
    expect(row?.textContent).not.toContain('Use the Claude usage API');
  });

  it('shows the resolved default after clearing, not a blank that snaps back later', () => {
    const { bridge } = mount({ ...BASE, quota: { warnThresholdPct: 90 } } as unknown as Manifest);
    fireEvent.change(threshold(), { target: { value: '' } });
    fireEvent.blur(threshold());
    const sent = bridge.last('set-quota')!;
    act(() => {
      bridge.push({ type: 'quota-saved', patch: { warnThresholdPct: null } });
      bridge.push({ type: 'action-result', requestId: sent.requestId!, ok: true });
    });
    // The file drops the block but the host's manifest resolves 80; the input
    // must show that now, not stay blank until the next state push.
    expect(threshold().value).toBe('80');
  });

  it('never claims "Saved" when the host refuses the write', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByLabelText('Show quota in all Claude sessions'));
    const sent = bridge.last('set-quota')!;
    act(() => bridge.push({ type: 'action-result', requestId: sent.requestId!, ok: false, message: 'refused' }));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('keeps in-progress text and its inline error when another quota control saves', () => {
    const manifest = { ...BASE, quota: { warnThresholdPct: 90 } } as unknown as Manifest;
    const { bridge } = mount(manifest);
    const field = threshold();
    fireEvent.change(field, { target: { value: '150' } });
    fireEvent.blur(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    // A sibling checkbox's save pushes a new state + quota-saved; the threshold
    // value did not change, so the local text and its error must survive.
    act(() => {
      bridge.push({
        type: 'state',
        state: buildSettingsState(manifest, null, [], true, ['claude'], [], {}, undefined, '/repo/karst.yml'),
      });
      bridge.push({ type: 'quota-saved', patch: { claudeOauthUsageApi: true } });
    });
    expect(threshold().value).toBe('150');
    expect(screen.getByText('Enter a whole number from 1 to 100.')).toBeTruthy();
  });

  it('does not claim "Saved" on a control whose request timed out', () => {
    vi.useFakeTimers();
    const { bridge } = mount();
    const toggle = screen.getByLabelText('Show quota in all Claude sessions') as HTMLInputElement;
    fireEvent.click(toggle);
    const sent = bridge.last('set-quota')!;
    act(() => vi.advanceTimersByTime(30_000)); // useHostMutation default timeout → unknown
    act(() => bridge.push({ type: 'action-result', requestId: sent.requestId!, ok: true }));
    expect(screen.queryByText('Saved')).toBeNull();
    expect(toggle.disabled).toBe(true);
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
    fireEvent.click(screen.getByLabelText('Show quota in all Claude sessions'));
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
    for (const label of ['Show quota in all Claude sessions', 'Use the Claude usage API']) {
      const toggle = screen.getByLabelText(label) as HTMLInputElement;
      expect(toggle.getAttribute('type')).toBe('checkbox');
      expect(toggle.closest('.k-check')).not.toBeNull();
    }
  });
});

describe('Subscription quota card — copy and links (SET-45, US-30-QC, T1368)', () => {
  it('never claims the quota needs Save Agents and keeps the facts in the short help texts', () => {
    mount();
    const card = document.querySelector('[data-region="accounts-quota"]') as HTMLElement;
    expect(card.textContent).not.toContain('Saved with Save Agents.');
    expect(card.textContent).toContain('Warnings only. Karst never blocks a launch or switches the agent.');
    expect(card.textContent).toContain('The tightest quota window of the agent. Blank = 80.');
    expect(card.textContent).toContain('Adds the Karst statusline to your global Claude settings. Your own statusline still runs.');
    expect(card.textContent).toContain('The token is not stored or logged.');
    // The commit gesture is now a control affordance, not a help paragraph (D829).
    expect(card.textContent).not.toContain('Saves when you leave the field or press Enter.');
  });

  it('links to the current quota through the host', () => {
    const { bridge } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'See current quota' }));
    expect(bridge.last('open-quota')).toBeTruthy();
  });

  it('keeps the title, the link and the lead line out of the setting rows (T1368, @ui:UI-R39)', () => {
    mount();
    const card = document.querySelector('[data-region="accounts-quota"]') as HTMLElement;
    const head = card.querySelector(':scope > .accounts-quota-head');
    expect(head?.querySelector('h3')?.textContent).toBe('Subscription quota');
    expect(head?.querySelector('button')?.textContent).toBe('See current quota');
    // The link is in the head line, never in a paragraph of its own.
    expect([...card.querySelectorAll('p')].some((p) => p.querySelector('button'))).toBe(false);
    const rows = card.querySelectorAll('.accounts-quota-row');
    expect(rows).toHaveLength(3);
    expect([...rows].map((row) => row.querySelector('label, .k-check > label')?.textContent)).toEqual([
      'Warn at % used',
      'Show quota in all Claude sessions',
      'Use the Claude usage API',
    ]);
    for (const row of rows) expect(row.querySelector('.k-field-help'), row.textContent ?? '').not.toBeNull();
  });

  it('capitalizes Karst in the statusline help (SET-11)', () => {
    mount();
    expect(screen.getByText(/Adds the Karst statusline/)).toBeTruthy();
  });
});
