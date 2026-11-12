// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu.js';
import type { SidebarHostBridge } from './hostBridge.js';
import { SidebarProvider, useSidebar, type MenuItem } from './SidebarContext.js';

const ITEM_PX = 30;
const VIEW_HEIGHT = 768;

const item = (key: string, extra: Partial<MenuItem> = {}): MenuItem => ({ key, spec: { act: 'noop', id: 0 } as MenuItem['spec'], label: key, icon: 'dots', ...extra });
const items = (n: number): MenuItem[] => Array.from({ length: n }, (_, i) => item(`i${i}`));

const bridge: SidebarHostBridge = { post: vi.fn(), getState: () => undefined, setState: vi.fn(), subscribe: () => () => undefined };

let open: (items: readonly MenuItem[]) => void = () => undefined;
let trigger: HTMLElement;

function Opener() {
  const { openMenu } = useSidebar();
  open = (list) => openMenu(trigger, 1, list);
  return null;
}

const menuEl = (): HTMLElement => document.getElementById('ctxMenu')!;

function mount(triggerTop: number): void {
  render(
    <SidebarProvider bridge={bridge}>
      <Opener />
      <ContextMenu />
    </SidebarProvider>,
  );
  trigger = document.createElement('button');
  trigger.setAttribute('data-menu', '');
  document.body.append(trigger);
  trigger.getBoundingClientRect = () => ({ left: 20, top: triggerTop, right: 50, bottom: triggerTop + 20, width: 30, height: 20, x: 20, y: triggerTop, toJSON: () => ({}) });
}

beforeEach(() => {
  // jsdom has no layout: every `.ctxitem` is 30 px tall and the window is as tall as its items.
  const rows = function (this: HTMLElement): number {
    return this.id === 'ctxMenu' ? this.querySelectorAll('.ctxitem').length * ITEM_PX : 0;
  };
  for (const prop of ['offsetHeight', 'scrollHeight', 'clientHeight']) {
    vi.spyOn(HTMLElement.prototype, prop as 'offsetHeight', 'get').mockImplementation(rows);
  }
  vi.stubGlobal('karstIcon', () => '<svg></svg>');
  vi.stubGlobal('karstIsPending', () => false);
  vi.stubGlobal('innerHeight', VIEW_HEIGHT);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ContextMenu placement', () => {
  it('re-places when the same trigger opens it again with a taller list', () => {
    mount(100);
    act(() => open(items(3)));
    expect(menuEl().style.maxHeight).toBe('');
    act(() => open(items(40)));
    // 40 rows do not fit: below has 768 - 124 - 8 = 636 px, above only 88.
    expect(menuEl().style.maxHeight).toBe('636px');
  });

  it('re-places when a submenu opens inline and the window grows', () => {
    mount(600);
    const submenu = Array.from({ length: 20 }, (_, i) => item(`s${i}`));
    act(() => open([item('plain'), item('more', { submenu })]));
    expect(menuEl().style.maxHeight).toBe('');
    fireEvent.click(menuEl().querySelector('[aria-haspopup="menu"]')!);
    // 22 rows are 660 px: below has 136 px, above 588 px, so the window caps at the larger side.
    expect(menuEl().style.maxHeight).toBe('588px');
  });
});
