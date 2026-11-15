import { describe, expect, it } from 'vitest';
import { clampPageSize, pageRange, paginate } from './paginate.js';

describe('paginate', () => {
  it('clamps the page size', () => {
    expect(clampPageSize(500)).toBe(100);
    expect(clampPageSize(undefined)).toBe(20);
  });
  it('describes the range', () => {
    const p = paginate(Array.from({ length: 45 }, (_, i) => i), 3, 20);
    expect(p.totalPages).toBe(3);
    expect(pageRange(p)).toBe('41-45 of 45');
  });
});
