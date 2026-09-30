// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for `Help` (NDL-126 §9.1/§9.6): UI-R19 — required
 * guidance is visible text, never a `title` tooltip. §9.6 requires a COMPONENT
 * test per primitive, so this closes the one primitive that had none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Help } from './Help.js';

afterEach(cleanup);

describe('Help', () => {
  it('renders guidance as visible text, not a title tooltip (UI-R19)', () => {
    render(<Help>Use the branch, not the manifest path</Help>);
    const help = screen.getByText('Use the branch, not the manifest path');
    expect(help.className).toBe('k-field-help');
    expect(help.hasAttribute('title')).toBe(false);
    expect(help.getAttribute('role')).toBeNull();
  });

  it('renders the caller-supplied id so aria-describedby can point at it', () => {
    render(<Help id="team-help">Team owns the reviews</Help>);
    expect(document.getElementById('team-help')?.textContent).toBe('Team owns the reviews');
  });

  it('omits the id attribute when none is given (no empty-id drift)', () => {
    render(<Help>Standalone guidance</Help>);
    const help = screen.getByText('Standalone guidance');
    expect(help.hasAttribute('id')).toBe(false);
  });
});
