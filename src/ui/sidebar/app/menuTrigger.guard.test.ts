/** Static guard: a button that opens a row menu must carry data-menu, or the ContextMenu outside-click rule closes the menu at once. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

describe('menu trigger guard', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
  it.each(files)('%s: each openMenu(e.currentTarget, ...) trigger has a data-menu attribute', (f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(count(src, /data-menu=\{/g)).toBeGreaterThanOrEqual(count(src, /openMenu\(e\.currentTarget\b/g));
  });
});
