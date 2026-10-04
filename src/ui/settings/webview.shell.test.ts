/**
 * Static remainder of the retired VM harness for the settings webview
 * (NDL-126 §4).
 *
 * Phase 4 of the React migration deleted `webview.test.ts`, whose assertions
 * read the settings `webview.html` string and/or ran `runInNewContext`
 * sandboxes over the page's inline script. The VM harness (`runInNewContext` /
 * `functionSource` / `loadFunction`) is gone BY DESIGN: the inline script no
 * longer exists — the settings surface is the React app in
 * `src/ui/settings/app/**`, bundled to `app.webview.js` and injected at the
 * `KARST_SETTINGS_APP` marker. The shell's `<script>` carries only shared
 * runtime markers.
 *
 * This file ports ONLY the string/CSS pins whose subject still lives in the
 * current `webview.html` (styles + shell structure), under their original
 * describe/it names so the old file maps onto this one traceably. Assertions
 * whose subjects moved into the React app (renderers, event handlers, body
 * markup like `id="helperPop"`, `id="ctxMenu"`, `data-more=`, nav buttons,
 * `section-*` divs, `#nameOverrideDrawer`, per-tab markup) live in the
 * component tests instead. The UI-R04 style-literal budget is superseded by
 * `src/ui/conformance.test.ts`, which already budgets the settings style block.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, 'webview.html'), 'utf8');

/** Every non-test TS/TSX source file under the React app (the bundle target excluded). */
function appSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.includes('.test.')) continue;
      if (entry.name === 'app.webview.js') continue;
      files.push(path);
    }
  };
  walk(join(HERE, 'app'));
  return files;
}

describe('settings model picker', () => {
  // Re-pointed at the React app source: the old pin read the inline script's
  // `const KNOWN_MODELS`, and the mirror must not reappear in the app either —
  // the catalog always arrives from the host.
  it('has no hard-coded model mirror', () => {
    const files = appSourceFiles();
    expect(files.length, 'app source walk found no files').toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('KNOWN_MODELS');
    }
  });
});

describe('chevron and invalid-field styling', () => {
  it('renders the chevron at a comfortably clickable size', () => {
    // The disclosure is now a real <button class="card-toggle"> rather than the
    // whole `.card-head` row, and its size comes from the type scale rather
    // than a literal — the design system owns the value (UI-R04, UI-R09).
    const m = HTML.match(/\.card \.card-toggle \.chevron\{([^}]*)\}/);
    expect(m, '.card .card-toggle .chevron rule not found').toBeTruthy();
    expect(m![1]).toMatch(/font-size:var\(--k-text-(lg|xl|2xl)\)/); // >= 14px, up from 10px
  });

  it('applies the error border to any invalid field, not just convention fields', () => {
    expect(HTML).toMatch(/input\[aria-invalid="true"\][^{]*\{[^}]*border-color/);
  });
});

describe('ticketing provider dropdown', () => {
  // The sibling it ('is not clipped: the provider select has no .card
  // ancestor') pinned body markup (`#provSelectWrap` / `section-ticketing`)
  // that no longer exists in the shell — the section renders in the React app.
  it('paints the menu above the content that follows it', () => {
    const m = HTML.match(/\.provselect-menu\{([^}]*)\}/);
    expect(m, '.provselect-menu rule not found').toBeTruthy();
    expect(m![1]).toMatch(/z-index:(?:\d+|var\(--k-z-[\w-]+\))/);
  });
});

describe('settings width and spacing consistency', () => {
  // The settings shell is the only child of a flex body. Without flex-grow it
  // sized to its own content, so the page stopped ~250px short of the
  // webview's right edge — a dead band whose width changed per tab, which is
  // what read as "some elements not using full width" on every settings page.
  it('makes the settings shell grow to fill the webview', () => {
    const m = HTML.match(/\.app\{([^}]*)\}/);
    expect(m, '.app rule not found').toBeTruthy();
    expect(m![1]).toMatch(/flex:1 1 auto/);
  });

  it('separates the ClickUp fields group from the Provider row', () => {
    // The provider row and #clickupFields are two stacked form-grids, and a
    // stacked pair of grids has zero inter-grid gap — the Team ID label used
    // to sit directly against the provider trigger. A group boundary must
    // read at the section-block rhythm, not the intra-grid row gap.
    const m = HTML.match(/#clickupFields\{([^}]*)\}/);
    expect(m, '#clickupFields rule not found').toBeTruthy();
    expect(m![1]).toMatch(/margin-top:var\(--k-space-7\)/);
  });

  it('keeps quality q-rows inside their 3-column panels', () => {
    // The q-row columns used to carry 160/180px minimums — together wider
    // than a panel at 980–1300px viewports, so the findings Select overflowed
    // the panel and past the page edge. The minimums must fit the narrowest
    // 3-column panel; the columns still share the panel as fr tracks.
    const m = HTML.match(/\.q-row\{([^}]*)\}/);
    expect(m, '.q-row rule not found').toBeTruthy();
    expect(m![1]).toContain('minmax(calc(var(--k-space-8) * 5),1fr)');
  });
});

