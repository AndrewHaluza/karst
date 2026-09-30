// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for the announcement surface (NDL-126 §9.2): UI-R27 —
 * one polite status region, updated through `announce()`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { AnnouncerProvider, LiveRegion, useAnnounce } from './LiveRegion.js';

afterEach(cleanup);

function Trigger() {
  const announce = useAnnounce();
  return (
    <button type="button" onClick={() => announce('Saved')}>
      announce
    </button>
  );
}

describe('LiveRegion', () => {
  it('renders exactly one polite status region', () => {
    render(
      <AnnouncerProvider>
        <LiveRegion />
      </AnnouncerProvider>,
    );
    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(1);
    expect(regions[0]!.getAttribute('aria-live')).toBe('polite');
    expect(regions[0]!.getAttribute('aria-atomic')).toBe('true');
  });

  it('reflects the announced message (UI-R27)', () => {
    render(
      <AnnouncerProvider>
        <Trigger />
        <LiveRegion />
      </AnnouncerProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('');
    act(() => {
      screen.getByRole('button', { name: 'announce' }).click();
    });
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });

  it('is a no-op outside a provider', () => {
    render(<Trigger />);
    act(() => {
      screen.getByRole('button', { name: 'announce' }).click();
    });
    // No region exists and nothing throws.
    expect(screen.queryByRole('status')).toBeNull();
  });
});