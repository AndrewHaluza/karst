// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDismiss } from './useDismiss.js';

afterEach(cleanup);

function Probe({ active, onClose }: { readonly active: boolean; readonly onClose: () => void }) {
  const inside = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss({ active, onClose, refs: [inside, trigger] });
  return (
    <div>
      <div ref={inside} data-testid="inside"><span data-testid="child" /></div>
      <button ref={trigger} type="button" data-testid="trigger" />
      <div data-testid="outside" />
    </div>
  );
}

describe('useDismiss', () => {
  it('closes on Escape and on a click outside every guarded element', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Probe active onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores clicks inside a guarded element and other keys', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Probe active onClose={onClose} />);
    fireEvent.mouseDown(getByTestId('child'));
    fireEvent.mouseDown(getByTestId('trigger'));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('listens only while active', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Probe active={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(getByTestId('outside'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
