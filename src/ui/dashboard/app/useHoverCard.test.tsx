// @vitest-environment jsdom
/**
 * The hover/focus card primitive: the 300 ms open delay, the 200 ms leave grace, immediate keyboard open
 * (`@ui:UI-R22`), Tab into the card with no focus trap, Escape with focus return, and one header surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { HOVER_CLOSE_GRACE_MS, HOVER_OPEN_DELAY_MS, announceSurfaceOpen, useHoverCard } from './useHoverCard.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface HarnessProps {
  readonly id?: string;
  readonly enabled?: boolean;
}

/** A trigger button and the card it opens, wired exactly as the header's planning link is. */
function Harness({ id = 'card-a', enabled = true }: HarnessProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const { open, triggerProps, cardProps } = useHoverCard({ id, triggerRef, cardRef, width: 320, enabled });
  return (
    <div>
      <button id={`trigger-${id}`} type="button" ref={triggerRef} {...triggerProps}>
        {id}
      </button>
      {open ? (
        <div id={`card-${id}`} ref={cardRef} role="dialog" {...cardProps}>
          <button id={`inside-${id}`} type="button">
            inside
          </button>
        </div>
      ) : null}
    </div>
  );
}

const trigger = (id = 'card-a'): HTMLButtonElement => document.getElementById(`trigger-${id}`) as HTMLButtonElement;
const inside = (id = 'card-a'): HTMLButtonElement => document.getElementById(`inside-${id}`) as HTMLButtonElement;
const card = (id = 'card-a'): HTMLElement | null => document.getElementById(`card-${id}`);

describe('useHoverCard — pointer', () => {
  it('opens after the 300 ms hover delay, not one tick before', () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.mouseOver(trigger());
    act(() => void vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS - 1));
    expect(card()).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(card()).not.toBeNull();
  });

  it('cancels a pending open when the pointer leaves before the delay', () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.mouseOver(trigger());
    act(() => void vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS - 1));
    fireEvent.mouseOut(trigger(), { relatedTarget: document.body });
    act(() => void vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS * 2));
    expect(card()).toBeNull();
  });

  it('closes 200 ms after the pointer leaves the trigger, and not at 199 ms', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => trigger().focus());
    expect(card()).not.toBeNull();
    fireEvent.mouseOut(trigger(), { relatedTarget: document.body });
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS - 1));
    expect(card()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(card()).toBeNull();
  });

  it('closes after leaving the card itself, on the same grace', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => trigger().focus());
    fireEvent.mouseOver(card()!);
    fireEvent.mouseOut(card()!, { relatedTarget: document.body });
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS));
    expect(card()).toBeNull();
  });

  it('keeps the card when the pointer crosses from the trigger into it within the grace', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => trigger().focus());
    fireEvent.mouseOut(trigger(), { relatedTarget: card()! });
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS - 1));
    fireEvent.mouseOver(card()!);
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS * 3));
    expect(card()).not.toBeNull();
  });

  it('keeps the card when the pointer comes back onto the trigger during the grace', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => trigger().focus());
    fireEvent.mouseOut(trigger(), { relatedTarget: document.body });
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS - 1));
    fireEvent.mouseOver(trigger());
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS * 2));
    expect(card()).not.toBeNull();
  });
});

describe('useHoverCard — keyboard', () => {
  it('opens at once on keyboard focus (UI-R22)', () => {
    render(<Harness />);
    act(() => trigger().focus());
    expect(card()).not.toBeNull();
  });

  it('keeps the card while Tab moves from the trigger into it, and closes when focus leaves both', () => {
    render(<Harness />);
    act(() => trigger().focus());
    act(() => inside().focus());
    expect(card()).not.toBeNull();
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => outside.focus());
    expect(card()).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger without re-opening the card', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => trigger().focus());
    act(() => inside().focus());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    // The focus the Escape handler returned must not be read as a fresh focus-open.
    act(() => void vi.advanceTimersByTime(1000));
    expect(card()).toBeNull();
  });

  it('closes on Escape without stealing focus when the card did not hold it', () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.mouseOver(trigger());
    act(() => void vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS));
    expect(card()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves an Escape an overlay above already claimed (defaultPrevented)', () => {
    render(<Harness />);
    act(() => trigger().focus());
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    act(() => void document.dispatchEvent(event));
    expect(card()).not.toBeNull();
  });
});

describe('useHoverCard — surfaces', () => {
  it('closes on a click outside the trigger and the card', () => {
    render(<Harness />);
    act(() => trigger().focus());
    const outside = document.createElement('div');
    document.body.append(outside);
    fireEvent.click(outside);
    expect(card()).toBeNull();
  });

  it('keeps the card when the click lands inside it', () => {
    render(<Harness />);
    act(() => trigger().focus());
    fireEvent.click(inside());
    expect(card()).not.toBeNull();
  });

  it('closes when another hover card opens, and the opening card claims the surface', () => {
    render(
      <>
        <Harness id="card-a" />
        <Harness id="card-b" />
      </>,
    );
    act(() => trigger('card-a').focus());
    expect(card('card-a')).not.toBeNull();
    const seen: string[] = [];
    const listener = (e: Event): void => void seen.push((e as CustomEvent<{ id: string }>).detail.id);
    document.addEventListener('karst-surface-open', listener);
    try {
      act(() => trigger('card-b').focus());
    } finally {
      document.removeEventListener('karst-surface-open', listener);
    }
    expect(card('card-a')).toBeNull();
    expect(card('card-b')).not.toBeNull();
    expect(seen).toEqual(['card-b']);
  });

  it('closes when the header menu or a PR popover opens', () => {
    render(<Harness />);
    act(() => trigger().focus());
    act(() => announceSurfaceOpen('header-menu'));
    expect(card()).toBeNull();
    act(() => trigger().blur());
    act(() => trigger().focus());
    expect(card()).not.toBeNull();
    act(() => announceSurfaceOpen('pr-info'));
    expect(card()).toBeNull();
  });

  it('never opens while disabled, and closes when it turns disabled', () => {
    const { rerender } = render(<Harness />);
    act(() => trigger().focus());
    expect(card()).not.toBeNull();
    rerender(<Harness enabled={false} />);
    expect(card()).toBeNull();
    act(() => trigger().blur());
    act(() => trigger().focus());
    expect(card()).toBeNull();
  });
});
