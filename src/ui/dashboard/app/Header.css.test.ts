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

  it('never hides the ticket id or the ticket title at any container tier (RD-NEVER #4)', () => {
    const tiers = CSS.match(/@container ticket-head[^\n]*/g) ?? [];
    expect(tiers.length).toBeGreaterThan(0);
    for (const line of tiers) {
      expect(line).not.toMatch(/\.ticketKey[^}]*display:none/);
      expect(line).not.toMatch(/ticketTitle[^}]*display:none/);
    }
  });
});
