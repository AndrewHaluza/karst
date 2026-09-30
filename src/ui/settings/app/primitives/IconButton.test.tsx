// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for `IconButton` (NDL-126 §9.1): UI-R24 (icon-only
 * controls have an accessible name; the glyph is decorative) and UI-R21
 * (`aria-label` and `title` cannot disagree — they are the same prop).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { IconButton } from './IconButton.js';

afterEach(cleanup);

describe('IconButton', () => {
  it('uses the label as both the accessible name and the tooltip (UI-R21/R24)', () => {
    render(<IconButton label="Remove repository">×</IconButton>);
    const button = screen.getByRole('button', { name: 'Remove repository' });
    expect(button.getAttribute('aria-label')).toBe('Remove repository');
    expect(button.getAttribute('title')).toBe('Remove repository');
  });

  it('hides the decorative glyph from assistive technology (UI-R24)', () => {
    render(<IconButton label="Close">×</IconButton>);
    const glyph = screen.getByRole('button', { name: 'Close' }).firstElementChild;
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  it('adds the danger class for a destructive action (UI-R10b)', () => {
    render(
      <IconButton label="Delete agent" danger>
        ×
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Delete agent' }).className).toBe(
      'k-iconbtn k-iconbtn--danger',
    );
  });

  it('exposes aria-busy and disables itself while busy (UI-R11/R12)', () => {
    render(
      <IconButton label="Saving" busy>
        ×
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});