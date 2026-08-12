import { describe, it, expect } from 'vitest';
import { terminalNaming } from './terminalNaming.js';

const BRAND = {
  light: '/store/icons/karst-brand.svg',
  dark: '/store/icons/karst-brand.svg',
};

describe('terminalNaming', () => {
  it('names the terminal from the rendered label', () => {
    expect(terminalNaming({ name: 'Karst: PROJ-42 — Fix login' }).name).toBe(
      'Karst: PROJ-42 — Fix login',
    );
  });

  it('carries the status-free full-color brand mark, never a glyph-tinted file', () => {
    const bag = terminalNaming({ name: 'Karst: PROJ-42', brandIcon: BRAND });
    expect(bag.iconPath).toBe('/store/icons/karst-brand.svg');
  });

  it('never sets a color — the tab look is frozen at creation, so a status hue would be the stage-at-launch forever', () => {
    const bag = terminalNaming({ name: 'Karst: PROJ-42', brandIcon: BRAND });
    expect(bag).not.toHaveProperty('color');
  });

  it('degrades to a plain name when the brand asset is unavailable', () => {
    expect(terminalNaming({ name: 'Karst: PROJ-42' })).toEqual({ name: 'Karst: PROJ-42' });
  });
});
