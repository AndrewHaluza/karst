// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { attachAnchoredPopover, computePlacement, type Box } from './anchoredPopover.js';

const VIEW = { width: 400, height: 600 };
const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

describe('computePlacement', () => {
  it('opens below the trigger with a 4 px gap', () => {
    const p = computePlacement({ trigger: box(20, 100, 30, 20), popover: { width: 200, height: 100 }, viewport: VIEW });
    expect(p).toMatchObject({ left: 20, top: 124, side: 'below', maxHeight: null, triggerVisible: true });
  });

  it('flips above when the space below is smaller than the measured height', () => {
    const p = computePlacement({ trigger: box(20, 520, 30, 20), popover: { width: 200, height: 150 }, viewport: VIEW });
    expect(p.side).toBe('above');
    expect(p.top).toBe(520 - 4 - 150);
    expect(p.maxHeight).toBeNull();
  });

  it('does not flip when the popover fits below exactly', () => {
    const p = computePlacement({ trigger: box(20, 100, 30, 20), popover: { width: 200, height: 600 - 124 - 8 }, viewport: VIEW });
    expect(p.side).toBe('below');
  });

  it('clamps inside the viewport and caps the height when neither side fits', () => {
    const p = computePlacement({ trigger: box(20, 300, 30, 20), popover: { width: 200, height: 700 }, viewport: VIEW });
    // Below has 600-324-8 = 268, above has 300-4-8 = 288: the larger side wins.
    expect(p.side).toBe('above');
    expect(p.maxHeight).toBe(288);
    expect(p.top).toBe(8);
  });

  it('caps the height on the below side when below is the larger side', () => {
    const p = computePlacement({ trigger: box(20, 50, 30, 20), popover: { width: 200, height: 900 }, viewport: VIEW });
    expect(p.side).toBe('below');
    expect(p.maxHeight).toBe(600 - 74 - 8);
    expect(p.top).toBe(74);
  });

  it('clamps horizontally with an 8 px gutter on the right', () => {
    const p = computePlacement({ trigger: box(380, 100, 10, 20), popover: { width: 200, height: 50 }, viewport: VIEW });
    expect(p.left).toBe(400 - 200 - 8);
  });

  it('clamps horizontally with an 8 px gutter on the left', () => {
    const p = computePlacement({ trigger: box(-30, 100, 10, 20), popover: { width: 200, height: 50 }, viewport: VIEW });
    expect(p.left).toBe(8);
  });

  it('shrinks the width to the viewport minus both gutters', () => {
    const p = computePlacement({ trigger: box(20, 100, 10, 20), popover: { width: 900, height: 50 }, viewport: VIEW });
    expect(p.width).toBe(384);
    expect(p.left).toBe(8);
  });

  it('reports a trigger that is fully scrolled out of view', () => {
    const above = computePlacement({ trigger: box(20, -40, 30, 20), popover: { width: 200, height: 50 }, viewport: VIEW });
    const below = computePlacement({ trigger: box(20, 620, 30, 20), popover: { width: 200, height: 50 }, viewport: VIEW });
    const left = computePlacement({ trigger: box(-60, 100, 30, 20), popover: { width: 200, height: 50 }, viewport: VIEW });
    expect([above.triggerVisible, below.triggerVisible, left.triggerVisible]).toEqual([false, false, false]);
  });

  it('treats a trigger with no layout box as visible', () => {
    const p = computePlacement({ trigger: box(0, 0, 0, 0), popover: { width: 200, height: 50 }, viewport: VIEW });
    expect(p.triggerVisible).toBe(true);
  });

  it('pins the popover inside the viewport while the trigger is out of view', () => {
    const above = computePlacement({ trigger: box(20, -40, 30, 20), popover: { width: 200, height: 50 }, viewport: VIEW });
    const below = computePlacement({ trigger: box(20, 620, 30, 20), popover: { width: 200, height: 50 }, viewport: VIEW });
    expect([above.triggerVisible, above.top]).toEqual([false, 8]);
    expect([below.triggerVisible, below.top]).toEqual([false, 600 - 8 - 50]);
  });

  it('caps a tall popover to the viewport when its trigger is out of view', () => {
    const p = computePlacement({ trigger: box(20, -40, 30, 20), popover: { width: 200, height: 900 }, viewport: VIEW });
    expect(p.top).toBe(8);
    expect(p.maxHeight).toBe(600 - 16);
  });

  it('keeps the popover while the trigger is partly visible', () => {
    const p = computePlacement({ trigger: box(20, -10, 30, 20), popover: { width: 200, height: 50 }, viewport: VIEW });
    expect(p.triggerVisible).toBe(true);
  });
});

