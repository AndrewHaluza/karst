/**
 * COMPONENT-mode tests for the Autopilot tab (T1004, @arch:SAVE).
 *
 * One page = one manifest key. The assertions pin the copy the prototype
 * (`docs/ui/prototypes/autopilot-inapp-v2.html`, screen 5) names, the shared
 * "Fix automatically / Ask me" select, and that every write lands in
 * `draft.autopilot` and nowhere else.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AutopilotConfig } from '../../../../manifest/autopilot.js';
import type { SettingsState } from '../../state.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_MANIFEST, FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';
import { AutopilotSection } from './AutopilotSection.js';

afterEach(cleanup);

const ON: AutopilotConfig = {
  enabled: true,
  ci: { policy: 'auto', maxAttempts: 3, checks: ['lint', 'typecheck'] },
  conflicts: { policy: 'auto', maxRounds: 2 },
};

function stateWith(autopilot: AutopilotConfig | undefined, error?: string): SettingsState {
  const manifest = { ...FIXTURE_MANIFEST, ...(autopilot ? { autopilot } : {}) };
  return {
    ...FIXTURE_STATE_PUSH,
    manifest,
    validation: error ? { ok: false, error } : { ok: true },
  } as unknown as SettingsState;
}

function mount(state: SettingsState): { bridge: TestBridge; probe(): AppProbeShape } {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="autopilot">
        <AutopilotSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state }));
  return { bridge, probe: () => readProbe(view.baseElement) };
}

const block = (probe: () => AppProbeShape): AutopilotConfig | undefined =>
  (probe().draft as { autopilot?: AutopilotConfig }).autopilot;

describe('Autopilot tab', () => {
  it('names the page and states that autopilot never merges', () => {
    mount(stateWith(undefined));
    expect(screen.getByRole('heading', { level: 1, name: 'Autopilot' })).toBeTruthy();
    expect(screen.getByText(/Autopilot never merges a PR/)).toBeTruthy();
    expect(screen.getByText(/Each ticket can override this from its ship panel/)).toBeTruthy();
  });

  it('renders the four sections of the prototype', () => {
    mount(stateWith(ON));
    for (const name of ['Processing mode', 'Merge conflicts', 'CI failures', 'Push diverged']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
  });

  it('shows the engine defaults and an unchecked mode for an absent block', () => {
    mount(stateWith(undefined));
    expect((screen.getByLabelText('Auto-fix mode') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Max rounds per PR') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Max attempts per PR') as HTMLInputElement).value).toBe('3');
  });

  it('turns the mode on and writes a full block', () => {
    const { probe } = mount(stateWith(undefined));
    fireEvent.click(screen.getByLabelText('Auto-fix mode'));
    expect(block(probe)).toEqual({
      enabled: true,
      ci: { policy: 'auto', maxAttempts: 3, checks: [] },
      conflicts: { policy: 'auto', maxRounds: 2 },
    });
  });

  it('uses the same two-option select for conflicts and CI', () => {
    const { probe } = mount(stateWith(ON));
    const selects = screen.getAllByLabelText('When it happens') as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    for (const select of selects) {
      expect(Array.from(select.options).map((o) => o.text)).toEqual(['Fix automatically', 'Ask me']);
    }
    fireEvent.change(selects[0]!, { target: { value: 'ask' } });
    fireEvent.change(selects[1]!, { target: { value: 'ask' } });
    expect(block(probe)?.conflicts.policy).toBe('ask');
    expect(block(probe)?.ci.policy).toBe('ask');
  });

  it('edits the two budgets and explains when each one resets', () => {
    const { probe } = mount(stateWith(ON));
    fireEvent.change(screen.getByLabelText('Max rounds per PR'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Max attempts per PR'), { target: { value: '5' } });
    expect(block(probe)?.conflicts.maxRounds).toBe(4);
    expect(block(probe)?.ci.maxAttempts).toBe(5);
    expect(screen.getByText('Resets when the base branch moves.')).toBeTruthy();
    expect(screen.getByText('Resets when a different check fails.')).toBeTruthy();
  });

  it('lets the user clear a budget box to type a new value', () => {
    const { probe } = mount(stateWith(ON));
    const box = screen.getByLabelText('Max rounds per PR') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');
    expect(block(probe)?.conflicts.maxRounds).toBe(2);
    fireEvent.change(box, { target: { value: '5' } });
    expect(box.value).toBe('5');
    expect(block(probe)?.conflicts.maxRounds).toBe(5);
  });

  it('lists the allowlist, adds a check and removes one', () => {
    const { probe } = mount(stateWith(ON));
    const list = screen.getByRole('list', { name: 'Checks karst may fix' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('lint'),
      expect.stringContaining('typecheck'),
    ]);
    fireEvent.change(screen.getByLabelText('Add a check'), { target: { value: 'test:unit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
    expect(block(probe)?.ci.checks).toEqual(['lint', 'typecheck', 'test:unit']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove lint' }));
    expect(block(probe)?.ci.checks).toEqual(['typecheck', 'test:unit']);
    expect(screen.getByText('Any other check always asks.')).toBeTruthy();
  });

  it('shows push diverged as read-only copy with the docs link', () => {
    mount(stateWith(ON));
    expect(screen.getByText(/Always asks\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How Fix push works' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /push diverged/i })).toBeNull();
  });

  it('puts a host fault for a budget on that field', () => {
    const { bridge } = mount(stateWith(ON));
    act(() =>
      bridge.push({
        type: 'validation',
        ok: false,
        error: 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1',
      }),
    );
    const field = screen.getByLabelText('Max rounds per PR');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/autopilot\.conflicts\.maxRounds must be a whole number/)).toBeTruthy();
  });
});
