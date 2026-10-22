// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { App } from './App.js';

describe('Dashboard App (Phase 1 Shell)', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-karst-ready');
  });

  it('renders the dashboard app shell and sets data-karst-ready on mount', () => {
    const postMessage = vi.fn();
    (globalThis as unknown as { vscode: unknown }).vscode = {
      postMessage,
      getState: () => null,
      setState: vi.fn(),
    };

    expect(document.documentElement.hasAttribute('data-karst-ready')).toBe(false);

    render(<App />);

    expect(document.documentElement.getAttribute('data-karst-ready')).toBe('true');
    expect(screen.getByTestId('dashboard-app-root')).toBeTruthy();
  });
});