describe('settings quality tab (UAT + review scalars)', () => {
  // The rest of this describe pinned body markup (nav entry, field ids,
  // section titles) or ran renderQuality in a VM sandbox — all retired with
  // the inline script; the React sections own them now.
  it('number inputs fill their control column like text inputs and selects', () => {
    // The Max fix attempts / Max findings fields rendered at the browser
    // default width beside full-width selects — a mixed column. The shared
    // rule now covers number inputs too.
    expect(HTML).toMatch(/input\[type=text\],input\[type=number\],select\{width:100%\}/);
  });
});

describe('settings v7 shared primitives', () => {
  it('styles select triggers, dropdowns and identity options with the shared geometry', () => {
    expect(HTML).toContain('.select-trigger');
    expect(HTML).toContain('.select-shell');
    expect(HTML).toContain('.dropdown');
    expect(HTML).toContain('.chev');
  });

  it('pairs the selection foreground on every active dropdown option (light-theme contrast)', () => {
    // The active wash is a saturated blue on light themes; inherited `--k-text`
    // is grey and fails contrast on it (UI-R29). Each option family must take
    // the theme's own paired foreground, and dim/faint descendants must not
    // re-grey themselves on the fill.
    expect(HTML).toContain('.provselect-opt.selected{background:var(--vscode-list-activeSelectionBackground,var(--k-surface-hover));');
    expect(HTML).toMatch(/\.provselect-opt\.selected\{[^}]*color:var\(--vscode-list-activeSelectionForeground,var\(--k-text\)\)/);
    expect(HTML).toMatch(/\.agentselect-opt\.selected\{[^}]*color:var\(--vscode-list-activeSelectionForeground,var\(--k-text\)\)/);
    expect(HTML).toMatch(/\.model-item\.active[^}]*color:var\(--vscode-list-activeSelectionForeground,var\(--k-text\)\)/);
    expect(HTML).toContain('.model-item.active .model-sub,.model-item.active .model-tag{color:inherit;opacity:.8}');
  });

  it('keeps dropdown items readable on hover with an explicit foreground', () => {
    expect(HTML).toContain('.provselect-opt:hover{background:var(--k-surface-hover);color:var(--k-text)}');
    expect(HTML).toContain('.agentselect-opt:hover{background:var(--k-surface-hover);color:var(--k-text)}');
    expect(HTML).toContain('.model-item:hover .model-sub,.model-item:hover .model-tag{color:var(--k-text);opacity:.8}');
  });

  it('overlay pops use their own display:none — never the !important .hidden class', () => {
    // `.hidden{display:none !important}` defeats `.open{display:block}`: the
    // template helper pop, context menu and project-info pop all carried the
    // class and could never become visible. The markup half of the pin (each
    // pop's own div, open, never hidden) lives in the React component tests;
    // the shell keeps the CSS half — self-contained display:none, flipped by a
    // non-!important .open rule.
    expect(HTML).toMatch(/\.project-info-pop\{[^}]*display:none/);
    expect(HTML).toContain('.project-info-pop.open{display:block}');
  });

  it('renders the repositories list as ONE rounded roster: head and cards share the container', () => {
    // The head used to float bare above the cards — a square block against
    // their rounded corners. The roster markup now renders in the React app;
    // the shell keeps the CSS that neutralizes the per-card chrome inside the
    // one rounded container.
    expect(HTML).toContain('.roster .card{border:none;border-radius:0;margin-bottom:var(--k-space-0);background:transparent}');
    expect(HTML).toContain('.roster .card + .card{border-top:var(--k-border-w) solid var(--vscode-panel-border)}');
  });

  it('implements the fixed-size reload icon button with a pending spin', () => {
    // The button markup renders in the React app; the shell keeps the spin
    // keyframes and the reduced-motion opt-out that were pinned here.
    expect(HTML).toContain('reload-spin');
    expect(HTML).toMatch(/prefers-reduced-motion[\s\S]*?reload-icon[\s\S]*?animation:none/);
  });

  // Skipped siblings in this describe: 'provides the context menu host and
  // more-button trigger', 'moves destructive actions into the overflow menu…',
  // 'renders the template helper popup', and both UNIFIED-picker its — their
  // subjects (id="ctxMenu", data-more=, id="helperPop", id="defaultAgentPicker",
  // data-gf-profile-picker) are body markup the React app renders.
});

describe('settings v7 responsive block', () => {
  it('ships the responsive rules in a separate style block with em breakpoints', () => {
    // The first <style> must stay literal-free (UI-R04); the responsive block
    // sits before the palette block and uses em units, which the conformance
    // literal budget explicitly exempts.
    const firstStyleEnd = HTML.indexOf('</style>');
    const responsiveAt = HTML.indexOf('@media (max-width: 61.25em)');
    expect(responsiveAt).toBeGreaterThan(firstStyleEnd);
    for (const bp of ['61.25em', '40em', '26.875em', '22.5em', '18.75em']) {
      expect(HTML, bp).toContain('@media (max-width: ' + bp + ')');
    }
    expect(HTML).toContain('/*KARST_PALETTE*/');
  });
});