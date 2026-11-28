/** Source-text guards for the header rules that moved out of webview.html with the markup: they catch DELETION, not visual regression. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'Header.css'), 'utf8');
const PAGE = readFileSync(join(HERE, '..', 'webview.html'), 'utf8');

describe('Header.css — guards moved with the rules', () => {
  it('shows a popover only through `.open` (removing `hidden` alone leaves it invisible)', () => {
    expect(CSS).toMatch(/\.popover\{display:none;/);
    expect(CSS).toContain('.popover.open{display:block}');
  });

  it('sizes every header icon with one token rule (PR #166 balloon)', () => {
    expect(CSS).toMatch(/\.dhead \.k-icon\{[^}]*var\(--k-space-7\)/);
  });

  it('keeps the `hidden` attribute effective on the second header row and the wait chips', () => {
    expect(CSS).toContain('.headerMeta[hidden]{display:none}');
    expect(CSS).toContain('.shipWait.hidden{display:none}');
  });

  it('shows the toast only through `.show`, and spaces the Resume button inside the paused chip', () => {
    expect(CSS).toContain('.toast.show{opacity:1}');
    expect(CSS).toContain('.shipWait > .k-btn{margin-left:var(--k-space-2)}');
  });

  it('left no header rule behind in the page, except the .menuButton the Inside stage menu shares', () => {
    for (const rule of ['.dhead{', '.popover{', '.agentButton{', '.capChip{', '.gateRow{', '.shipWait{', '.toast{']) {
      expect(PAGE, rule).not.toContain(rule);
    }
    expect(PAGE).toContain('.menuButton{width:100%');
  });

  it('keeps the ticket popover at 12 control heights and the gate tabs token-sized (T1397)', () => {
    expect(CSS).toContain('.menuPopover{width:calc(var(--k-control-h-lg) * 12)');
    expect(CSS).toMatch(/\.gateTabs\{[^}]*background:var\(--k-surface-sunken\)/);
    expect(CSS).toContain('.gateTabOff{color:var(--k-warning)}');
    expect(CSS).toContain('.gateGroup > .gateRow:first-child{border-top:0}');
    expect(CSS).toMatch(/\.gateTab\[aria-selected="true"\]\{[^}]*var\(--k-surface-hover\)/);
  });

  it('never hides the ticket id or the ticket title at any container tier (RD-NEVER #4)', () => {
    const tiers = CSS.match(/@container ticket-head[^\n]*/g) ?? [];
    expect(tiers.length).toBeGreaterThan(0);
    for (const line of tiers) {
      expect(line).not.toMatch(/\.ticketKey[^}]*display:none/);
      expect(line).not.toMatch(/ticketTitle[^}]*display:none/);
    }
  });

  it('sticks row 1 flush to the page gutters, below the attention ring, and leaves row 2 scrolling', () => {
    const rule = CSS.match(/\.dhead\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('position:sticky');
    expect(rule).toContain('top:0');
    expect(rule).toContain('z-index:var(--k-z-sticky)');
    expect(rule).toContain('background:var(--k-bg)');
    expect(rule).toContain('margin-inline:calc(var(--k-space-9) * -1)');
    expect(rule).toContain('padding-inline:var(--k-space-9)');
    expect(CSS).not.toMatch(/\.headerMeta\{[^}]*sticky/);
  });

  it('draws the stuck shadow without a transition, from a zero-height sentinel', () => {
    const stuck = CSS.match(/\.dhead\[data-stuck="true"\]\{([^}]*)\}/)?.[1] ?? '';
    expect(stuck).toContain('box-shadow:var(--k-elev-1)');
    expect(stuck).not.toContain('transition');
    const sentinel = CSS.match(/\.dheadSentinel\{([^}]*)\}/)?.[1] ?? '';
    expect(sentinel).toContain('height:var(--k-border-w)');
    expect(sentinel).toContain('margin-top:calc(var(--k-border-w) * -1)');
    expect(sentinel).toContain('opacity:0');
    expect(sentinel).toContain('pointer-events:none');
  });

  it('pads a scrolled-to target by the measured header height', () => {
    expect(CSS).toContain('html{scroll-padding-top:var(--k-headbar-h,0px)}');
  });

  it('keeps the key on one line with an ellipsis at every tier', () => {
    const rule = CSS.match(/\.ticketKey\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('white-space:nowrap');
    expect(rule).toContain('overflow:hidden');
    expect(rule).toContain('text-overflow:ellipsis');
    expect(rule).toContain('max-width:calc(var(--k-space-8) * 7)');
    expect(CSS).toContain('@container ticket-head (max-width: 999px){ .ticketKey{max-width:calc(var(--k-space-8) * 5)');
    expect(CSS).toContain('@container ticket-head (max-width: 399px){ .ticketKey{max-width:calc(var(--k-space-8) * 3)');
  });

  it('drops the old text priority pill and never hides the shared chip at a tier', () => {
    expect(CSS).not.toMatch(/\.prio\b/);
    for (const line of CSS.match(/@container ticket-head[^\n]*/g) ?? []) {
      expect(line).not.toMatch(/\.k-pri[^}]*display:none/);
    }
  });

  it('moves the tight tier icons into the ⋯ menu: hidden inline, revealed as tightOnly items', () => {
    expect(CSS).toContain('.menuButton.tightOnly{display:none}');
    const tight = CSS.match(/@container ticket-head \(max-width: 399px\)\{[^\n]*\}/)?.[0] ?? '';
    expect(tight).toContain('#providerMark,#boardLink,#ticketDataBtn{display:none}');
    expect(tight).toContain('.menuButton.tightOnly{display:flex}');
    expect(tight).toContain('.menuButton.tightOnly.hidden{display:none}');
    expect(tight.indexOf('.menuButton.tightOnly.hidden{display:none}')).toBeGreaterThan(tight.indexOf('.menuButton.tightOnly{display:flex}'));
  });

  it('raises the sticky row above the page popover layer only while the menu is open', () => {
    // The row is a stacking context; its fixed popover cannot outrank the page's .vp-menu/.wbase-popover unless the
    // row rises. The rule must be scoped to the open menu, so the row at rest stays below the attention ring.
    expect(CSS).toContain('.dhead:has(.menuPopover.open){z-index:var(--k-z-sticky-open)}');
  });

  it('styles the planning link and its card, raises the row for an open card, and hides the link at the tight tier (T1400)', () => {
    expect(CSS).toContain('.dhead:has(.hoverCard.open){z-index:var(--k-z-sticky-open)}');
    expect(CSS).toMatch(/\.planLink\{[^}]*min-height:var\(--k-hit-min\)/);
    expect(CSS).toMatch(/\.planLink\{[^}]*text-decoration:underline dotted/);
    expect(CSS).toMatch(/\.hoverCard\{[^}]*white-space:normal/);
    expect(CSS).toMatch(/\.planCardTable td\{[^}]*overflow-wrap:anywhere/);
    const tight = CSS.match(/@container ticket-head \(max-width: 399px\)\{[^\n]*\}/)?.[0] ?? '';
    expect(tight).toContain('.planLink{display:none}');
  });
});
