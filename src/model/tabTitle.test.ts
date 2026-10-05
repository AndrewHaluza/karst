import { describe, it, expect } from 'vitest';
import { tabTitle, TAB_TITLE_MAX } from './tabTitle.js';

describe('tabTitle', () => {
  it('keeps a short label as is', () => {
    expect(tabTitle('ABC-1 — Fix login')).toBe('ABC-1 — Fix login');
  });

  it('cuts a long label to the cap with an ellipsis', () => {
    const title = tabTitle(`ABC-1 — ${'word '.repeat(30)}`);
    expect(title.length).toBe(TAB_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(title.startsWith('ABC-1 — word')).toBe(true);
  });

  it('never cuts a surrogate pair in half', () => {
    const title = tabTitle(`${'a'.repeat(TAB_TITLE_MAX - 2)}😀😀😀`);
    expect(title).not.toMatch(/[\uD800-\uDBFF]…$/);
  });

  it('trims trailing space before the ellipsis', () => {
    const title = tabTitle(`${'a'.repeat(TAB_TITLE_MAX - 2)}   tail`);
    expect(title).toBe(`${'a'.repeat(TAB_TITLE_MAX - 2)}…`);
  });
});
