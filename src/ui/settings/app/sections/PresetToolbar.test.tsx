// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { PresetToolbar } from './PresetToolbar.js';

afterEach(cleanup);

const EMPTY_MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  activeAgentPreset: 'default-preset',
  agentPresets: {
    'default-preset': {
      slots: {
        planning: { provider: 'claude', model: 'claude-opus-5' },
      },
    },
    secondary: {
      slots: {
        planning: { provider: 'codex', model: 'gpt-5' },
      },
    },
  },
};

describe('PresetToolbar', () => {
  it('renders the groups with role="group" and aria-labels', () => {
    const edit = vi.fn();
    const onSelect = vi.fn();

    render(
      <PresetToolbar
        draft={EMPTY_MANIFEST}
        lastSaved={EMPTY_MANIFEST}
        names={['default-preset', 'secondary']}
        selected="default-preset"
        activeName="default-preset"
        roleLabelOf={() => undefined}
        onSelect={onSelect}
        edit={edit}
        compareSlot={<div role="group" aria-label="Compare">CompareSlot</div>}
      />,
    );

    expect(screen.getByRole('group', { name: 'Preset' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Edit preset' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Compare' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Delete preset' })).toBeDefined();
  });

  it('renders active chip without (active) in select options and has aria-description="active"', () => {
    render(
      <PresetToolbar
        draft={EMPTY_MANIFEST}
        lastSaved={EMPTY_MANIFEST}
        names={['default-preset', 'secondary']}
        selected="default-preset"
        activeName="default-preset"
        roleLabelOf={() => undefined}
        onSelect={vi.fn()}
        edit={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox');
    expect(select.getAttribute('aria-description')).toBe('active');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['default-preset', 'secondary']);
    expect(screen.getAllByText('active').length).toBe(2);
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });

  it('renders Activate button when non-active preset is selected and activates on click', () => {
    const edit = vi.fn();
    render(
      <PresetToolbar
        draft={EMPTY_MANIFEST}
        lastSaved={EMPTY_MANIFEST}
        names={['default-preset', 'secondary']}
        selected="secondary"
        activeName="default-preset"
        roleLabelOf={() => undefined}
        onSelect={vi.fn()}
        edit={edit}
      />,
    );

    const activateBtn = screen.getByRole('button', { name: 'Activate' });
    expect(activateBtn).toBeDefined();
    fireEvent.click(activateBtn);
    expect(edit).toHaveBeenCalled();
  });

  it('renders Delete preset button with trash icon and size lg in Delete preset group', () => {
    const edit = vi.fn();
    const onSelect = vi.fn();
    render(
      <PresetToolbar
        draft={EMPTY_MANIFEST}
        lastSaved={EMPTY_MANIFEST}
        names={['default-preset', 'secondary']}
        selected="secondary"
        activeName="default-preset"
        roleLabelOf={() => undefined}
        onSelect={onSelect}
        edit={edit}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: /Delete preset/ });
    expect(deleteBtn).toBeDefined();
    expect(deleteBtn.className).toContain('k-btn--lg');
    expect(deleteBtn.className).toContain('k-btn--danger');
    expect(deleteBtn.querySelector('.icon-island')).not.toBeNull();
  });

  it('renders Edit preset actions (New, Duplicate, Rename) with size lg', () => {
    render(
      <PresetToolbar
        draft={EMPTY_MANIFEST}
        lastSaved={EMPTY_MANIFEST}
        names={['default-preset', 'secondary']}
        selected="secondary"
        activeName="default-preset"
        roleLabelOf={() => undefined}
        onSelect={vi.fn()}
        edit={vi.fn()}
      />,
    );

    const newBtn = screen.getByRole('button', { name: 'New' });
    const dupBtn = screen.getByRole('button', { name: 'Duplicate' });
    const renBtn = screen.getByRole('button', { name: 'Rename' });

    expect(newBtn.className).toContain('k-btn--secondary');
    expect(newBtn.className).toContain('k-btn--lg');

    expect(dupBtn.className).toContain('k-btn--ghost');
    expect(dupBtn.className).toContain('k-btn--lg');

    expect(renBtn.className).toContain('k-btn--ghost');
    expect(renBtn.className).toContain('k-btn--lg');
  });
});
