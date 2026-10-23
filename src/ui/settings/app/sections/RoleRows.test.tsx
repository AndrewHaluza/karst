// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { CompareRow, RoleRow } from './RoleRows.js';

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
});
