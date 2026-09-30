// @vitest-environment jsdom
import { describe, it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderWebview, renderWebviewReady } from './testing/renderHarness.js';
import type { WebviewName } from '../model/webviewChains.js';

const UI_DIR = import.meta.dirname!;

const WEBVIEWS = readdirSync(UI_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(UI_DIR, name, 'webview.html'));
      return true;
    } catch {
      return false;
    }
  })
  .sort();

describe('measure floor counts', () => {
  const results: Record<string, any> = {};

  for (const name of WEBVIEWS) {
    it(`${name}: measure element counts`, async () => {
      let handle;
      if (name === 'settings') {
        const { vi } = await import('vitest');
        vi.useFakeTimers();
        try {
          handle = await renderWebviewReady(name as WebviewName);
        } finally {
          vi.useRealTimers();
        }
      } else {
        handle = await renderWebviewReady(name as WebviewName);
      }

      const inputs = handle.queryAll('input:not([type="hidden"]), select, textarea').length;
      const buttons = handle.queryAll('button').length;
      const links = handle.queryAll('a').length;
      const focusables = handle.queryAll('button, a, input:not([type="hidden"]), select, textarea, [tabindex]').length;

      results[name] = { inputs, buttons, links, focusables };
      handle.close();
    });
  }

  it('write results to file', () => {
    const output = Object.entries(results)
      .map(([name, counts]) => `${name}: inputs=${counts.inputs}, buttons=${counts.buttons}, links=${counts.links}, focusables=${counts.focusables}`)
      .join('\n');
    writeFileSync('/tmp/measure-floors-output.txt', output);
  });
});
