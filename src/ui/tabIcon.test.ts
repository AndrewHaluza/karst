import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * DISCOVERED, never enumerated — same reason as `webviewCsp.test.ts`. A tab that
 * ships with no `iconPath` looks like any other editor tab: nothing throws, no
 * test fails, the panel is just unbranded. A hand-written list would let the next
 * webview host do exactly that. Discovery binds this to every panel that exists.
 */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

const CREATORS = walk(SRC)
  .filter((p) => readFileSync(p, 'utf8').includes('createWebviewPanel('))
  .map((p) => relative(SRC, p))
  .sort();

// Guards the discovery itself: a filter that silently matched nothing would turn
// the assertion below into a no-op that still reports green.
describe('webview panel host discovery', () => {
  it('finds every module that mints a webview panel today', () => {
    expect(CREATORS).toEqual([
      'extension.ts',
      'ui/onboarding/host.ts',
      'ui/settings/host.ts',
      'ui/welcome/host.ts',
    ]);
  });
});

describe.each(CREATORS)('%s', (rel) => {
  it('gives every panel it mints a karst tab icon', () => {
    const src = readFileSync(join(SRC, rel), 'utf8');
    // One slice per creation site: from the call to the next call (or EOF), so a
    // file that ends up minting three panels must brand all three.
    const parts = src.split('createWebviewPanel(').slice(1);
    expect(parts.length).toBeGreaterThan(0);
    for (const [i, part] of parts.entries()) {
      expect(part, `panel #${i + 1} in ${rel} has no iconPath`).toMatch(/\biconPath\s*=/);
    }
  });
});
