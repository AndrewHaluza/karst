import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAX_SUBTASK_DEPTH } from '../../workflow/stages/subtask.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

function styleBlocks(): string[] {
  const blocks: string[] = [];
  const re = /<style>([\s\S]*?)<\/style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(HTML))) blocks.push(m[1]!);
  expect(blocks.length).toBeGreaterThanOrEqual(2);
  return blocks;
}

describe('sidebar webview.html', () => {
  it('renders the stage chip on every collapsed row, colored by the shared stage token', () => {
    expect(HTML).toContain('class="stage ${esc(stageClass)}"');
    expect(HTML).toContain('${esc(stageChip)}');
  });

  it('fills a stage chip with its approved background pair, falling back to the wash (869ej2cfz)', () => {
    expect(HTML).toMatch(
      /\.stage\{[\s\S]*?background:var\(--stg-bg,color-mix\(in srgb, currentColor 16%, transparent\)\)\}/,
    );
  });

  it('states the stage (not status) in the chip, with the full phrase in the tooltip', () => {
    expect(HTML).toContain('title="${esc(stageText)}">${esc(stageChip)}');
    expect(HTML).toContain('const stageChip = row.stageChip || stageText;');
  });

  it('does NOT repeat the stage as a rail — the collapsed row chip already states it', () => {
    expect(HTML).not.toContain('class="rail"');
    expect(HTML).not.toContain('railHtml');
  });

  it('renders a blocker line ONLY on failure (reason + attempt), never the plain status', () => {
    expect(HTML).toContain('const b = row.blocker; if (!b) return');
    expect(HTML).toContain('b.reason');
    expect(HTML).toContain('b.attempt');
    expect(HTML).not.toContain('row.nextAction');
  });

  it('renders the stage-aware mini-dashboard summary (peek title + detail + next CTA)', () => {
    expect(HTML).toContain('class="peek-title">${esc(peek.title)}');
    expect(HTML).toContain('class="peek-detail">${esc(peek.detail)}');
    expect(HTML).toContain('nextCtaHtml(peek.next, row)');
    expect(HTML).toContain('const peek = row.peek;');
  });

  it('renders a meta line that omits empty tokens (model/repos/ports/PR) instead of dashes', () => {
    expect(HTML).toContain('class="meta"');
    expect(HTML).toContain('metaLine(row)');
    expect(HTML).toContain('row.prs');
    expect(HTML).toContain("'PR #'");
    expect(HTML).not.toContain('<span class="k">Ports</span>');
    expect(HTML).not.toContain('<span class="k">Worktrees</span>');
  });

  it('keeps the labeled body actions (dashboard + session)', () => {
    expect(HTML).toContain('data-act="open-dashboard"');
    expect(HTML).toContain('data-act="open-session"');
  });

  it('keeps the toolbar monitor handoffs (resources + token usage) beside settings', () => {
    expect(HTML).toContain('data-act="open-resources"');
    expect(HTML).toContain('data-act="open-token-usage"');
    expect(HTML).toContain('aria-label="Open resource monitor"');
    expect(HTML).toContain('aria-label="Open token usage"');
  });

  it('carries the three injection markers (UI-R03)', () => {
    expect(HTML).toContain('/*KARST_DS_CSS*/');
    expect(HTML).toContain('/*KARST_DS_JS*/');
    expect(HTML).toContain('<!--KARST_CSP-->');
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

  it('renders the sub-task marker ⊂ <parentKey> distinctly from the follow-up ↳ (NDL-76)', () => {
    // Two ORTHOGONAL relations, two markers: a sub-task row shows its
    // composition parent (`⊂`), a follow-up its temporal parent (`↳`). The
    // sub-task marker is preferred when a row somehow carries both, and its
    // tooltip names the sub-task relation, never "Follow-up".
    expect(HTML).toContain('class="parentref subtaskref"');
    expect(HTML).toContain('Sub-task of ${esc(row.subtaskParentKey)}');
    expect(HTML).toContain('⊂ ${esc(row.subtaskParentKey)}');
    expect(HTML).toMatch(/row\.subtaskParentKey\s*\n?\s*\?\s*`<span class="parentref subtaskref"/);
    expect(HTML).toContain('Follow-up of ${esc(row.parentKey)}');
    expect(HTML).toContain('↳ ${esc(row.parentKey)}');
  });

  it('indents nested sub-task rows by depth via token-spaced nest classes (NDL-76)', () => {
    // Depth comes from the host (`nestSubtasks`); the view only paints it, and
    // clamps to MAX_SUBTASK_INDENT (the writer's MAX_SUBTASK_DEPTH, via
    // ui/sidebar/items.ts). Each step uses a shared spacing token.
    expect(HTML).toContain('nest${Math.min(row.subtaskDepth, MAX_SUBTASK_INDENT)}');
    expect(HTML).toMatch(/\.ticket\.nest1>\.row\{padding-left:var\(--k-space-6\)\}/);
    expect(HTML).toMatch(/\.ticket\.nest2>\.row\{padding-left:var\(--k-space-8\)\}/);
    expect(HTML).toMatch(/\.ticket\.nest3>\.row\{padding-left:var\(--k-space-9\)\}/);
    // The writer allows 4 levels below a root; the deepest one still indents.
    expect(HTML).toContain('.ticket.nest4>.row{padding-left:calc(var(--k-space-9) + var(--k-space-3))}');
    // Exactly MAX_SUBTASK_INDENT (4) nest rules — a nest5 would be unreachable
    // and would mean the view and the writer's depth cap had drifted.
    expect(HTML).not.toContain('.ticket.nest5');
  });

  it('pins the webview indent constant to the writer depth (TS→HTML constant, UI-R34)', () => {
    // The inline script cannot import TS, so it mirrors MAX_SUBTASK_INDENT.
    // Assert it equals the writer's MAX_SUBTASK_DEPTH, so a later writer
    // change that forgets the webview is caught here, not in a broken tree.
    const m = HTML.match(/const MAX_SUBTASK_INDENT = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(MAX_SUBTASK_DEPTH);
  });

  it('offers a collapse control on rows that have sub-tasks, toggling a subtree (NDL-76)', () => {
    // A row with children renders a real button (UI-R09) carrying aria-expanded
    // (UI-R09b); it is a SEPARATE control from the row's own expand chevron.
    expect(HTML).toContain('data-collapse="${row.ticketId}"');
    expect(HTML).toContain('aria-expanded="${!collapsed}"');
    // A leaf renders none: there is nothing to collapse.
    expect(HTML).toMatch(/const canCollapse = \(row\.subtaskChildCount \|\| 0\) > 0/);
    // The click toggles view state and repaints; it never posts to the host.
    expect(HTML).toMatch(/collapsedSubtrees\.has\(id\)\) collapsedSubtrees\.delete\(id\); else collapsedSubtrees\.add\(id\)/);
    // The filter hides descendants of a collapsed row, recursively.
    expect(HTML).toContain('function visibleRows(rows)');
    expect(HTML).toMatch(/collapsedSubtrees\.has\(ancestors\[d\]\)/);
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
});
