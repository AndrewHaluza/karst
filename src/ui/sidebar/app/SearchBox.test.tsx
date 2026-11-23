// @vitest-environment jsdom
/** The search box's clear affordance (SB-9): the button and Escape both post an empty filter. */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarHostMessage } from '../messages.js';
import { EMPTY_STATE } from './format.js';
import type { SidebarHostBridge } from './hostBridge.js';
import { SearchBox } from './SearchBox.js';
import { SidebarProvider } from './SidebarContext.js';

let listener: ((message: SidebarHostMessage) => void) | undefined;
const post = vi.fn();
const bridge: SidebarHostBridge = {
  post,
  getState: () => undefined,
  setState: vi.fn(),
  subscribe: (fn) => {
    listener = fn;
    return () => undefined;
  },
};

beforeEach(() => {
  vi.stubGlobal('karstIcon', () => '');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  post.mockClear();
});

function mounted(filter = 'auth'): HTMLInputElement {
  render(
    <SidebarProvider bridge={bridge}>
      <SearchBox />
    </SidebarProvider>,
  );
  act(() => {
    listener?.({ type: 'state', state: { ...EMPTY_STATE, filter } });
  });
  return document.querySelector<HTMLInputElement>('#search')!;
}

describe('SearchBox clear (SB-9)', () => {
  it('Escape posts an empty filter', () => {
    const input = mounted();
    expect(input.value).toBe('auth');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(post).toHaveBeenCalledWith({ type: 'set-filter', query: '' });
    expect(input.value).toBe('');
  });

  it('shows the clear button only with text and clears on click', () => {
    const input = mounted();
    const clear = document.querySelector<HTMLButtonElement>('[data-search-clear]')!;
    expect(clear.getAttribute('aria-label')).toBe('Clear search');
    fireEvent.click(clear);
    expect(post).toHaveBeenCalledWith({ type: 'set-filter', query: '' });
    expect(document.querySelector('[data-search-clear]')).toBeNull();
    expect(input.value).toBe('');
  });

  it('Escape with an empty box posts nothing', () => {
    const input = mounted('');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(post).not.toHaveBeenCalled();
  });
});
