import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
});
