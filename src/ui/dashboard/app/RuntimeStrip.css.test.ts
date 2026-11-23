/** Source-text guards for the runtime strip rules: they catch DELETION, not visual regression. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'RuntimeStrip.css'), 'utf8');

/** The brace-balanced block opened at the first `needle`. */
function block(needle: string): string {
  const at = CSS.indexOf(needle);
  expect(at, `missing ${needle}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf('{', at); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced block at ${needle}`);
}

describe('RuntimeStrip.css — the sandbox safety fact stays visible (DB-6, UI-R43, UI-R44)', () => {
  it('never hides the sandbox detail at a narrow width', () => {
    expect(block('@container runtime (max-width: 699px)')).not.toMatch(/\.rs-sub--sandbox\s*\{[^}]*display:\s*none/);
  });

  it('lets the sandbox detail shrink to its ellipsis instead of pushing the strip sideways', () => {
    const rule = block('.rs-sub--sandbox {') || block('.rs-sub--sandbox{');
    expect(rule).toContain('min-width: 0');
    expect(block('.rs-sub {')).toContain('text-overflow: ellipsis');
  });
});
