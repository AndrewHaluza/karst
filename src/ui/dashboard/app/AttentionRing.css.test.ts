import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'AttentionRing.css'), 'utf8');

describe('AttentionRing.css source guards', () => {
  it('uses focus token for border and sets 2px width', () => {
    expect(CSS).toMatch(/border:\s*(?:calc\(var\(--k-border-w\)\s*\*\s*2\)|2px)\s+solid\s+var\(--k-focus\)/);
  });

  it('uses motion tokens for duration and easing', () => {
    expect(CSS).toContain('var(--k-dur-flash-attention)');
    expect(CSS).toContain('var(--k-ease-out)');
  });

  it('is fixed, inset-0, pointer-events none, and layered below menus/drawers', () => {
    expect(CSS).toContain('position:fixed');
    expect(CSS).toContain('inset:0');
    expect(CSS).toContain('pointer-events:none');
    expect(CSS).toContain('box-sizing:border-box');
    expect(CSS).toContain('z-index:20');
  });

  it('removes animation under prefers-reduced-motion', () => {
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.attention-ring\.pulsing\s*\{[^}]*animation:\s*none/);
  });
});
