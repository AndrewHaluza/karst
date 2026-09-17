import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tintSvg } from './glyphIcon.js';

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'media');

// Verbatim from the approved source (multi-line `d` formatting included — a
// drift in either coordinates or the canonical formatting fails the pin).
const LEFT_SHELL = 'M 96 20\n       L 25 67\n       L 25 156\n       L 98 203\n       L 98 180\n       L 44 145\n       L 44 78\n       L 97 44\n       Z';
const RIGHT_SHELL = 'M 151 42\n       L 138 58\n       L 170 78\n       L 170 144\n       L 138 165\n       L 150 180\n       L 188 156\n       L 188 67\n       Z';

describe('brand assets', () => {
  const full = readFileSync(join(MEDIA, 'karst.svg'), 'utf8');
  const mark = readFileSync(join(MEDIA, 'karst-mark.svg'), 'utf8');

  it('karst.svg carries the approved geometry verbatim (no drift)', () => {
    expect(full).toContain(LEFT_SHELL);
    expect(full).toContain(RIGHT_SHELL);
    expect(full).toContain('<circle cx="106.5" cy="111.5" r="26.5"');
  });

  // The activity-bar asset is monochrome: VS Code tints it per active/inactive
  // state, so every fill is currentColor and no gradient may remain baked in.
  it('karst.svg is a currentColor silhouette with no baked-in gradient', () => {
    expect(full).not.toContain('linearGradient');
    expect(full).toContain('currentColor');
  });

  it('the old three-node graph is gone from both assets', () => {
    for (const svg of [full, mark]) {
      expect(svg).not.toContain('cx="6"');
      expect(svg).not.toContain('cx="18"');
      expect(svg).not.toContain('cy="18"');
      expect(svg).not.toContain('7.6 7.6');
    }
  });

  it('karst-mark.svg is the SAME geometry as a currentColor silhouette', () => {
    expect(mark).toContain(LEFT_SHELL);
    expect(mark).toContain(RIGHT_SHELL);
    expect(mark).toContain('<circle cx="106.5" cy="111.5" r="26.5"');
    expect(mark).not.toContain('linearGradient');
    expect(mark).toContain('currentColor');
  });

  it('tinting the monochrome mark replaces every currentColor (tintSvg contract)', () => {
    const tinted = tintSvg(mark, '#e35555');
    expect(tinted).not.toContain('currentColor');
    expect(tinted).toContain('#e35555');
  });
});
