import { describe, it, expect } from 'vitest';
import { resolveSidebarEdge, normalizeEdgeSetting } from './edge.js';

describe('resolveSidebarEdge', () => {
  // Every enum value against both docked sidebar locations.
  for (const location of ['left', 'right'] as const) {
    it(`auto resolves opposite sideBar.location=${location}`, () => {
      expect(resolveSidebarEdge('auto', location)).toBe(location === 'left' ? 'right' : 'left');
    });

    it(`left pins the left edge (location=${location})`, () => {
      expect(resolveSidebarEdge('left', location)).toBe('left');
    });

    it(`right pins the right edge (location=${location})`, () => {
      expect(resolveSidebarEdge('right', location)).toBe('right');
    });

    it(`none hides the line (location=${location})`, () => {
      expect(resolveSidebarEdge('none', location)).toBe('none');
    });
  }

  it('treats a missing/unknown setting as auto', () => {
    expect(resolveSidebarEdge(undefined, 'left')).toBe('right');
    expect(resolveSidebarEdge(null, 'right')).toBe('left');
    expect(resolveSidebarEdge('bogus', 'left')).toBe('right');
  });

  it('treats a missing/unknown location as left (VS Code default)', () => {
    expect(resolveSidebarEdge('auto', undefined)).toBe('right');
    expect(resolveSidebarEdge('auto', 'bogus')).toBe('right');
  });
});

describe('normalizeEdgeSetting', () => {
  it('passes through the known values and defaults the rest to auto', () => {
    expect(normalizeEdgeSetting('auto')).toBe('auto');
    expect(normalizeEdgeSetting('left')).toBe('left');
    expect(normalizeEdgeSetting('right')).toBe('right');
    expect(normalizeEdgeSetting('none')).toBe('none');
    expect(normalizeEdgeSetting(undefined)).toBe('auto');
    expect(normalizeEdgeSetting('nope')).toBe('auto');
  });
});
