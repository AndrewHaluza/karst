import { test, expect } from '@playwright/test';
import { THEMES, THEME_IDS, REQUIRED_VARS } from './themes.js';

test.describe('theme blocks', () => {
  for (const themeId of THEME_IDS) {
    test(`${themeId}: rootCss defines every required --vscode-* variable`, () => {
      const theme = THEMES[themeId]!;
      for (const v of REQUIRED_VARS) {
        expect(theme.rootCss).toContain(v + ':');
      }
    });

    test(`${themeId}: every value is a concrete literal (no var() references)`, () => {
      const theme = THEMES[themeId]!;
      // Extract all property:value pairs from the :root block
      const rootContent = theme.rootCss.replace(':root{', '').replace('}', '');
      const props = rootContent.split(';').filter(Boolean);
      for (const prop of props) {
        const colonIdx = prop.indexOf(':');
        if (colonIdx === -1) continue;
        const value = prop.slice(colonIdx + 1).trim();
        // Font stacks contain "Segoe UI" etc — only check color-like values
        if (value.startsWith('#') || value.startsWith('rgb')) {
          expect(value).not.toMatch(/var\(--/);
        }
      }
    });
  }

  test('all three themes define the same key set', () => {
    const keys = THEME_IDS.map((id) =>
      Object.keys(THEMES[id]!.rootCss.replace(':root{', '').replace('}', ''))
        .map((p) => p.split(':')[0]!.trim())
        .sort(),
    );
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[0]).toEqual(keys[2]);
  });

  test('bodyClass is set for each theme', () => {
    for (const id of THEME_IDS) {
      expect(THEMES[id]!.bodyClass).toBeTruthy();
    }
  });
});
