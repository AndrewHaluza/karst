import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/ui/settings/agents.webview.css', 'utf8');

describe('agents.webview.css — roles table', () => {
  it('uses one 8-track template for header and rows', () => {
    expect(css).toContain('--agents-cols:');
    expect(css.match(/grid-template-columns:\s*var\(--agents-cols\)/g)!.length).toBeGreaterThanOrEqual(1);
  });
  it('lets the picker fields be the row\'s own grid items (1:1 with the headings)', () => {
    expect(css).toMatch(/\.agents-cell-picker,[^{]*\.ap-compact\s*\{\s*display:\s*contents/);
    expect(css).not.toContain('subgrid');
  });
  it('dims inherited picker fields (opacity has no effect on display: contents)', () => {
    expect(css).toMatch(/\.is-inherited \.agents-cell-picker \.ap-field\s*\{[^}]*opacity/);
  });
  it('wraps the core name between words on cards instead of clipping it', () => {
    expect(css).toMatch(/@media \(max-width: 999px\)[\s\S]*\[data-ap-trigger="core"\] \.agent-identity\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/@media \(max-width: 999px\)[\s\S]*\[data-ap-trigger="core"\] \.ap-trigger-label[^{]*\{[^}]*white-space:\s*normal/);
  });
  it('never breaks words mid-word and drops the 472ee4af wrap overrides', () => {
    expect(css).not.toContain('overflow-wrap: anywhere');
    expect(css).not.toContain('overflow-wrap:anywhere');
    // 472ee4af wrapped every trigger label; only the card-tier core name may wrap (between words).
    expect(css).not.toMatch(/#section-agents \.ap-trigger-label[^{]*\{[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/\[data-ap-trigger="model"\][^{]*\{[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/\.k-chip\s*\{[^}]*white-space:\s*normal/);
  });
  it('truncates model labels with an ellipsis on one line', () => {
    expect(css).toMatch(/\.ap-trigger-label[^{]*\{[^}]*text-overflow:\s*ellipsis/);
  });
  it('hides field labels on wide rows and shows them on cards', () => {
    expect(css).toMatch(/\.agents-field-label\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 999px\)[\s\S]*\.agents-field-label[^}]*display:\s*block/);
  });
  it('keeps the pin slot the size of an icon button', () => {
    expect(css).toMatch(/\.agents-pin-slot\s*\{[^}]*width:\s*var\(--k-hit-min\)/);
  });
  it('never scrolls the page sideways', () => {
    expect(css).not.toMatch(/\.agents-table\s*\{[^}]*overflow-x:\s*(auto|scroll)/);
  });
});
