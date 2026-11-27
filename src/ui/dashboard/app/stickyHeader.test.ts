// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachStickyHeader } from './stickyHeader.js';

type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void;
type ROCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;

class FakeIO {
  static instances: FakeIO[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: IOCallback) {
    FakeIO.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  trigger(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

class FakeRO {
  static instances: FakeRO[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: ROCallback) {
    FakeRO.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const rect = (height: number): DOMRect => ({ height, width: 100, x: 0, y: 0, top: 0, right: 100, bottom: height, left: 0, toJSON: () => ({}) }) as DOMRect;
const size = (el: Element, height: number): void => {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(height));
};

function page(): void {
  document.body.innerHTML =
    '<div class="dhead" data-region="ticket-head"></div>' +
    '<div id="headerMeta" class="headerMeta" hidden></div>' +
    '<div id="runtimeRoot" data-region="runtime"></div>' +
    '<div id="viewsRoot" class="viewsroot hidden" data-region="views"></div>';
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ paddingTop: '24px', paddingBottom: '24px', marginTop: '0px', marginBottom: '0px' } as CSSStyleDeclaration);
  const dhead = document.getElementsByClassName('dhead')[0]!;
  size(dhead, 64);
  size(document.getElementById('headerMeta')!, 24);
  size(document.getElementById('runtimeRoot')!, 40);
  size(document.getElementById('viewsRoot')!, 0);
}

const prop = (name: string): string => document.documentElement.style.getPropertyValue(name);

describe('stickyHeader', () => {
  beforeEach(() => {
    FakeIO.instances = [];
    FakeRO.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.stubGlobal('ResizeObserver', FakeRO);
    page();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('style');
  });

  it('puts the 1px sentinel immediately before the header row and removes it on cleanup', () => {
    const dhead = document.getElementsByClassName('dhead')[0]!;
    const detach = attachStickyHeader(document);
    const sentinel = dhead.previousElementSibling!;
    expect(sentinel.classList.contains('dheadSentinel')).toBe(true);
    expect(sentinel.getAttribute('aria-hidden')).toBe('true');
    expect(FakeIO.instances[0]?.observed).toContain(sentinel);
    detach();
    expect(document.querySelector('.dheadSentinel')).toBeNull();
  });

  it('sets data-stuck while the sentinel is scrolled out, and clears it when it comes back', () => {
    const dhead = document.getElementsByClassName('dhead')[0] as HTMLElement;
    attachStickyHeader(document);
    const io = FakeIO.instances[0]!;
    expect(dhead.dataset.stuck).toBeUndefined();
    io.trigger(false);
    expect(dhead.dataset.stuck).toBe('true');
    io.trigger(true);
    expect(dhead.dataset.stuck).toBeUndefined();
  });

  it('writes the header height and the drill chrome from the four chrome rows plus the page padding', () => {
    const dhead = document.getElementsByClassName('dhead')[0]!;
    attachStickyHeader(document);
    expect(prop('--k-headbar-h')).toBe('64px');
    // 24 + 24 (body padding) + 64 (row 1) + 24 (row 2) + 40 (runtime strip) + 0 (view pills).
    expect(prop('--k-drill-chrome')).toBe('176px');
    expect(FakeRO.instances[0]?.observed).toEqual([
      dhead,
      document.getElementById('headerMeta'),
      document.getElementById('runtimeRoot'),
      document.getElementById('viewsRoot'),
    ]);
    expect(FakeRO.instances[0]?.observed).not.toContain(document.documentElement);
  });

  it('skips a redundant property write when a resize measures the same integer', () => {
    attachStickyHeader(document);
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty');
    FakeRO.instances[0]!.trigger();
    FakeRO.instances[0]!.trigger();
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('rewrites when the measured height changes', () => {
    const dhead = document.getElementsByClassName('dhead')[0]!;
    attachStickyHeader(document);
    size(dhead, 88);
    FakeRO.instances[0]!.trigger();
    expect(prop('--k-headbar-h')).toBe('88px');
    expect(prop('--k-drill-chrome')).toBe('200px');
  });

  it('disconnects both observers and clears the row state and the properties on unmount', () => {
    const dhead = document.getElementsByClassName('dhead')[0] as HTMLElement;
    const detach = attachStickyHeader(document);
    FakeIO.instances[0]!.trigger(false);
    detach();
    expect(FakeIO.instances[0]?.disconnected).toBe(true);
    expect(FakeRO.instances[0]?.disconnected).toBe(true);
    expect(dhead.dataset.stuck).toBeUndefined();
    expect(prop('--k-headbar-h')).toBe('');
    expect(prop('--k-drill-chrome')).toBe('');
  });

  it('still attaches the sentinel with neither observer available, and cleans up', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal('ResizeObserver', undefined);
    const detach = attachStickyHeader(document);
    expect(document.querySelector('.dheadSentinel')).not.toBeNull();
    expect(prop('--k-headbar-h')).toBe('64px');
    expect(() => detach()).not.toThrow();
  });

  it('is a no-op on a document without the header row', () => {
    document.body.innerHTML = '<div id="other"></div>';
    const before = document.body.innerHTML;
    const detach = attachStickyHeader(document);
    expect(document.body.innerHTML).toBe(before);
    expect(() => detach()).not.toThrow();
  });
});
