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
    expect(css).toMatch(/@media \(max-width: 999px\)[\s\S]*?#section-agents \.agents-field-label\s*\{[^}]*display:\s*block/);
  });
  it('keeps the action slot the size of an icon button', () => {
    expect(css).toMatch(/\.agents-slot\s*\{[^}]*width:\s*var\(--k-hit-min\)/);
    expect(css).not.toContain('agents-pin-slot');
  });
  it('lays the mid tier out as a labelled card and stacks at the narrow tier', () => {
    expect(css).toMatch(/@media \(max-width: 999px\)[\s\S]*grid-template-areas:\s*'sw role src act' 'f f f f'/);
    expect(css).toMatch(/@media \(max-width: 699px\)[\s\S]*\.agents-cell-picker[\s\S]*grid-column:\s*1 \/ -1/);
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
