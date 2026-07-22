import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

/**
 * Text-level guards on the sidebar list webview.
 *
 * The file is standalone HTML with no harness (see dashboard/webview.test.ts for
 * why). These catch the regression this view already had once: the row rendering
 * silently dropping the stage/status the host went to the trouble of computing.
 */
describe('sidebar webview.html', () => {
  it('renders the stage chip on every collapsed row, colored by the shared stage token', () => {
    // The chip carries stg-<stage> (model/stagePalette), the SAME token the
    // dashboard rail paints with — never the status glyph class it used to.
    expect(HTML).toContain('class="stage ${esc(stageClass)}"');
    expect(HTML).toContain('${esc(stageChip)}');
  });

  it('states the stage (not status) in the chip, with the full phrase in the tooltip', () => {
    // stageChip is the bare stage key; stageText (the status phrase) is the title.
    expect(HTML).toContain('title="${esc(stageText)}">${esc(stageChip)}');
    expect(HTML).toContain('const stageChip = row.stageChip || stageText;');
  });

  it('renders a 5-segment stage rail in the expanded body', () => {
    // One cell per rail entry, colored by the shared stg-* token, current marked.
    expect(HTML).toContain('class="rail"');
    expect(HTML).toContain('(row.rail || []).map');
    expect(HTML).toContain('cell.current');
    expect(HTML).toContain('cell.colorClass');
  });

  it('renders a next-action line carrying the failure reason and attempt', () => {
    expect(HTML).toContain('class="nextact"');
    expect(HTML).toContain('row.nextAction');
  });

  it('renders a meta line that omits empty tokens instead of dashes', () => {
    expect(HTML).toContain('class="meta"');
    expect(HTML).toContain('metaLine(row)');
    // No more fixed "—" Ports/Worktrees rows.
    expect(HTML).not.toContain('<span class="k">Ports</span>');
    expect(HTML).not.toContain('<span class="k">Worktrees</span>');
  });

  it('keeps the labeled body actions (dashboard + session)', () => {
    expect(HTML).toContain("data-act=\"open-dashboard\"");
    expect(HTML).toContain('Session');
  });

  it('falls back rather than painting an empty pill from a stale snapshot', () => {
    expect(HTML).toContain("row.stageLabel || row.description || '—'");
  });

  it('marks each row logo with a status dot, tinted by the same glyph class', () => {
    expect(HTML).toContain('<span class="sdot"></span>');
    expect(HTML).toContain('.glyph .sdot{');
  });

  it('lets multiple status chips light at once (multi-select fix)', () => {
    // A chip click reports which facet was clicked; the host owns the union.
    expect(HTML).toContain("post({ type:'toggle-facet', facet: t.dataset.facet })");
    // Lit state is membership in the selection SET, not equality with one facet.
    expect(HTML).toContain('const sel = new Set(state.facets || [');
    expect(HTML).toContain("sel.has(f.key) ? ' on' : ''");
    // The single-facet equality check must be gone.
    expect(HTML).not.toContain('state.facet ===');
    expect(HTML).not.toContain("type:'set-facet'");
  });

  it('keeps the injection markers — each fails silently when lost', () => {
    for (const marker of ['<!--KARST_CSP-->', '/*KARST_PALETTE*/']) {
      expect(HTML).toContain(marker);
    }
  });
});
