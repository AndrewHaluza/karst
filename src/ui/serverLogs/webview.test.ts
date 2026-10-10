import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

describe('serverLogs webview.html', () => {
  it('stays uncapped (UI-R48)', () => {
    expect(HTML).not.toContain('--k-content-max');
  });
});
