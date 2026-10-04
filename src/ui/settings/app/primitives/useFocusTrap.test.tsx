// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusTrap } from './useFocusTrap.js';

afterEach(cleanup);

function Probe({ active, start }: { readonly active: boolean; readonly start?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const second = useRef<HTMLButtonElement>(null);
  useFocusTrap(ref, active, start ? () => second.current : undefined);
  return (
    <div ref={ref}>
      <button type="button">one</button>
      <button type="button" ref={second}>two</button>
      <button type="button">three</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses the first focusable, or the given initial element', () => {
    render(<Probe active />);
    expect(document.activeElement).toBe(screen.getByText('one'));
    cleanup();
    render(<Probe active start />);
    expect(document.activeElement).toBe(screen.getByText('two'));
  });

  it('wraps Tab from the last to the first and Shift+Tab back', () => {
    render(<Probe active />);
    const three = screen.getByText('three');
    three.focus();
    fireEvent.keyDown(three, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('one'));
    fireEvent.keyDown(screen.getByText('one'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(three);
  });

  it('does nothing while inactive', () => {
    render(<Probe active={false} />);
    expect(document.activeElement).toBe(document.body);
  });
});
