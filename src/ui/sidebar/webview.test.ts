import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, 'webview.html'), 'utf8');
const DS_CSS = readFileSync(join(HERE, '..', '..', 'model', 'designComponents.webview.css'), 'utf8');

function styleBlocks(): string[] {
  const blocks: string[] = [];
  const re = /<style>([\s\S]*?)<\/style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(HTML))) blocks.push(m[1]!);
  expect(blocks.length).toBeGreaterThanOrEqual(2);
  return blocks;
}

describe('sidebar webview.html', () => {
  it('fills a stage chip with its approved background pair, falling back to the wash (869ej2cfz)', () => {
    // The chip rule moved to the shared design-system sheet, which every webview injects.
    expect(DS_CSS).toMatch(
      /\.stage\[class\*="stg-"\]\{[\s\S]*?background:var\(--stg-bg,color-mix\(in srgb, currentColor 16%, transparent\)\)\}/,
    );
  });

  it('carries the injection markers and the single React mount point (UI-R03)', () => {
    expect(HTML).toContain('/*KARST_DS_CSS*/');
    expect(HTML).toContain('/*KARST_DS_JS*/');
    expect(HTML).toContain('/*KARST_AGENT_JS*/');
    expect(HTML).toContain('/*KARST_SIDEBAR_APP*/');
    expect(HTML).toContain('<!--KARST_CSP-->');
    expect(HTML.match(/id="root"/g)).toHaveLength(1);
  });

  it('keeps the mount point out of the layout: its children stay flex items of body', () => {
    expect(HTML).toMatch(/#root\{display:contents\}/);
  });

  it('contains no raw hex/rgb/px/rem style literal outside the injected tokens (UI-R04)', () => {
    const blocks = styleBlocks();
    for (const block of blocks) {
      const local = block.slice(block.indexOf('/*KARST_DS_CSS*/') + '/*KARST_DS_CSS*/'.length);
      const offenders = local.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b[0-9]+(\.[0-9]+)?(px|rem)\b/g);
      expect(offenders, JSON.stringify(offenders)).toBeNull();
    }
  });

  it('declares no local :root block — tokens come from the injected design system (UI-R04, R05)', () => {
    const blocks = styleBlocks();
    for (const block of blocks) {
      expect(block).not.toContain(':root');
    }
  });

  it('indents nested sub-task rows a fixed 12px per depth via token-spaced nest classes (UI-R04)', () => {
    // Depth comes from the host (`nestSubtasks`); the view only paints it, and
    // clamps to MAX_SUBTASK_INDENT (the writer's MAX_SUBTASK_DEPTH, via
    // ui/sidebar/items.ts). Each step is one --k-space-6 (12px) per level.
    expect(HTML).toMatch(/\.ticket\.nest1>\.row\{padding-left:calc\(var\(--k-space-6\) \* 1\)\}/);
    expect(HTML).toMatch(/\.ticket\.nest2>\.row\{padding-left:calc\(var\(--k-space-6\) \* 2\)\}/);
    expect(HTML).toMatch(/\.ticket\.nest3>\.row\{padding-left:calc\(var\(--k-space-6\) \* 3\)\}/);
    // The writer allows 4 levels below a root; the deepest one still indents.
    expect(HTML).toContain('.ticket.nest4>.row{padding-left:calc(var(--k-space-6) * 4)}');
    // Exactly MAX_SUBTASK_INDENT (4) nest rules — a nest5 would be unreachable
    // and would mean the view and the writer's depth cap had drifted.
    expect(HTML).not.toContain('.ticket.nest5');
  });

  it('centres the ticket chevron on the Planning twistie (SIDEBAR-ALIGN-TICKET-ROW-CHEVRON)', () => {
    // The ticket row drops its left padding and pulls the chevron left by
    // --k-space-1 - (--k-hit-min - --k-space-7) / 2, so the chevron centre is
    // 4 (ticket margin) + 0 + -2 + 12 = 14px — the Planning twistie's centre
    // (4 + 2 + 16/2). Token arithmetic only; the chevron's hit box stays at the
    // .k-iconbtn default --k-hit-min (UI-R29).
    expect(HTML).toMatch(
      /\.row\{[^}]*padding:var\(--k-space-2\) var\(--k-space-3\) var\(--k-space-2\) 0;[^}]*overflow:hidden\}/,
    );
    expect(HTML).toMatch(
      /\.chev\{[^}]*margin-left:calc\(var\(--k-space-1\) - \(var\(--k-hit-min\) - var\(--k-space-7\)\) \/ 2\)/,
    );
    // The chevron keeps its hit box: no local width/min-width override.
    expect(HTML).not.toMatch(/\.chev\{[^}]*min-width/);
  });

  it('paints one aria-hidden hairline guide per ancestor slot with an elbow/tee (UI-R28)', () => {
    // The decorative tree guides are host-arithmetic (`subtaskGuides` /
    // `subtaskIsLast`) painted CSS-only; the markup (aria-hidden spans, one per
    // slot) is pinned in the rendered tests, the hairline paint here.
    expect(HTML).toContain('.guide--elbow');
    expect(HTML).toContain('.guide--line');
    expect(HTML).toContain('border-left:var(--k-border-w) solid var(--k-border)');
  });

  it('keeps the sub-tree collapse control clear of the hover action strip (NDL-86)', () => {
    // The hover strip is absolutely positioned at the row's right edge and the
    // collapse chevron sits in flow in the same slot, so on hover the strip's
    // solid surface + hit area covered the chevron and a pointer could not
    // click it (verified in a real browser: elementFromPoint at the chevron
    // returned the `data-menu` action). The strip reserves one control-width
    // whenever a collapse control is present, so the two never overlap.
    expect(HTML).toMatch(
      /\.row:has\(\.subchev\) \.rowacts\{right:calc\(var\(--k-space-3\) \+ var\(--k-hit-min\)\)\}/,
    );
  });

  it('paints a super-thin inset edge line on the side facing the editor (SIDEBAR-SUPER-THIN-EDGE-LINE-SO)', () => {
    // Inset box-shadow (not a border): zero layout width, no pointer capture.
    // Both sides, token-only (UI-R04), full height because body fills the view.
    expect(HTML).toMatch(
      /html\[data-edge="right"\] body\{box-shadow:inset calc\(-1 \* var\(--k-border-w\)\) 0 0 0 var\(--k-border\)\}/,
    );
    expect(HTML).toMatch(
      /html\[data-edge="left"\] body\{box-shadow:inset var\(--k-border-w\) 0 0 0 var\(--k-border\)\}/,
    );
  });

});

describe('content width cap (UI-R48)', () => {
  it('stays uncapped', () => {
    expect(HTML).not.toContain('--k-content-max');
  });
});
