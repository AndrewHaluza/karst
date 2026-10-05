/**
 * NDL-219 — the theme body class has to reach the stage palette.
 *
 * `src/model/stagePalette.ts` has exactly two cascade layers: `:root` carries
 * the dark values and `body.vscode-light` overrides them with the light ones.
 * High contrast deliberately has no block of its own — it falls through to
 * `:root`, which carries the higher contrast of the pair. Nothing else in the
 * tree keys off `body.vscode-*`.
 *
 * The harness used to inject the class only when the markup contained a
 * literal `<body>` tag, and seven of the nine webview fragments have none, so
 * those views rendered the dark palette in every theme. That is why
 * `light:span.stage.stg-impl` measured 3.13:1 instead of the ~5.7 its light
 * value gives (NDL-217's ratchet recorded the symptom, not the cause).
 *
 * These assertions read computed style in the live fixture rather than the
 * pixels: they fail on the cascade, which is the thing that was actually
 * broken. The baselines can only pin what the CSS decides.
 */
import { test as karstTest, expect } from './fixtures.js';
import { STAGE_COLORS } from '../../src/model/stagePalette.js';
import { THEMES, type ThemeId } from './themes.js';

/** Only the three real theme projects derive a body class worth checking. */
const THEME_PROJECTS = new Set(['dark', 'light', 'hc']);

/** Stages the dashboard's pending fixture renders as a chip. */
const STAGES = ['done', 'impl'] as const;

/**
 * Which of the palette's two layers each theme resolves to. `hc` inherits
 * `:root` on purpose, so a *correct* harness gives it the dark values.
 */
const LAYER: Record<ThemeId, 'dark' | 'light'> = {
  dark: 'dark',
  light: 'light',
  hc: 'dark',
};

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

karstTest.describe('NDL-219: the theme body class reaches the stage palette', () => {
  karstTest('document.body carries the theme class', async ({ gotoView, page, theme }, testInfo) => {
    if (!THEME_PROJECTS.has(testInfo.project.name)) {
      testInfo.skip();
      return;
    }
    await gotoView('dashboard');
    const className = await page.evaluate(() => document.body.className);
    expect(className).toBe(THEMES[theme].bodyClass);
  });

  for (const stage of STAGES) {
    karstTest(
      `.stg-${stage} computes its stage token from the theme's layer`,
      async ({ gotoView, page, theme }, testInfo) => {
        if (!THEME_PROJECTS.has(testInfo.project.name)) {
          testInfo.skip();
          return;
        }
        await gotoView('dashboard');

        // `span.stage` — the subtask chip. The dashboard's stepper also carries
        // `stg-*` classes on its `.seg` segments, but those are deliberately
        // painted from the status ramp (`--vscode-disabledForeground` while
        // pending), not from the stage hue, so a bare `.stg-*` locator would
        // read the wrong element.
        const badge = page.locator(`span.stage.stg-${stage}`);
        expect(await badge.count(), `fixture renders span.stage.stg-${stage}`).toBe(1);

        const measured = await badge.evaluate((el, key) => ({
          token: getComputedStyle(document.body)
            .getPropertyValue(`--stage-${key}`)
            .trim(),
          color: getComputedStyle(el).color,
        }), stage);

        const expected = STAGE_COLORS[stage][LAYER[theme]];

        // The token itself resolves on <body>, so this only passes when the
        // theme class is on the element and won the cascade.
        expect(measured.token.toLowerCase()).toBe(expected.toLowerCase());

        // And the badge actually consumes that token.
        expect(measured.color).toBe(hexToRgb(expected));
      },
    );
  }
});
