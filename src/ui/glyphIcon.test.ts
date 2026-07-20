import { describe, it, expect } from 'vitest';
import { tintSvg } from './glyphIcon.js';

const SRC = '<svg stroke="currentColor"><circle/></svg>';

describe('tintSvg', () => {
  it('replaces every currentColor with the hex', () => {
    expect(tintSvg(SRC, '#e35555')).toBe('<svg stroke="#e35555"><circle/></svg>');
  });
  it('is a no-op when there is no currentColor', () => {
    expect(tintSvg('<svg stroke="#000"/>', '#e35555')).toBe('<svg stroke="#000"/>');
  });
  it('leaves the source string unmutated (returns a new string)', () => {
    const src = SRC;
    tintSvg(src, '#38a86b');
    expect(src).toBe(SRC);
  });
});
