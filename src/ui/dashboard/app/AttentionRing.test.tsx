// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttentionRing, ATTENTION_DURATION_MS } from './AttentionRing.js';
import { DashboardAppProvider } from './DashboardAppContext.js';
import { createSender } from '../webviewSend.js';
import type { HostMessage } from '../messages.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'AttentionRing.css'), 'utf8');

describe('AttentionRing', () => {
  let subscriber: ((msg: HostMessage) => void) | null = null;
  let styleEl: HTMLStyleElement | null = null;

  const bridge = {
    send: createSender({ postMessage: () => {} }),
    getState: () => null,
    setState: vi.fn(),
    subscribe: (listener: (msg: HostMessage) => void) => {
      subscriber = listener;
      return () => { subscriber = null; };
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    styleEl?.remove();
    styleEl = null;
  });

  const renderComponent = () => render(
    <DashboardAppProvider bridge={bridge as never}>
      <AttentionRing />
    </DashboardAppProvider>
  );

  it('renders into document.body with data-region="attention" and aria-hidden="true"', () => {
    renderComponent();
    const el = document.body.querySelector('.attention-ring');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-region')).toBe('attention');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.classList.contains('pulsing')).toBe(false);
  });

  it('adds pulsing class on attention message and clears it after duration', () => {
    renderComponent();
    const el = document.body.querySelector('.attention-ring')!;

    act(() => {
      subscriber?.({ type: 'attention' });
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(ATTENTION_DURATION_MS - 10);
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(el.classList.contains('pulsing')).toBe(false);
  });

  it('restarts animation on rapid repeat clicks without stacking', () => {
    renderComponent();
    const el = document.body.querySelector('.attention-ring')!;

    act(() => {
      subscriber?.({ type: 'attention' });
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Trigger second click halfway through
    act(() => {
      subscriber?.({ type: 'attention' });
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    // After 600ms from second click (1100ms total), it should still be pulsing
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    // After remaining 500ms (1100ms from second click), it clears
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(el.classList.contains('pulsing')).toBe(false);

    // Ensure only one overlay element exists in document.body
    expect(document.body.querySelectorAll('.attention-ring')).toHaveLength(1);
  });

  it('frames the full dashboard edge at the 320px floor and wider widths without layout shift', () => {
    renderComponent();
    const el = document.body.querySelector('.attention-ring') as HTMLElement;
    expect(el).not.toBeNull();

    // Verify fixed inset 0 framing at 320px viewport width
    window.innerWidth = 320;
    window.innerHeight = 600;
    const computed = window.getComputedStyle(el);
    expect(computed.position).toBe('fixed');
    expect(computed.top).toBe('0px');
    expect(computed.left).toBe('0px');
    expect(computed.right).toBe('0px');
    expect(computed.bottom).toBe('0px');
    expect(computed.pointerEvents).toBe('none');
    expect(computed.boxSizing).toBe('border-box');
  });

  it('stacks below menus, popovers, and drawers, but above normal content', () => {
    const popover = document.createElement('div');
    popover.className = 'popover';
    popover.style.zIndex = '50';
    document.body.appendChild(popover);

    const menu = document.createElement('div');
    menu.className = 'stageMenu';
    menu.style.zIndex = '40';
    document.body.appendChild(menu);

    const content = document.createElement('div');
    content.className = 'panel';
    content.style.zIndex = '1';
    document.body.appendChild(content);

    renderComponent();
    const ring = document.body.querySelector('.attention-ring') as HTMLElement;

    const ringZ = parseInt(window.getComputedStyle(ring).zIndex || '20', 10);
    const popoverZ = parseInt(window.getComputedStyle(popover).zIndex, 10);
    const menuZ = parseInt(window.getComputedStyle(menu).zIndex, 10);
    const contentZ = parseInt(window.getComputedStyle(content).zIndex, 10);

    expect(ringZ).toBeGreaterThan(contentZ);
    expect(ringZ).toBeLessThan(menuZ);
    expect(ringZ).toBeLessThan(popoverZ);

    document.body.removeChild(popover);
    document.body.removeChild(menu);
    document.body.removeChild(content);
  });

  it('cleans up active timer on unmount', () => {
    const { unmount } = renderComponent();
    act(() => {
      subscriber?.({ type: 'attention' });
    });
    unmount();
    // Does not throw after timers advance post-unmount
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(ATTENTION_DURATION_MS);
      });
    }).not.toThrow();
  });
});
