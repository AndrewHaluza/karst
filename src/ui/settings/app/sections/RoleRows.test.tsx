// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { CompareRow, RoleRow, sourceWhy } from './RoleRows.js';

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = () => {};
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as Record<string, unknown>).mountAgentPicker;
});

function wrap(ui: React.ReactElement) {
  const bridge = createTestBridge();
  const result = render(
    <SettingsAppProvider bridge={bridge} initialSection="agents">
      {ui}
    </SettingsAppProvider>,
  );
  act(() => {
    bridge.push({
      type: 'state',
      state: buildSettingsState(FIXTURE_MANIFEST, null, [], true, ['claude', 'opencode'], [], {}, undefined, '/repo/karst.yml'),
    });
  });
  return result;
}

describe('RoleRows — RoleRow and SourceCell semantics', () => {
  const baseEffective = {
    source: 'pin' as const,
    core: 'claude',
    model: 'claude-opus-5',
    effort: 'low',
  };

  it('renders pin source chip with pin icon and success tone', () => {
    wrap(
      <RoleRow
        capability="planning"
        label="Planner"
        effective={baseEffective}
        view={{ key: 'planning', roleLabel: 'Planner' } as never}
        profile=""
        enabled={true}
        selected={false}
        flash={false}
        sharesProfile={false}
        onChange={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onClear={vi.fn()}
        onProfile={vi.fn()}
        onEnabled={vi.fn()}
        onOpenProfile={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const source = screen.getByTitle(/Pinned:/);
    expect(source.getAttribute('data-source')).toBe('pin');
    const chip = source.querySelector('.k-chip--success');
    expect(chip).not.toBeNull();
    expect(chip!.querySelector('.icon-island')).not.toBeNull();
    expect(chip!.textContent).toContain('pinned');
  });

  it('renders preset source chip with stack-2 icon and neutral tone', () => {
    wrap(
      <RoleRow
        capability="planning"
        label="Planner"
        effective={{ ...baseEffective, source: 'preset' }}
        view={{ key: 'planning', roleLabel: 'Planner' } as never}
        profile=""
        enabled={true}
        selected={false}
        flash={false}
        sharesProfile={false}
        onChange={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onClear={vi.fn()}
        onProfile={vi.fn()}
        onEnabled={vi.fn()}
        onOpenProfile={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const source = screen.getByTitle(/From the selected preset/);
    expect(source.getAttribute('data-source')).toBe('preset');
    const chip = source.querySelector('.k-chip');
    expect(chip).not.toBeNull();
    expect(chip!.querySelector('.icon-island')).not.toBeNull();
    expect(chip!.textContent).toContain('preset');
  });

  it('renders share icon with title and SR text when sharesProfile is true', () => {
    const bridge = createTestBridge();
    const { rerender } = render(
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <RoleRow
          capability="planning"
          label="Planner"
          effective={baseEffective}
          view={{ key: 'planning', roleLabel: 'Planner', profileOptions: ['shared-profile'] } as never}
          profile="shared-profile"
          enabled={true}
          selected={false}
          flash={false}
          sharesProfile={true}
          onChange={vi.fn()}
          onPin={vi.fn()}
          onUnpin={vi.fn()}
          onClear={vi.fn()}
          onProfile={vi.fn()}
          onEnabled={vi.fn()}
          onOpenProfile={vi.fn()}
          onToggle={vi.fn()}
        />
      </SettingsAppProvider>,
    );
    act(() => {
      bridge.push({
        type: 'state',
        state: buildSettingsState(FIXTURE_MANIFEST, null, [], true, ['claude', 'opencode'], [], {}, undefined, '/repo/karst.yml'),
      });
    });

    const shareBadge = screen.getByTitle('Shares this profile with the selected role');
    expect(shareBadge).toBeDefined();
    expect(shareBadge.querySelector('.icon-island')).not.toBeNull();
    expect(shareBadge.querySelector('.sr-only')!.textContent).toBe(
      'Shares this profile with the selected role',
    );

    rerender(
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <RoleRow
          capability="planning"
          label="Planner"
          effective={baseEffective}
          view={{ key: 'planning', roleLabel: 'Planner', profileOptions: ['shared-profile'] } as never}
          profile="shared-profile"
          enabled={true}
          selected={false}
          flash={false}
          sharesProfile={false}
          onChange={vi.fn()}
          onPin={vi.fn()}
          onUnpin={vi.fn()}
          onClear={vi.fn()}
          onProfile={vi.fn()}
          onEnabled={vi.fn()}
          onOpenProfile={vi.fn()}
          onToggle={vi.fn()}
        />
      </SettingsAppProvider>,
    );
    expect(screen.queryByTitle('Shares this profile with the selected role')).toBeNull();
  });

  it('renders Clear override action label and title on the clear button', () => {
    wrap(
      <RoleRow
        capability="planning"
        label="Planner"
        effective={baseEffective}
        view={{ key: 'planning', roleLabel: 'Planner' } as never}
        profile=""
        enabled={true}
        selected={false}
        flash={false}
        sharesProfile={false}
        onChange={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onClear={vi.fn()}
        onProfile={vi.fn()}
        onEnabled={vi.fn()}
        onOpenProfile={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const clearBtn = screen.getByRole('button', { name: 'Clear override' });
    expect(clearBtn).toBeDefined();
    expect(clearBtn.getAttribute('title')).toBe('Clear override');
  });
});

describe('RoleRows — CompareRow semantics', () => {
  it('renders Copy from {compare} with Tabler arrow-left icon', () => {
    render(
      <CompareRow
        capability="planning"
        label="Planner"
        a={{ source: 'preset', core: 'claude', model: 'claude-opus-5', effort: '' }}
        b={{ source: 'preset', core: 'antigravity', model: 'gemini-3.8-flash', effort: '' }}
        differs={true}
        aName="PresetA"
        bName="PresetB"
        onCopy={vi.fn()}
      />,
    );

    const copyBtn = screen.getByRole('button', { name: /Copy from PresetB/ });
    expect(copyBtn).toBeDefined();
    expect(copyBtn.querySelector('.icon-island')).not.toBeNull();
    expect(copyBtn.textContent).toContain('Copy from PresetB');
  });

  it('joins display names in the A and B cells, never raw ids (SET-35)', () => {
    const { container } = render(
      <CompareRow
        capability="planning"
        label="Planner"
        a={{ source: 'preset', core: 'claude', model: 'claude-opus-5', effort: 'low' }}
        b={{ source: 'preset', core: 'antigravity', model: 'gemini-3.8-flash', effort: '' }}
        differs={true}
        aName="PresetA"
        bName="PresetB"
        onCopy={vi.fn()}
      />,
    );
    expect(container.querySelector('.agents-a')!.textContent).toBe('Claude Code · Opus 5 · low');
    // Unknown ids still render honestly (the raw value is better than a blank).
    expect(container.querySelector('.agents-b')!.textContent).toBe('Antigravity CLI · gemini-3.8-flash');
  });
});

describe('RoleRows — narrow summary row (T1239)', () => {
  const effective = { source: 'preset' as const, core: 'claude', model: 'claude-opus-5', effort: '' };
  const rowProps = (over: Record<string, unknown> = {}) => ({
    capability: 'planning',
    label: 'Planner',
    effective,
    view: { key: 'planning', roleLabel: 'Planner' } as never,
    profile: 'tdd-implementer',
    enabled: true,
    selected: false,
    flash: false,
    sharesProfile: false,
    onChange: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onClear: vi.fn(),
    onProfile: vi.fn(),
    onEnabled: vi.fn(),
    onOpenProfile: vi.fn(),
    onToggle: vi.fn(),
    ...over,
  });

  it('summarises profile, core name and model DISPLAY name on one line (SET-35)', () => {
    const { container } = wrap(<RoleRow {...rowProps()} />);
    expect(container.querySelector('.agents-summary-line')!.textContent).toBe(
      'tdd-implementer · Claude Code · Opus 5',
    );
  });

  it('shows an unknown model id unchanged rather than hiding it', () => {
    const { container } = wrap(<RoleRow {...rowProps({ effective: { ...effective, model: 'house-model-7' } })} />);
    expect(container.querySelector('.agents-summary-line')!.textContent).toBe(
      'tdd-implementer · Claude Code · house-model-7',
    );
  });

  it('carries the visible Enabled caption beside the switch (Q4)', () => {
    const { container } = wrap(<RoleRow {...rowProps()} />);
    const caption = container.querySelector('.agents-cell-switch .agents-switch-text')!;
    expect(caption.textContent).toBe('Enabled');
    expect(caption.getAttribute('aria-hidden')).toBe('true');
  });

  it('says "No model" and "default" when nothing is set', () => {
    const { container } = wrap(<RoleRow {...rowProps({ profile: '', effective: { ...effective, model: '' } })} />);
    expect(container.querySelector('.agents-summary-line')!.textContent).toBe('default · Claude Code · No model');
  });

  it('says "No profile" for a role that cannot take a profile', () => {
    const { container } = wrap(<RoleRow {...rowProps({ capability: 'not-a-process-key' })} />);
    expect(container.querySelector('.agents-summary-line')!.textContent).toMatch(/^No profile · /);
    expect(container.querySelector('.agents-cell-profile')!.textContent).toBe('No profile');
  });

  it('starts collapsed; the expand button toggles aria-expanded and points at the pickers', () => {
    const { container } = wrap(<RoleRow {...rowProps()} />);
    const btn = screen.getByRole('button', { name: /^Settings for Planner$/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    const controlled = btn.getAttribute('aria-controls')!.split(' ');
    expect(controlled).toHaveLength(2);
    for (const id of controlled) expect(container.querySelector(`[id="${id}"]`)).not.toBeNull();
    expect(container.querySelector('.agents-row')!.classList.contains('is-open')).toBe(false);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.agents-row')!.classList.contains('is-open')).toBe(true);
  });

  it('reports each toggle, so the route can keep the opened role', () => {
    const onToggle = vi.fn();
    wrap(<RoleRow {...rowProps({ onToggle })} />);
    const btn = screen.getByRole('button', { name: /^Settings for Planner$/ });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenLastCalledWith(true);
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('opens a row that the route selects', () => {
    const { container } = wrap(<RoleRow {...rowProps({ selected: true })} />);
    expect(container.querySelector('.agents-row')!.classList.contains('is-open')).toBe(true);
  });

  it('keeps the switch and pin slots reserved on a non-pinnable role', () => {
    const { container } = wrap(<RoleRow {...rowProps({ capability: 'not-a-process-key' })} />);
    // The empty switch cell keeps its grid track, so the role names align.
    expect(container.querySelector('.agents-cell-switch')!.children).toHaveLength(0);
    expect(container.querySelector('.agents-cell-actions .agents-slot')).not.toBeNull();
    expect(container.querySelector('.agents-cell-switch .k-switch')).toBeNull();
  });
});

describe('RoleRows — graph roles (T1266)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    capability: 'graphExpert',
    label: 'Graph expert',
    effective: { source: 'approach' as const, core: 'claude', model: 'claude-opus-5', effort: 'high' },
    view: undefined,
    profile: '',
    enabled: true,
    selected: false,
    flash: false,
    sharesProfile: false,
    onChange: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onClear: vi.fn(),
    onProfile: vi.fn(),
    onEnabled: vi.fn(),
    onOpenProfile: vi.fn(),
    onToggle: vi.fn(),
    ...over,
  });

  it('says the approach profile supplies the value, not Karst built-in default', () => {
    wrap(<RoleRow {...props()} />);
    const source = screen.getByTitle(/approach's expert profile/);
    expect(source.getAttribute('data-source')).toBe('approach');
    expect(source.textContent).not.toContain('built-in default');
  });

  it('renders the row hint and the inherited text', () => {
    wrap(<RoleRow {...props({ hint: 'Graph expert: graph planner and expert nodes', inherited: 'Inherited: claude · claude-opus-5 · high' })} />);
    expect(screen.getByText('Graph expert: graph planner and expert nodes')).toBeTruthy();
    expect(screen.getByText('Inherited: claude · claude-opus-5 · high')).toBeTruthy();
  });

  it('renders no inherited text for a preset-sourced row', () => {
    wrap(<RoleRow {...props({ effective: { source: 'preset', core: 'claude', model: 'm', effort: '' }, inherited: 'Inherited: x' })} />);
    expect(screen.queryByText('Inherited: x')).toBeNull();
  });
});

describe('sourceWhy', () => {
  it('names the profile for a graph role and keeps Karst default wording for a process role', () => {
    expect(sourceWhy('approach', 'graphWorker')).toBe("No preset value: uses the approach's worker profile.");
    expect(sourceWhy('default', 'graphFast')).toBe("No preset value and no approach profile: uses Karst's built-in default.");
    expect(sourceWhy('default', 'review')).toBe("No preset value and no pin: uses Karst's built-in default.");
    expect(sourceWhy('pin', 'review')).toContain('Pinned');
  });
});
