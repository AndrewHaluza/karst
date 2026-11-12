import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * T1091 audit: every trigger-anchored surface in the webviews is `position:fixed` and placed by the shared primitive
 * (`anchoredPopover.ts`), so it flips, clamps and follows its trigger. A surface that falls back to `position:absolute`
 * has no such behavior. Each row names the file and the selector that owns the surface's placement.
 */
const SURFACES: ReadonlyArray<readonly [file: string, selector: string]> = [
  ['src/ui/dashboard/app/Header.css', '.popover'],
  ['src/ui/dashboard/app/ViewPills.css', '.vp-menu'],
  ['src/ui/dashboard/app/Autofix.css', '#inside .autofix-menu'],
  ['src/ui/dashboard/app/Inside.css', '#inside .stageMenu'],
  ['src/ui/dashboard/app/RuntimeStrip.css', '.rs-pop'],
  ['src/ui/dashboard/app/PrsPanel.css', '.pinfo-pop'],
  ['src/ui/dashboard/app/WorktreesPanel.css', '.wbase-popover'],
  ['src/ui/sidebar/webview.html', '.filter-pop'],
  ['src/ui/settings/webview.html', '.provselect-menu'],
  ['src/ui/ticketForm/webview.html', '.repo-pop'],
  ['src/ui/ticketForm/webview.html', '.searchmenu'],
  ['src/ui/ticketForm/webview.html', '.approach-pop'],
  ['src/model/agentPicker.webview.css', '.ap-menu'],
];

function declarations(file: string, selector: string): string {
  const css = readFileSync(file, 'utf8');
  const at = css.indexOf(`${selector}{`) >= 0 ? css.indexOf(`${selector}{`) : css.indexOf(`${selector} {`);
  expect(at, `${file} has no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('anchored surfaces use the shared placement', () => {
  it.each(SURFACES)('%s %s is position:fixed', (file, selector) => {
    expect(declarations(file, selector).replace(/\s+/g, '')).toContain('position:fixed');
  });

  it.each(SURFACES)('%s %s does not pin itself to its trigger edge', (file, selector) => {
    const rule = declarations(file, selector).replace(/\s+/g, '');
    expect(rule).not.toMatch(/(^|[;{])(top|left|right):calc\(100%/);
  });
});
