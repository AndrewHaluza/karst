import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/ui/settings/agents.webview.css', 'utf8');
const pickerCss = readFileSync('src/model/agentPicker.webview.css', 'utf8');

const COLS = 'var(--k-space-9) minmax(140px, 1fr) minmax(150px, 1fr) minmax(360px, 3fr) minmax(92px, 1fr) calc(2 * var(--k-hit-min) + var(--k-space-2))';
const PICKER_COLS = 'minmax(0,1.3fr) minmax(0,1.6fr) minmax(96px,0.8fr)';

describe('agents.webview.css — roles table', () => {
  it('uses one six-track template for header and rows', () => {
    const cols = /--agents-cols:\s*([^;]+);/.exec(css)![1]!.replace(/\s+/g, ' ').trim();
    expect(cols).toBe(COLS);
    expect(css.match(/grid-template-columns:\s*var\(--agents-cols\)/g)!.length).toBeGreaterThanOrEqual(1);
  });
  it('splits the picker into Core | Model | Effort on a shared sub-template', () => {
    expect(css).toMatch(/--agents-picker-cols:\s*minmax\(0, 1\.3fr\) minmax\(0, 1\.6fr\) minmax\(96px, 0\.8fr\)/);
    expect(css).toMatch(/\.agents-cell-picker-head[^{]*\{[^}]*grid-template-columns:\s*var\(--agents-picker-cols\)/);
    expect(pickerCss).toContain(`.ap-compact{grid-template-columns:${PICKER_COLS}`);
  });
  it('no longer turns the picker cell into the row grid (no display: contents)', () => {
    expect(css).not.toContain('display: contents');
    expect(css).not.toContain('subgrid');
  });
  it('never breaks words mid-word and keeps the 472ee4af overrides deleted', () => {
    expect(css).not.toContain('overflow-wrap: anywhere');
    expect(css).not.toContain('overflow-wrap:anywhere');
    expect(css).not.toMatch(/\.ap-trigger-label[^{]*\{[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/\.k-chip\s*\{[^}]*white-space:\s*normal/);
  });
  it('truncates model labels with an ellipsis on one line', () => {
    expect(css).toMatch(/\.agents-cell-picker \.ap-trigger-label[^{]*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.agents-cell-picker \.ap-trigger-label[^{]*\{[^}]*white-space:\s*nowrap/);
  });
  it('hides field labels on wide rows and shows them on cards', () => {
    expect(css).toMatch(/\.agents-field-label\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@container agents-roles \(max-width: 999px\)[\s\S]*?#section-agents \.agents-field-label\s*\{[^}]*display:\s*block/);
  });
  it('keeps the action slot the size of an icon button', () => {
    expect(css).toMatch(/\.agents-slot\s*\{[^}]*width:\s*var\(--k-hit-min\)/);
    expect(css).not.toContain('agents-pin-slot');
  });
  it('lays the mid tier out as a labelled card and stacks at the narrow tier', () => {
    expect(css).toMatch(/@container agents-roles \(max-width: 999px\)[\s\S]*grid-template-areas:\s*'sw role src act' 'f f f f'/);
    expect(css).toMatch(/@container agents-roles \(max-width: 699px\)[\s\S]*\.agents-cell-picker[\s\S]*grid-column:\s*1 \/ -1/);
  });
  it('sizes the compare Actions track to a content-independent slot that fits its text button', () => {
    const tmpl = /\.agents-compare-row,[\s\S]*?grid-template-columns:\s*([^;]+);/.exec(css);
    const tracks = tmpl![1]!.replace(/\s+/g, ' ').trim();
    // Content-dependent tracks would size the empty header cell differently from
    // the body cell and break header/row alignment (UI-R41).
    expect(tracks).not.toMatch(/(^|\s)(max-content|min-content|auto)(\s|$)/);
    expect(tracks).toContain('calc(5 * var(--k-hit-min))');
    expect(css).toMatch(/\.agents-compare-row \.agents-cell-actions \.k-btn\s*\{[^}]*white-space:\s*nowrap/);
  });
  it('never scrolls the page sideways', () => {
    expect(css).not.toMatch(/\.agents-table\s*\{[^}]*overflow-x:\s*(auto|scroll)/);
  });
});

describe('agents.webview.css — Accounts row menu anchoring', () => {
  it('anchors the menu to the trigger’s end at every tier', () => {
    const rule = /#section-agents \.accounts-menu-list\s*\{[^}]*\}/.exec(css);
    expect(rule, 'menu rule').not.toBeNull();
    expect(rule![0]).toMatch(/inset-inline-end:\s*0/);
    expect(rule![0]).not.toMatch(/inset-inline-start/);
  });

  it('keeps a viewport max-width guard so the menu opens inward from the right edge', () => {
    const rule = /#section-agents \.accounts-menu-list\s*\{[^}]*\}/.exec(css);
    expect(rule![0]).toMatch(/max-width:\s*calc\(100vw - var\(--k-space-8\)\)/);
  });

  it('never flips the menu to the inline start (the ⋯ slot stays on the right edge)', () => {
    expect(css).not.toMatch(/\.accounts-menu-list[^{]*\{[^}]*inset-inline-start/);
  });
});

describe('agents.webview.css — Accounts table', () => {
  it('shares one content-independent track template between header and rows', () => {
    const cols = /--accounts-cols:\s*([^;]+);/.exec(css)?.[1]?.replace(/\s+/g, ' ').trim();
    expect(cols).toBeDefined();
    expect(cols).not.toMatch(/(^|\s)(max-content|min-content|auto)(\s|$)/);
    expect(css).toMatch(/\.accounts-head,\s*#section-agents \.accounts-row\s*\{[^}]*grid-template-columns:\s*var\(--accounts-cols\)/);
  });

  it('keeps the compact inline text controls above the 20px text-control floor', () => {
    expect(css).toMatch(/#section-agents \.accounts-table \.k-btn--link\s*\{\s*min-height:\s*var\(--k-hit-min\)/);
  });

  it('wraps long paths without breaking words mid-word', () => {
    expect(css).toMatch(/\.accounts-loc-mono[^{]*\{[^}]*overflow-wrap:\s*break-word/);
    expect(css).not.toContain('overflow-wrap: anywhere');
  });

  it('lets one long unbroken account name wrap inside its flex cell (UI-R44)', () => {
    // A flex item's automatic minimum is its min-content width; for one unbroken
    // name that is the whole token, so the cell overflows unless it may shrink.
    const rule = /#section-agents \.accounts-name\s*\{[^}]*\}/.exec(css);
    expect(rule, 'account name rule').not.toBeNull();
    expect(rule![0]).toMatch(/min-width:\s*0/);
    expect(rule![0]).toMatch(/overflow-wrap:\s*break-word/);
  });

  it('lays each narrow card out as a name line, a sign-in + location line, then the token line', () => {
    // Named areas, not source order: the location cell comes before the status in the
    // DOM, so auto-placement alone would give the location a line of its own and push
    // the status, Use and ⋯ onto a third (T1360).
    const squashed = css.replace(/\s+/g, ' ');
    expect(squashed).toContain("grid-template-areas: 'mark name name use menu' '. stat loc loc loc' '. token token token token'");
    expect(squashed).toContain("grid-template-areas: 'agent agent agent agent agent' 'mark name name use menu' '. stat loc loc loc' '. token token token token'");
    // 320px: the sign-in state and the location each take a full line of their own.
    expect(squashed).toContain("grid-template-areas: 'mark name name use menu' '. stat stat stat stat' '. loc loc loc loc' '. token token token token'");
    expect(squashed).toContain("grid-template-areas: 'agent agent agent agent agent' 'mark name name use menu' '. stat stat stat stat' '. loc loc loc loc' '. token token token token'");
  });
});

describe('agents.webview.css — Accounts row surfaces (UI-R29)', () => {
  /** The declaration block that starts at `start` (which must be unique). */
  const block = (start: string): string => {
    const at = css.indexOf(start);
    expect(at, `missing rule: ${start}`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', at);
    return css.slice(open + 1, css.indexOf('}', open));
  };

  it('pairs every painted row surface with its foreground in the same rule', () => {
    expect(block('#section-agents .accounts-row:hover,')).toContain('color: var(--k-text)');
    expect(block('#section-agents .accounts-core-group.is-multi .accounts-row.is-active {'))
      .toContain('color: var(--vscode-list-inactiveSelectionForeground, var(--k-text))');
  });

  it('paints no second wash under the active row on hover (only the accent bar grows)', () => {
    const activeHover = block('#section-agents .accounts-core-group.is-multi .accounts-row.is-active:hover,');
    expect(activeHover).not.toContain('background:');
    expect(activeHover).toContain('box-shadow: inset 3px');
  });

  it('lets the dim ink and the inline text buttons inherit the row pair', () => {
    for (const painted of [
      '#section-agents .accounts-row:hover :is(',
      '#section-agents .accounts-row:focus-within :is(',
      '#section-agents .accounts-core-group.is-multi .accounts-row.is-active :is(',
    ]) {
      const at = css.indexOf(painted);
      expect(at, `missing rule: ${painted}`).toBeGreaterThanOrEqual(0);
      const open = css.indexOf('{', at);
      const selector = css.slice(at, open);
      expect(css.slice(open + 1, css.indexOf('}', open)), painted).toContain('color: inherit');
      for (const ink of ['.accounts-muted', '.accounts-loc-mono', '.accounts-project-choice', '.accounts-sep', '.k-btn--link']) {
        expect(selector, `${painted} ${ink}`).toContain(ink);
      }
    }
  });

  it('paints the warning text and its dot with the readable attention tone, never the chart hue', () => {
    expect(block('#section-agents .accounts-status-warn {')).toContain('var(--k-attention-fg)');
    expect(block('#section-agents .accounts-status-dot.is-not-signed-in {')).toContain('var(--k-attention-fg)');
  });

  it('keeps a text button identifiable when the row pair drops its link tone', () => {
    expect(block('#section-agents .accounts-row:hover .k-btn--link,')).toContain('text-decoration: underline');
  });
});
