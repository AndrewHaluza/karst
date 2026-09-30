// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for `DestructiveButton` (NDL-126 §9.1, UI-R10b).
 *
 * The compile-time half of R10b is `tsc`: `action` is typed to the closed
 * `DestructiveAction` union and `variant` is not a prop, so a destructive
 * control with the wrong treatment cannot be written. This file covers the half
 * a type cannot — that the danger class actually reaches the DOM, that the
 * taxonomy value is emitted for the phase 4 parity sweep to diff, and that the
 * shared button's busy/disabled behaviour (UI-R11/R12/R17) survives the wrapper.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DestructiveButton } from './DestructiveButton.js';
import { DESTRUCTIVE_ACTIONS } from '../../messages.js';

afterEach(cleanup);

describe('DestructiveButton', () => {
  it('renders the shared danger variant (UI-R10b)', () => {
    render(
      <DestructiveButton action="uninstall-approach">
        Uninstall
      </DestructiveButton>,
    );
    const button = screen.getByRole('button', { name: 'Uninstall' });
    expect(button.className).toContain('k-btn--danger');
    expect(button.className).toContain('k-btn');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('emits the taxonomy member so the parity sweep can diff it', () => {
    for (const action of DESTRUCTIVE_ACTIONS) {
      render(<DestructiveButton action={action}>{action}</DestructiveButton>);
      expect(screen.getByRole('button', { name: action }).dataset.karstAction).toBe(action);
      cleanup();
    }
  });

  it('is busy and disabled while in flight, and does not fire (UI-R11/R12/R17)', () => {
    const onClick = vi.fn();
    render(
      <DestructiveButton action="delete-agent" busy onClick={onClick}>
        Delete
      </DestructiveButton>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards the accessible name and activation when idle', () => {
    const onClick = vi.fn();
    render(
      <DestructiveButton action="remove-preset" onClick={onClick} aria-label="Delete work preset">
        Delete
      </DestructiveButton>,
    );
    const button = screen.getByRole('button', { name: 'Delete work preset' });
    expect(button.getAttribute('aria-busy')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('carries the icon-button size when rendered as an icon control', () => {
    render(
      <DestructiveButton action="remove-port" size="sm">
        Remove
      </DestructiveButton>,
    );
    expect(screen.getByRole('button', { name: 'Remove' }).className).toContain('k-btn--sm');
  });
});