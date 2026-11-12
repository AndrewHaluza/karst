// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterMenu } from './FilterMenu.js';
import type { SidebarHostBridge } from './hostBridge.js';
import { SidebarProvider } from './SidebarContext.js';

const bridge: SidebarHostBridge = { post: vi.fn(), getState: () => undefined, setState: vi.fn(), subscribe: () => () => undefined };

beforeEach(() => {
  vi.stubGlobal('karstIcon', () => '');
  vi.stubGlobal('karstIsPending', () => false);
  vi.stubGlobal('innerHeight', 300);
  vi.stubGlobal('innerWidth', 400);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  for (const prop of ['offsetHeight', 'scrollHeight', 'clientHeight']) {
    vi.spyOn(HTMLElement.prototype, prop as 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('filter-pop') ? 120 : 0;
    });
  }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('filter-pop') ? 140 : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openAt(top: number): HTMLElement {
  const { container } = render(
    <SidebarProvider bridge={bridge}>
      <FilterMenu />
    </SidebarProvider>,
  );
  const button = container.querySelector<HTMLButtonElement>('[data-filter-menu]')!;
  button.getBoundingClientRect = () => ({ left: 360, top, right: 380, bottom: top + 20, width: 20, height: 20, x: 360, y: top, toJSON: () => ({}) });
  fireEvent.click(button);
  return document.querySelector<HTMLElement>('.filter-pop')!;
}

describe('FilterMenu placement', () => {
  it('opens below the funnel when it fits, clamped inside the right gutter', () => {
    const pop = openAt(20);
    expect([pop.style.top, pop.style.left]).toEqual(['44px', `${400 - 140 - 8}px`]);
  });

  it('flips above the funnel near the bottom edge', () => {
    const pop = openAt(260);
    expect(pop.style.top).toBe(`${260 - 4 - 120}px`);
  });

  it('closes when the funnel scrolls out of view', () => {
    const pop = openAt(20);
    const button = document.querySelector<HTMLButtonElement>('[data-filter-menu]')!;
    button.getBoundingClientRect = () => ({ left: 360, top: -200, right: 380, bottom: -180, width: 20, height: 20, x: 360, y: -200, toJSON: () => ({}) });
    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    expect(pop.isConnected).toBe(false);
  });
});
