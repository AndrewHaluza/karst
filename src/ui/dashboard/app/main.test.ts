// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

describe('dashboard app main entry', () => {
  it('throws an error if #root container is missing', async () => {
    document.body.innerHTML = '';
    (globalThis as unknown as { vscode: unknown }).vscode = {
      postMessage: vi.fn(),
      getState: () => null,
      setState: vi.fn(),
    };

    await expect(async () => {
      await import('./main.js');
    }).rejects.toThrow(/dashboard app: #root element is missing/);
  });
});

describe('dashboard app main entry — host contract', () => {
  const g = globalThis as unknown as { vscode?: unknown; __karstSubscribe?: (l: (m: unknown) => void) => () => void };

  it('throws when the page has no vscode API instead of substituting a no-op', async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
    delete g.vscode;
    await expect(import('./main.js')).rejects.toThrow(/window\.vscode is missing/);
  });

  it('replays messages buffered before the first subscriber exactly once', async () => {
    vi.resetModules();
    vi.doMock('./App.js', () => ({ App: () => null }));
    document.body.innerHTML = '<div id="root"></div>';
    g.vscode = { postMessage: vi.fn(), getState: () => null, setState: vi.fn() };
    await import('./main.js');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'edge', side: 'left' } }));

    const first = vi.fn();
    const second = vi.fn();
    g.__karstSubscribe!(first);
    g.__karstSubscribe!(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    vi.doUnmock('./App.js');
  });
});
