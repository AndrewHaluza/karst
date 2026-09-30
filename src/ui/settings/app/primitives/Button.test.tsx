// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for `Button` (NDL-126 §9.5): UI-R07 (shared primitive),
 * UI-R11/R17 (busy is exposed and distinct from unavailable), UI-R12 (busy
 * prevents duplicate activation).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button } from './Button.js';

afterEach(cleanup);

describe('Button', () => {
  it('renders the shared k-btn class with the chosen variant and size (UI-R07)', () => {
    render(
      <Button variant="primary" size="sm">
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toBe('k-btn k-btn--primary k-btn--sm');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('defaults to the secondary variant at medium size', () => {
    render(<Button>Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toBe(
      'k-btn k-btn--secondary',
    );
  });

  it('maps every variant to its shared class', () => {
    for (const [variant, cls] of [
      ['primary', 'k-btn--primary'],
      ['secondary', 'k-btn--secondary'],
      ['ghost', 'k-btn--ghost'],
      ['danger', 'k-btn--danger'],
      ['text', 'k-btn--link'],
    ] as const) {
      render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByRole('button', { name: variant }).className).toBe(`k-btn ${cls}`);
      cleanup();
    }
  });

  it('exposes aria-busy and prevents a duplicate activation while busy (UI-R11/R12/R17)', () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Saving
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('leaves aria-busy off an idle button', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('aria-busy')).toBe(false);
  });
});