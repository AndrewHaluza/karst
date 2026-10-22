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
