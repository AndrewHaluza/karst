/**
 * COMPONENT-mode tests for the Autopilot tab (T1004; rebuilt by T1372/D832, @arch:SAVE).
 *
 * One page = one manifest key. The assertions pin the rebuilt layout: one
 * Auto-fix row, one rules table (Problem | When it happens | Limit per PR) and
 * one checks chip row. Every write still lands in `draft.autopilot` and nowhere
 * else, and an error never moves its control.
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
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
    error: error ?? null,
  };
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

function mountInvalid(): { bridge: TestBridge; probe(): AppProbeShape } {
  return mount(
    stateWith(
      { ...ON, conflicts: { policy: 'auto', maxRounds: 0 } },
      'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1',
    ),
  );
}

const block = (probe: () => AppProbeShape): AutopilotConfig | undefined =>
  (probe().draft as { autopilot?: AutopilotConfig }).autopilot;

describe('Autopilot tab', () => {
  it('names the page and states that autopilot never merges', () => {
    mount(stateWith(undefined));
    expect(screen.getByRole('heading', { level: 1, name: 'Autopilot' })).toBeTruthy();
    expect(screen.getByText(/Autopilot never merges a PR/)).toBeTruthy();
    expect(screen.getByText(/shipped PR hits a problem/)).toBeTruthy();
  });

  it('is one Auto-fix row, one rules table and one checks row — no section blocks', () => {
    mount(stateWith(ON));
    expect(document.querySelectorAll('#section-autopilot .section-block')).toHaveLength(0);
    const regions = Array.from(
      document.querySelectorAll('#section-autopilot [data-region]'),
      (node) => node.getAttribute('data-region'),
    );
    expect(regions).toEqual(['autopilot-mode', 'autopilot-rules', 'autopilot-checks']);
    // Exactly one table, with the three problems as body rows.
    const tables = document.querySelectorAll('#section-autopilot table');
    expect(tables).toHaveLength(1);
    const bodyRows = Array.from(tables[0]!.querySelectorAll('tbody tr'));
    expect(bodyRows.map((row) => row.firstElementChild?.textContent)).toEqual([
      expect.stringContaining('Merge conflicts'),
      expect.stringContaining('CI failures'),
      expect.stringContaining('Push diverged'),
    ]);
    expect(screen.getByRole('list', { name: 'Checks Karst may fix' })).toBeTruthy();
  });

  it('shows the engine defaults and an unchecked switch for an absent block', () => {
    mount(stateWith(undefined));
    expect((screen.getByLabelText('Auto-fix') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Max rounds per PR') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Max attempts per PR') as HTMLInputElement).value).toBe('3');
  });

  it('turns the mode on and writes a full block', () => {
    const { probe } = mount(stateWith(undefined));
    fireEvent.click(screen.getByLabelText('Auto-fix'));
    expect(block(probe)).toEqual({
      enabled: true,
      ci: { policy: 'auto', maxAttempts: 3, checks: [] },
      conflicts: { policy: 'auto', maxRounds: 2 },
    });
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('names each select after its problem and writes both policies', () => {
    const { probe } = mount(stateWith(ON));
    const conflicts = screen.getByLabelText('Merge conflicts: when it happens') as HTMLSelectElement;
    const ci = screen.getByLabelText('CI failures: when it happens') as HTMLSelectElement;
    for (const select of [conflicts, ci]) {
      expect(Array.from(select.options).map((o) => o.text)).toEqual(['Fix automatically', 'Ask me']);
    }
    fireEvent.change(conflicts, { target: { value: 'ask' } });
    fireEvent.change(ci, { target: { value: 'ask' } });
    expect(block(probe)?.conflicts.policy).toBe('ask');
    expect(block(probe)?.ci.policy).toBe('ask');
  });

  it('edits the two budgets and explains when each one resets', () => {
    const { probe } = mount(stateWith(ON));
    fireEvent.change(screen.getByLabelText('Max rounds per PR'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Max attempts per PR'), { target: { value: '5' } });
    expect(block(probe)?.conflicts.maxRounds).toBe(4);
    expect(block(probe)?.ci.maxAttempts).toBe(5);
    expect(screen.getByText('rounds · resets when the base moves')).toBeTruthy();
    expect(screen.getByText('attempts · resets when another check fails')).toBeTruthy();
  });

  it('lets the user clear a budget box to type a new value and shows the draft on blur', () => {
    const { probe } = mount(stateWith(ON));
    const box = screen.getByLabelText('Max rounds per PR') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');
    expect(block(probe)?.conflicts.maxRounds).toBe(2);
    fireEvent.change(box, { target: { value: '5' } });
    expect(box.value).toBe('5');
    expect(block(probe)?.conflicts.maxRounds).toBe(5);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);
    expect(box.value).toBe('5');
  });

  it('disables a row limit under "Ask me", keeps its value and re-enables it unchanged', () => {
    const { probe } = mount(stateWith(ON));
    const select = screen.getByLabelText('Merge conflicts: when it happens') as HTMLSelectElement;
    const rounds = screen.getByLabelText('Max rounds per PR') as HTMLInputElement;
    expect(rounds.disabled).toBe(false);
    fireEvent.change(select, { target: { value: 'ask' } });
    expect(rounds.disabled).toBe(true);
    expect(rounds.value).toBe('2');
    expect(block(probe)?.conflicts.maxRounds).toBe(2);
    expect(screen.getByText(/not used while/)).toBeTruthy();
    expect(screen.queryByText('rounds · resets when the base moves')).toBeNull();
    fireEvent.change(select, { target: { value: 'auto' } });
    expect(rounds.disabled).toBe(false);
    expect(rounds.value).toBe('2');
    expect(screen.getByText('rounds · resets when the base moves')).toBeTruthy();
  });

  it('shows the Auto-fix off note only while the mode is off', () => {
    mount(stateWith(undefined));
    expect(
      screen.getByText('Auto-fix is off. These rules apply only to tickets that you set to On.'),
    ).toBeTruthy();
    expect((screen.getByLabelText('Max rounds per PR') as HTMLInputElement).disabled).toBe(false);
    cleanup();
    mount(stateWith(ON));
    expect(
      screen.queryByText('Auto-fix is off. These rules apply only to tickets that you set to On.'),
    ).toBeNull();
  });

  it('lists neutral chips, adds a check from the inline input and removes one', () => {
    const { probe } = mount(stateWith(ON));
    const list = screen.getByRole('list', { name: 'Checks Karst may fix' });
    expect(within(list).getAllByRole('listitem').length).toBe(3);
    // Neutral chips, not yellow `<code>`.
    expect(document.querySelector('#section-autopilot code')).toBeNull();
    expect(document.querySelectorAll('#section-autopilot .k-chip')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '+ Add check' }));
    const input = screen.getByLabelText('Add a check') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.placeholder).toBe('Check name, e.g. lint');
    fireEvent.change(input, { target: { value: 'test:unit' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(block(probe)?.ci.checks).toEqual(['lint', 'typecheck', 'test:unit']);
    // The input stays open for the next name.
    const next = screen.getByLabelText('Add a check') as HTMLInputElement;
    expect(next.value).toBe('');

    fireEvent.change(next, { target: { value: 'e2e' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(block(probe)?.ci.checks).toEqual(['lint', 'typecheck', 'test:unit', 'e2e']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove lint' }));
    expect(block(probe)?.ci.checks).toEqual(['typecheck', 'test:unit', 'e2e']);
    expect(screen.getByText('Any other check always asks.')).toBeTruthy();
  });

  it('restores the add button on Escape and on a blur with empty text', () => {
    mount(stateWith(ON));
    fireEvent.click(screen.getByRole('button', { name: '+ Add check' }));
    const input = screen.getByLabelText('Add a check') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'draft' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Add a check')).toBeNull();
    expect(screen.getByRole('button', { name: '+ Add check' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '+ Add check' }));
    fireEvent.blur(screen.getByLabelText('Add a check'));
    expect(screen.queryByLabelText('Add a check')).toBeNull();
    expect(screen.getByRole('button', { name: '+ Add check' })).toBeTruthy();
  });

  it('shows push diverged as read-only copy with the docs link in the limit column', () => {
    mount(stateWith(ON));
    const asks = screen.getByText('Always asks');
    expect(asks.closest('td')?.getAttribute('data-col')).toBe('when');
    const link = screen.getByRole('link', { name: 'How Fix push works' });
    expect(link.closest('td')?.getAttribute('data-col')).toBe('limit');
    expect(screen.queryByRole('combobox', { name: /push diverged/i })).toBeNull();
  });

  it('puts a host fault for a budget on the input line and blocks Save', () => {
    const { bridge, probe } = mount(stateWith(ON));
    act(() =>
      bridge.push({
        type: 'validation',
        ok: false,
        error: 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1',
      }),
    );
    const input = screen.getByLabelText('Max rounds per PR') as HTMLInputElement;
    const error = screen.getByText('Enter a whole number of at least 1.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)).toBe(error);
    // The error sits in the input's own line box, in place of the unit text.
    expect(input.closest('.autopilot-limit')?.contains(error)).toBe(true);
    expect(screen.queryByText('rounds · resets when the base moves')).toBeNull();
    expect(probe().valid).toBe(false);
  });

  it('shows a rejected Save fault on the input line, where the banner defers to it', () => {
    // A Save the host refuses reports the fault as `error` (hostError), not as a
    // `validation` verdict (@arch:SAVE). The shell hides the banner for an
    // inline-mapped path, so the field must read the same slot or the fault is
    // invisible (T1372 tester observation).
    const { bridge, probe } = mount(stateWith(ON));
    act(() =>
      bridge.push({
        type: 'error',
        message: 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1',
      }),
    );
    const input = screen.getByLabelText('Max rounds per PR') as HTMLInputElement;
    const error = screen.getByText('Enter a whole number of at least 1.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)).toBe(error);
    expect(input.closest('.autopilot-limit')?.contains(error)).toBe(true);
    expect(screen.queryByText('rounds · resets when the base moves')).toBeNull();
    // The host action error never turns into a blocking validation fault.
    expect(probe().valid).toBe(true);
  });

  it('shows the field fault from a state push alone, on the input line', () => {
    const { probe } = mountInvalid();
    const input = screen.getByLabelText('Max rounds per PR') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const error = screen.getByText('Enter a whole number of at least 1.');
    expect(input.closest('.autopilot-limit')?.contains(error)).toBe(true);
    expect(probe().valid).toBe(false);
  });

  it('shows the host text for a path without a short message next to its select', () => {
    mount(stateWith(ON, 'Invalid karst.yml: autopilot.ci.policy must be auto or ask'));
    const select = screen.getByLabelText('CI failures: when it happens');
    const error = screen.getByText('autopilot.ci.policy must be auto or ask');
    expect(select.closest('.autopilot-select-cell')?.contains(error)).toBe(true);
  });

  it('writes Karst in the section copy (SET-11)', () => {
    mount(stateWith(ON));
    const text = document.querySelector('#section-autopilot')?.textContent ?? '';
    expect(text).toContain('What Karst does');
    expect(text).not.toContain('What karst does');
    expect(text).toContain('Checks Karst may fix');
  });

  it('keeps the Add button disabled while the check name is empty (SET-34)', () => {
    mount(stateWith(ON));
    fireEvent.click(screen.getByRole('button', { name: '+ Add check' }));
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    const input = screen.getByLabelText('Add a check') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'e2e' } });
    expect(add.disabled).toBe(false);
  });
});

describe('Autopilot CSS (T1372)', () => {
  const css = readFileSync('src/ui/settings/webview.html', 'utf8');

  it('sizes the select and its k-select wrapper together so the chevron stays inside the box', () => {
    // The old rule shrank only the inner select and left the wrapper full width.
    expect(css).not.toMatch(/\.autopilot-select\s*\{[^}]*max-width:\s*38ch/);
    expect(css).toMatch(/#section-autopilot \.autopilot-select-cell \.k-select\s*\{[^}]*width:\s*22ch/);
    expect(css).toMatch(/#section-autopilot \.autopilot-select-cell \.k-input\.autopilot-select\s*\{[^}]*width:\s*100%/);
  });

  it('keeps the inline add input and its button in one chip-flow item', () => {
    expect(css).toMatch(/#section-autopilot \.autopilot-add\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/#section-autopilot \.autopilot-add \.k-input\s*\{[^}]*width:\s*22ch/);
  });

  it('puts a limit error in the input line box and never truncates it', () => {
    expect(css).toMatch(/#section-autopilot \.autopilot-limit \.k-field-error\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1/);
    expect(css).toMatch(/#section-autopilot \.autopilot-limit \.k-field-error\s*\{[^}]*color:\s*var\(--vscode-errorForeground/);
  });
});
