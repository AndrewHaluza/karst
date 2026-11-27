// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTooltip, TOOLTIP_ID } from './kTooltip.js';

/** A trigger box in viewport coordinates (the delegate only reads top/bottom/left). */
const rectAt = (top: number, height = 22, left = 40, width = 80): DOMRect =>
  ({ top, bottom: top + height, height, left, right: left + width, width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('k-tooltip', () => {
  let uninstall: () => void;
  let btn: HTMLButtonElement;
  const tip = () => document.getElementById(TOOLTIP_ID);

  /** Shows the tip at `rect` with a fixed tip size, re-placing after the jsdom node exists (its offsets are 0 at creation). */
  const hoverAt = (rect: DOMRect, width = 60, height = 20): HTMLElement => {
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(rect);
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const el = tip()!;
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return el;
  };

  beforeEach(() => {
    document.body.innerHTML = '<button id="b" data-tip="Claude Code · Model A" aria-label="Claude Code">x</button><button id="plain">y</button>';
    btn = document.getElementById('b') as HTMLButtonElement;
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720);
    uninstall = installTooltip(document);
  });
  afterEach(() => {
    uninstall();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows on pointer hover with the data-tip text and wires aria-describedby', () => {
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tip()?.textContent).toBe('Claude Code · Model A');
    expect(tip()?.getAttribute('role')).toBe('tooltip');
    expect(btn.getAttribute('aria-describedby')).toBe(TOOLTIP_ID);
  });

  it('shows on keyboard focus and hides on blur', () => {
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tip()?.hidden).toBe(false);
    btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(tip()?.hidden).toBe(true);
    expect(btn.hasAttribute('aria-describedby')).toBe(false);
  });

  it('hides on pointer leave', () => {
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(tip()?.hidden).toBe(true);
  });

  it('hides on Escape without moving focus', () => {
    btn.focus();
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tip()?.hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it('ignores elements without data-tip and keeps one tooltip node', () => {
    document.getElementById('plain')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tip()).toBeNull();
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.querySelectorAll(`#${TOOLTIP_ID}`)).toHaveLength(1);
  });

  it('places the tip below a control with room, and flips above one at the viewport bottom', () => {
    const below = hoverAt(rectAt(100, 22));
    expect(below.style.top).toBe('128px');
    expect(below.style.left).toBe('40px');
    below.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

    // The bottom visible row of the sidebar: 716 + 20 does not fit inside 720, so the hint goes above the control.
    const bottom = hoverAt(rectAt(690, 22));
    expect(bottom.style.top).toBe('664px');
  });

  it('clamps a tip inside the viewport when neither side fits', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(100);
    const el = hoverAt(rectAt(40, 22), 60, 60);
    // Below is 68..128, above is -26..34: neither fits, so the top edge clamps to 100 - 60 - 6.
    expect(el.style.top).toBe('34px');
  });

  it('removes its node and listeners on uninstall', () => {
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    uninstall();
    expect(tip()).toBeNull();
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tip()).toBeNull();
  });
});
