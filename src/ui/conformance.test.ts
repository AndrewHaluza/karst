import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The rule Checks from `docs/ui/UI-RULES.md`, run across EVERY webview.
 *
 * The per-screen `webview.test.ts` files each guard their own remediation. This
 * one guards the contract itself: it is what makes a rule enforceable rather
 * than aspirational, and — because it DISCOVERS the webview directories instead
 * of listing them — it binds to a webview added next year as much as to the
 * seven that exist today. That discovery is the whole point: `injectDesignSystem`
 * no-ops on a marker-less document, so a new screen could otherwise ship outside
 * the design system in complete silence.
 *
 * What this cannot see: layout, cascade, real focus order, contrast as rendered.
 * Those need F5. A green run here means the STATIC contract holds.
 */
const WEBVIEWS = readdirSync(HERE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(HERE, name, 'webview.html'));
      return true;
    } catch {
      return false;
    }
  });

const read = (name: string): string => readFileSync(join(HERE, name, 'webview.html'), 'utf8');

/** Style blocks with comments stripped — a literal quoted in prose is not a literal in a rule. */
const styleSource = (html: string): string =>
  [...html.matchAll(/<style>(.*?)<\/style>/gs)]
    .map((m) => m[1]!)
    .join('\n')
    .replace(/\/\*.*?\*\//gs, '');

/**
 * Raw style literals still present per screen (UI-R04).
 *
 * A RATCHET, not an allowlist of blessed values: each number is what survived
 * remediation with a written justification in the file, and the assertion is
 * that it never grows. Every survivor is one of two kinds — a `@media`/`@container`
 * breakpoint (a CSS media condition cannot read a custom property, so there is
 * no token form) or a one-off component dimension with no step on the closed
 * spacing scale. Driving these to zero means adding tokens; that is a deliberate
 * decision, not something a future edit should be able to make by accident in
 * either direction.
 */
const LITERAL_BUDGET: Record<string, number> = {
  // 13, not 10: the development-only Inside preview width frame (Finding 1)
  // adds three justified component dimensions (300/360/430px, the same
  // exemption class as the breakpoints) — commented in webview.html and
  // pinned by the dashboard's own px allowlist test.
  dashboard: 20,
  diffs: 1,
  ticketForm: 0,
  settings: 0,
  sidebar: 0,
  usage: 0,
  gettingStarted: 0,
};

describe('UI conformance — discovery', () => {
  it('covers every webview that exists today', () => {
    expect([...WEBVIEWS].sort()).toEqual([
      'dashboard',
      'diffs',
      'gettingStarted',
      'settings',
      'sidebar',
      'ticketForm',
      'usage',
    ]);
  });

  it('has a literal budget for every discovered webview', () => {
    // A new screen with no entry would otherwise skip the UI-R04 check entirely.
    for (const name of WEBVIEWS) {
      expect(LITERAL_BUDGET[name], `${name} has no literal budget`).toBeDefined();
    }
  });
});

describe.each(WEBVIEWS)('UI conformance — %s', (name) => {
  const html = read(name);
  const styles = styleSource(html);

  /**
   * The dashboard's Inside block is the A37 prototype, ported verbatim and
   * scoped under `#inside` (see its own header comment in webview.html). Its
   * pixel geometry IS the approved design, so counting those literals against
   * the budget would only measure how faithful the port is. Its COLOURS are
   * not exempt — they go through `--k-*` tokens like everything else, which
   * the no-colour rule below still checks over the whole sheet.
   */
  const budgeted = ((): string => {
    // The markers are comments, so the cut has to happen on the RAW style
    // source — `styleSource` has already stripped them out of `styles`.
    const raw = [...html.matchAll(/<style>(.*?)<\/style>/gs)].map((m) => m[1]!).join('\n');
    const from = raw.indexOf('/*KARST_INSIDE_PROTO_START*/');
    const to = raw.indexOf('/*KARST_INSIDE_PROTO_END*/');
    const kept = from === -1 || to === -1 ? raw : raw.slice(0, from) + raw.slice(to);
    return kept.replace(/\/\*.*?\*\//gs, '');
  })();

  it('keeps raw style literals within its budget (UI-R04)', () => {
    const found = [
      // `em` is deliberately absent: `letter-spacing:.04em` is relative
      // typography that scales with the theme's font size, not a fixed literal
      // the design system needs to own.
      ...budgeted.matchAll(/#[0-9a-fA-F]{3,8}\b|(?<![\w.])\d+(?:\.\d+)?(?:px|rem)\b|\brgba?\(/g),
    ].map((m) => m[0]);
    expect(found.length, `literals: ${[...new Set(found)].join(', ')}`).toBeLessThanOrEqual(
      LITERAL_BUDGET[name]!,
    );
  });

  it('declares no colour of its own — one meaning, one token (UI-R05)', () => {
    // The defect this replaces: six greens, five reds, and the SAME VS Code
    // variable written with two different fallback hexes in two files.
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('never disables a control with pointer-events (UI-R17)', () => {
    // `pointer-events:none` on a DISABLED control suppresses the tooltip that
    // explains why it is disabled. On a hidden decoration (a closed scrim, an
    // un-hovered action bar) it is correct and stays legal — so this checks the
    // selector, not the property.
    for (const m of styles.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
      if (!/pointer-events:\s*none/.test(m[2]!)) continue;
      expect(m[1]!, `disabling selector uses pointer-events:none: ${m[1]!.trim()}`).not.toMatch(
        /:disabled|\[disabled\]|\[aria-disabled/,
      );
    }
  });

  it('never strips an outline without replacing the ring (UI-R23)', () => {
    // The replacement need not be an `outline`. An `outline` is a RECTANGLE, and
    // a clipped element (the dashboard track's chevron segments) cuts whatever
    // falls outside its shape — there, the ring's vertical strokes vanished into
    // the notches. Such an element draws the ring as a shape instead. What is
    // non-negotiable is that `--k-focus` is what draws it, in the same block that
    // dropped the outline, so a strip can never leave nothing behind.
    for (const m of styles.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
      const body = m[2]!;
      if (!/outline:\s*(?:none|0)\b/.test(body)) continue;
      expect(body, `outline removed with no replacement: ${m[1]!.trim()}`).toMatch(
        /(?:outline(?:-\w+)?|box-shadow|border(?:-\w+)?|background(?:-color)?):\s*[^;]*var\(--k-focus/,
      );
    }
  });

  it('keeps every tooltip bounded and behavioural (UI-R20)', () => {
    for (const [, title] of html.matchAll(/\stitle="([^"]*)"/g)) {
      // Interpolations render shorter than the template that contains them, so
      // the raw source is the strict bound — if the template fits, the value does.
      expect(title!.length, `over 80 chars: ${title}`).toBeLessThanOrEqual(80);
      expect(title!, `trailing period: ${title}`).not.toMatch(/[^.]\.$/);
    }
  });

  it('gives every icon-only control an accessible name (UI-R24)', () => {
    // A <button> whose only content is an SVG or a bare glyph has no text to be
    // named by, and `title` is not an accessible name.
    const iconOnly = [...html.matchAll(/<button\b([^>]*)>((?:(?!<\/button>).)*?)<\/button>/gs)]
      .filter(([, , inner]) => {
        // A `${...}` interpolation IS text content — the label is simply
        // computed. Stripping it would misread every dynamically-labelled
        // button as icon-only.
        const text = inner!
          .replace(/<svg\b.*?<\/svg>/gs, '')
          .replace(/<[^>]+>/g, '')
          .replace(/&[a-z]+;|&#\d+;/gi, '')
          .trim();
        return text.length === 0;
      })
      .map(([, attrs]) => attrs!);
    for (const attrs of iconOnly) {
      expect(attrs, `icon-only button without aria-label: ${attrs.slice(0, 90)}`).toMatch(
        /aria-label=/,
      );
    }
  });

  it('carries the design system and its CSP marker (UI-R02, R03)', () => {
    expect(html).toContain('/*KARST_DS_CSS*/');
    expect(html).toContain('/*KARST_DS_JS*/');
    expect(html).toContain('<!--KARST_CSP-->');
  });

  it('loads nothing from outside itself — CSP forbids it (UI-R02)', () => {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(styles).not.toMatch(/@import\b/);
    expect(styles).not.toMatch(/url\(\s*['"]?https?:/i);
  });
});
