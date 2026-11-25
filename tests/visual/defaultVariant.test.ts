import { describe, expect, it } from 'vitest';
import { ALL_VIEWS } from './corpora.js';
import { DEFAULT_VARIANT } from './defaultVariant.js';
import { THEME_IDS } from './themes.js';
import { VARIANTS } from './variants.js';

describe('DEFAULT_VARIANT (ui:VISUAL-VARIANTS)', () => {
  it('names a registered variant of each view that every fixture theme records', () => {
    for (const view of ALL_VIEWS) {
      const v = VARIANTS[view].find((x) => x.id === DEFAULT_VARIANT[view]);
      expect(v, `${view}/${DEFAULT_VARIANT[view]}`).toBeDefined();
      expect(v!.themes).toEqual(expect.arrayContaining([...THEME_IDS]));
    }
  });

  it('keeps the ratchet pages: dashboard pending and settings minimal', () => {
    expect(DEFAULT_VARIANT.dashboard).toBe('pending');
    expect(DEFAULT_VARIANT.settings).toBe('minimal');
  });
});