describe('computePlacement with an ancestor clip', () => {
  it('reports the trigger hidden when it is inside the viewport but outside the clip box', () => {
    const p = computePlacement({
      trigger: box(20, 300, 30, 20),
      popover: { width: 200, height: 100 },
      viewport: VIEW,
      clip: box(0, 0, 400, 200),
    });
    expect(p.triggerVisible).toBe(false);
  });

  it('reports the trigger visible when it overlaps the clip box', () => {
    const p = computePlacement({
      trigger: box(20, 190, 30, 20),
      popover: { width: 200, height: 100 },
      viewport: VIEW,
      clip: box(0, 0, 400, 200),
    });
    expect(p.triggerVisible).toBe(true);
  });
});

describe('attachAnchoredPopover', () => {
  function setup(triggerTop: number) {
    const trigger = document.createElement('button');
    const popover = document.createElement('div');
    document.body.append(trigger, popover);
    let top = triggerTop;
    trigger.getBoundingClientRect = () => ({ left: 20, top, right: 50, bottom: top + 20, width: 30, height: 20, x: 20, y: top, toJSON: () => ({}) });
    Object.defineProperty(popover, 'offsetHeight', { configurable: true, value: 100 });
    Object.defineProperty(popover, 'offsetWidth', { configurable: true, value: 200 });
    return { trigger, popover, move: (t: number) => { top = t; } };
  }
  const frame = (): void => {
    vi.runOnlyPendingTimers();
  };

  it('places on attach, follows a capture-phase scroll and a resize, and stops after detach', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const { trigger, popover, move } = setup(100);
    const detach = attachAnchoredPopover({ popover, trigger, width: 200, onTriggerHidden: () => undefined });
    expect(popover.style.top).toBe('124px');
    move(200);
    const inner = document.createElement('div');
    document.body.append(inner);
    inner.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    frame();
    expect(popover.style.top).toBe('224px');
    move(250);
    window.dispatchEvent(new Event('resize'));
    frame();
    expect(popover.style.top).toBe('274px');
    detach();
    move(300);
    window.dispatchEvent(new Event('resize'));
    frame();
    expect(popover.style.top).toBe('274px');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('calls onTriggerHidden once, without moving focus, when the trigger leaves the viewport', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const { trigger, popover, move } = setup(100);
    const input = document.createElement('input');
    popover.append(input);
    input.focus();
    const hidden = vi.fn();
    attachAnchoredPopover({ popover, trigger, width: 200, onTriggerHidden: hidden });
    move(-200);
    window.dispatchEvent(new Event('scroll'));
    frame();
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const stubFrames = (): void => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.stubGlobal('innerWidth', VIEW.width);
    vi.stubGlobal('innerHeight', VIEW.height);
  };
  const restore = (): void => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  };

  it('keeps the scroll position of a capped popover: it never clears the cap between placements', () => {
    stubFrames();
    const { trigger, popover } = setup(300);
    Object.defineProperty(popover, 'offsetHeight', { configurable: true, value: 288 });
    Object.defineProperty(popover, 'clientHeight', { configurable: true, value: 288 });
    Object.defineProperty(popover, 'scrollHeight', { configurable: true, value: 700 });
    const writes: string[] = [];
    let cap = '';
    let scrollTop = 0;
    // A browser clamps scrollTop to 0 when the cap is cleared and the box grows to its natural height.
    Object.defineProperty(popover.style, 'maxHeight', {
      configurable: true,
      get: () => cap,
      set: (v: string) => {
        writes.push(v);
        if (v === '') scrollTop = 0;
        cap = v;
      },
    });
    Object.defineProperty(popover, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; } });
    attachAnchoredPopover({ popover, trigger, width: 200, onTriggerHidden: () => undefined });
    expect(cap).toBe('288px');
    popover.scrollTop = 40;
    window.dispatchEvent(new Event('scroll'));
    frame();
    expect(popover.scrollTop).toBe(40);
    expect(cap).toBe('288px');
    expect(writes).not.toContain('');
    restore();
  });

  it('pins the popover in the viewport and calls onTriggerHidden again only after the trigger returned', () => {
    stubFrames();
    const { trigger, popover, move } = setup(100);
    const hidden = vi.fn();
    attachAnchoredPopover({ popover, trigger, width: 200, onTriggerHidden: hidden });
    move(-200);
    window.dispatchEvent(new Event('scroll'));
    frame();
    expect(popover.style.top).toBe('8px');
    move(900);
    window.dispatchEvent(new Event('scroll'));
    frame();
    expect(popover.style.top).toBe(`${600 - 8 - 100}px`);
    expect(hidden).toHaveBeenCalledTimes(1);
    move(100);
    window.dispatchEvent(new Event('scroll'));
    frame();
    move(-200);
    window.dispatchEvent(new Event('scroll'));
    frame();
    expect(hidden).toHaveBeenCalledTimes(2);
    restore();
  });

  it('leaves the popover where it is when the trigger is detached from the DOM', () => {
    stubFrames();
    const { trigger, popover } = setup(100);
    const hidden = vi.fn();
    attachAnchoredPopover({ popover, trigger, width: 200, onTriggerHidden: hidden });
    expect(popover.style.top).toBe('124px');
    trigger.remove();
    trigger.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    window.dispatchEvent(new Event('scroll'));
    frame();
    expect([popover.style.top, popover.style.left]).toEqual(['124px', '20px']);
    expect(hidden).not.toHaveBeenCalled();
    restore();
  });

  it('calls onTriggerHidden when an ancestor scroll container clips the trigger while it is inside the viewport', () => {
    stubFrames();
    const { trigger, popover, move } = setup(100);
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.append(scroller);
    scroller.append(trigger);
    scroller.getBoundingClientRect = () => ({ left: 0, top: 50, right: 400, bottom: 250, width: 400, height: 200, x: 0, y: 50, toJSON: () => ({}) });
    const hidden = vi.fn();
    attachAnchoredPopover({ popover, trigger, width: 200, onTriggerHidden: hidden });
    expect(hidden).not.toHaveBeenCalled();
    move(400);
    scroller.dispatchEvent(new Event('scroll'));
    frame();
    expect(hidden).toHaveBeenCalledTimes(1);
    restore();
  });

  it('places again when the popover content changes its height', () => {
    stubFrames();
    let notify: () => void = () => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          notify = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const { trigger, popover } = setup(450);
    const height = { value: 100 };
    Object.defineProperty(popover, 'offsetHeight', { configurable: true, get: () => height.value });
    attachAnchoredPopover({ popover, trigger, width: 200, onTriggerHidden: () => undefined });
    expect(popover.style.top).toBe('474px');
    height.value = 200;
    notify();
    frame();
    expect(popover.style.top).toBe(`${450 - 4 - 200}px`);
    restore();
  });

  it("matches the trigger's width on every placement when width is 'trigger'", () => {
    stubFrames();
    const { trigger, popover } = setup(100);
    attachAnchoredPopover({ popover, trigger, width: 'trigger', onTriggerHidden: () => undefined });
    expect(popover.style.width).toBe('30px');
    restore();
  });
});
