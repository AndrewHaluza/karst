/**
 * Source-text guards for the stage rail rules that moved out of webview.html with the markup (`Rail.css`,
 * `RailRing.css`, `BlockedBanner.css`).
 *
 * Be honest about what these are: a text assertion CANNOT catch a visual regression. It cannot tell you the ring is
 * clipped, fused, or painted under a connector, only that the rule which stops that is still in the file. Each one
 * was written after reproducing the defect in a browser, and each exists so the fix cannot be quietly deleted by
 * someone tidying the CSS. Re-verifying the pixels needs the visual sweep (`npm run -s test:visual:docker`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8');
const RAIL = read('Rail.css');
const RING = read('RailRing.css');
const BANNER = read('BlockedBanner.css');
const ARTIFACT_VIEW = read('ArtifactView.css');
const RAIL_TSX = read('Rail.tsx');
const PAGE = readFileSync(join(HERE, '..', 'webview.html'), 'utf8');

/** The brace-balanced block opened at the first `needle`, not a regex that could run into the next rule. */
function block(css: string, needle: string): string {
  const at = css.indexOf(needle);
  expect(at, `missing ${needle}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced block at ${needle}`);
}
const SUPPORTS = '@supports (width: calc(1px * hypot';

describe('Rail.css — colour and legibility', () => {
  it('keeps the current segment’s text legible on its own wash (UI-R29)', () => {
    // `--k-success-fg` is the KNOCKOUT foreground, paired with a saturated feedback FILL. The running segment is a 34%
    // wash of the stage hue over the lane, so the knockout resolves to (near) the background it sits on.
    expect(RAIL).toMatch(/\.track \.seg\.running\{[^}]*color:var\(--k-text\)/);
    expect(RAIL).not.toMatch(/\.track \.seg[^{]*\{[^}]*color:var\(--k-success-fg\)/);
  });

  it('lets the stage palette win the hue, because the segment never claims it', () => {
    // `.track .seg` is (0,2,0); the injected `stg-<stage>` classes are (0,1,0), so a `color`/`--stg-color` on the scoped
    // rule beats them at ANY source order and every travelled segment renders neutral grey.
    const base = RAIL.match(/\.track \.seg\{[^}]*\}/)?.[0] ?? '';
    expect(base, 'the base segment rule must not set a colour').not.toMatch(/(^|[;{])color:/);
    expect(base, 'the base segment rule must not set --stg-color').not.toContain('--stg-color:');
    expect(RAIL).toMatch(/\.track \.seg\.pending\{color:var\(--k-text-faint\)\}/);
  });

  it('fills travelled Scope segments with their approved background, else the wash (869ej2cfz)', () => {
    expect(RAIL).toMatch(/\.track \.seg\.passed\{background:var\(--stg-bg,color-mix\(in srgb,var\(--stg-color,var\(--k-pending\)\) 20%,transparent\)\);/);
    expect(RAIL).toMatch(/\.track \.seg\.running\{background:var\(--stg-bg,color-mix\(in srgb,var\(--stg-color,var\(--k-pending\)\) 34%,transparent\)\);/);
  });

  it('gives a bypassed stage its own class, distinct from passed', () => {
    expect(RAIL).toMatch(/\.track \.seg\.bypassed\{/);
  });

  it('resolves the selection mark to the shared categorical token, never a hex purple', () => {
    expect(RAIL).toMatch(/\.track \.seg\.sel\{box-shadow:[^}]*var\(--k-series-2\)/);
    expect(RAIL + RING).not.toMatch(/#8957e5|#a371f7|#8a63d2|#c297ff/);
  });

  it('scopes every track selector, so it cannot collide with the strip', () => {
    expect(RAIL).not.toMatch(/^\s*\.seg\{/m);
    expect(RAIL).not.toMatch(/^\s*\.fixm\{/m);
    expect(RAIL).toMatch(/\.track \.seg\{/);
    expect(RAIL).toMatch(/\.track \.fixm\{/);
  });

  it('stops the needs-you breathe under reduced motion (UI-R30), and declares no animation on the spinner it sizes', () => {
    const rm = block(RAIL, '@media (prefers-reduced-motion:reduce)');
    expect(rm).toContain('.track .seg.needs');
    expect(rm).toContain('animation:none');
    // The page's reduced-motion block is (0,1,0); a scoped rule re-declaring the animation would spin again.
    expect(RAIL).not.toMatch(/\.track \.seg \.spin\{[^}]*animation/);
  });
});

describe('Rail.css — the lane and its three measured steps', () => {
  it('keeps the lane scrollable, never clipped', () => {
    // overflow:hidden is what turned an over-wide track into an INVISIBLE defect: the current segment's own action
    // button was clipped away with nothing to say so.
    expect(RAIL).toMatch(/\.lane\{[^}]*overflow-x:auto/);
    expect(RAIL).not.toMatch(/\.lane\{[^}]*overflow:hidden/);
    expect(RAIL).not.toMatch(/\.railwrap\{[^}]*overflow-x:auto/);
  });

  it('degrades in three measured steps, each of which drops something', () => {
    for (const step of ['snug', 'tight', 'bare']) {
      const rules = RAIL.match(new RegExp(`\\.track\\.${step}[^{]*\\{[^}]*\\}`, 'g')) ?? [];
      expect(rules.length, `no .track.${step} rule`).toBeGreaterThan(0);
      expect(rules.some((r) => /display:none|min-width:0|padding/.test(r)), `.track.${step} drops nothing`).toBe(true);
    }
  });

  it('never hides the current segment’s name or its action, at any step', () => {
    const hiders = RAIL.match(/\.track\.(?:snug|tight|bare)[^{]*\{[^}]*display:none[^}]*\}/g) ?? [];
    for (const rule of hiders) {
      const selector = rule.slice(0, rule.indexOf('{'));
      expect(selector, 'a step hides the current segment’s name').not.toMatch(/\.seg\.cur \.nm[,{\s]*$/);
      expect(selector, 'a step hides the current segment’s action').not.toMatch(/\.seg\.cur \.go/);
    }
  });

  it('pushes no geometry from the host: the track is measured, not positioned', () => {
    expect(RAIL).not.toMatch(/--cols/);
  });
});

describe('RailRing.css — the selection and focus ring, in the segment’s own shape', () => {
  const ring = block(RING, SUPPORTS);

  it('loads after the baselines it replaces (same specificity, so source order decides)', () => {
    expect(RAIL_TSX.indexOf("import './Rail.css'")).toBeGreaterThan(-1);
    expect(RAIL_TSX.indexOf("import './Rail.css'")).toBeLessThan(RAIL_TSX.indexOf("import './RailRing.css'"));
    expect(RAIL).toMatch(/\.track \.seg\.sel\{box-shadow:inset[^}]*var\(--k-series-2\)\}/);
  });

  it('marks the selected segment with the segment’s own shape, never a stray edge', () => {
    // A segment is a CHEVRON (clip-path), and `clip-path` clips a child's rendering, so a rectangular ring lost its left
    // and right strokes in the two notches. Selection is drawn as the chevron ring, sharing one shape with focus.
    expect(ring).toContain('.track .seg.sel .pick,');
    expect(ring).toContain('.track .seg:first-child.sel .pick,');
    expect(ring).toContain('.track .seg:last-child.sel .pick,');
    // Focus outranks selection on a segment that is both, so it is stated LAST.
    expect(ring.lastIndexOf('.track .seg .pick:focus-visible{outline:0'), 'focus does not win the ring colour').toBeGreaterThan(ring.indexOf('.track .seg.sel .pick,'));
    expect(ring).toContain('.track .seg.sel{box-shadow:none}');
  });

  it('draws the ring flush to the segment, joined without crossing itself', () => {
    expect(ring, 'the chevron ring is not behind an @supports guard').toContain('clip-path');
    // FLUSH: an outer boundary inset by `--k-focus-offset` read as a hairline gap all the way round.
    expect(ring, 'the ring is inset off the segment edge').not.toContain('--k-focus-offset');
    for (const [, points] of ring.matchAll(/clip-path:polygon\(evenodd,([\s\S]*?)\)\}/g)) {
      const pts = points!.split(/,(?![^(]*\))/).map((p) => p.replace(/\s+/g, ' ').trim());
      expect(pts[0], `ring does not start on the segment corner: ${pts[0]}`).toBe('0 0');
      // ZERO-AREA SLIT: `polygon()` is ONE contour with no move-to, so the outer loop closes on its own first point and
      // the inner loop starts AND ends on one point; the two connectors coincide and cancel, and no edge is lost.
      const outerEnd = pts.indexOf('0 0', 1);
      expect(outerEnd, 'the outer loop is not closed before the hole').toBeGreaterThan(2);
      expect(pts[outerEnd + 1], 'the hole does not close on the point it opened on').toBe(pts[pts.length - 1]);
      for (const p of pts.slice(outerEnd + 1)) expect(p, `inner point is not inset from the edge: ${p}`).toMatch(/var\(--r[tlrq]\)/);
    }
  });

  it('outlines a focused segment in the segment’s own shape, with a working fallback', () => {
    expect(ring).toContain('clip-path:polygon(evenodd,');
    // The inner chevron is offset PERPENDICULARLY, derived from the edge length, never the same px in both axes.
    expect(ring).toContain('var(--trk-diag)');
    expect(RAIL).toMatch(/--trk-diag:hypot\(var\(--trk-notch\),var\(--trk-half\)\)/);
    expect(ring).toContain('.track .seg:first-child .pick:focus-visible');
    expect(ring).toContain('.track .seg:last-child .pick:focus-visible');
    // A browser that cannot compute the ring would drop the clip-path and keep the fill; outside the guard the plain
    // outline survives as the indicator.
    expect(RING.replace(ring, '') + RAIL).toMatch(/\.track \.seg \.pick:focus-visible\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/);
  });
});

describe('BlockedBanner.css — the banner moved with its markup', () => {
  it('is a flush danger-tinted strip (no left stripe, no solid fill) with a machine-truth monospace reason', () => {
    expect(BANNER).toMatch(/\.fault\{[^}]*border-top:var\(--k-border-w\) solid color-mix\(in srgb,var\(--k-failed\) 35%,transparent\)/);
    expect(BANNER).toMatch(/\.fault\{[^}]*background:color-mix\(in srgb,var\(--k-failed\) 7%,transparent\)/);
    expect(BANNER).not.toContain('border-left');
    expect(BANNER).not.toContain('inputValidation');
    expect(BANNER).toMatch(/\.fault \.freason\{[^}]*font-family:var\(--k-font-mono\)/);
    expect(BANNER).not.toMatch(/\.fault\.waiting/);
  });

  it('leaves the decision-state words with the artifact view, because it lists baselines too', () => {
    for (const rule of ['.blstate.approved', '.blstate.rejected', '.blstate.pending', '.blline{']) expect(ARTIFACT_VIEW).toContain(rule);
    const rules = BANNER.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toContain('.blstate');
    expect(rules).not.toContain('.blline');
  });
});

describe('webview.html — the page no longer carries the rail or banner rules', () => {
  it('keeps the shared spinner and the stepper frame, and nothing of the track', () => {
    expect(PAGE).toMatch(/\.spin\{display:block;/);
    expect(PAGE).toContain('@keyframes spin');
    expect(PAGE).toMatch(/\.stepper\{/);
    const rules = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/\.track\b/);
    expect(rules).not.toMatch(/\.fault\b/);
    expect(rules).not.toMatch(/\.blrow\b/);
  });
});
