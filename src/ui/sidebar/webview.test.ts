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
  expect(blocks.length).toBeGreaterThanOrEqual(2); // the main <style> + the trailing palette <style>
  return blocks;
}

function scriptBlock(): string {
  const start = HTML.indexOf('<script>');
  const end = HTML.indexOf('</script>');
  expect(start, '<script> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</script> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<script>'.length, end);
}

/**
 * Text-level guards on the sidebar list webview.
 *
 * The file is standalone HTML with no harness (see dashboard/webview.test.ts for
 * why). These catch the regression this view already had once: the row rendering
 * silently dropping the stage/status the host went to the trouble of computing.
 *
 * Task 3.4 of the UI remediation plan added the design-system/accessibility
 * guards below the original set.
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

  it('does NOT repeat the stage as a rail — the collapsed row chip already states it', () => {
    expect(HTML).not.toContain('class="rail"');
    expect(HTML).not.toContain('railHtml');
  });

  it('renders a blocker line ONLY on failure (reason + attempt), never the plain status', () => {
    // The line is gated on row.blocker; a non-failed ticket renders nothing here,
    // so "Implementing"/"Awaiting review"/"Not started" are never duplicated.
    expect(HTML).toContain('const b = row.blocker; if (!b) return');
    expect(HTML).toContain('b.reason');
    expect(HTML).toContain('b.attempt');
    // No plain-status fallback text in the blocker slot.
    expect(HTML).not.toContain('row.nextAction');
  });

  it('renders an activity line for the session runtime state + relative time', () => {
    expect(HTML).toContain('class="activity"');
    expect(HTML).toContain('activityLine(row)');
    expect(HTML).toContain('row.activityLabel');
    expect(HTML).toContain('relTime(row.lastActiveAt)');
  });

  it('renders a meta line that omits empty tokens (model/repos/ports/PR) instead of dashes', () => {
    expect(HTML).toContain('class="meta"');
    expect(HTML).toContain('metaLine(row)');
    // PRs are surfaced in the meta line as "PR #<n>".
    expect(HTML).toContain('row.prs');
    expect(HTML).toContain("'PR #'");
    // No more fixed "—" Ports/Worktrees rows.
    expect(HTML).not.toContain('<span class="k">Ports</span>');
    expect(HTML).not.toContain('<span class="k">Worktrees</span>');
  });

  it('keeps the labeled body actions (dashboard + session)', () => {
    expect(HTML).toContain('data-act="open-dashboard"');
    expect(HTML).toContain('data-act="open-session"');
  });

  it('opens the ticket via a real <button data-open>, dispatched through the shared delegated handler', () => {
    // UI-R09: the old `.row` div with a bare `data-open` click handler is gone.
    expect(HTML).toContain(
      '<button type="button" class="k-btn k-btn--link k-btn--row rowopen" data-open="${row.ticketId}"',
    );
    // The delegated handler falls back to the literal 'open-ticket' type for a
    // data-open target — this is what used to be a literal `post({type:'open-ticket'...})`
    // inline at the row.
    expect(HTML).toContain("const type = t.dataset.act || 'open-ticket';");
  });

  /**
   * Opening a ticket is a handoff: the dashboard panel appearing IS the answer.
   * The button-shaped success flash added a check glyph in the row's leading
   * slot and a --k-success border around it, so every click on a list item
   * animated a badge in and shifted the glyph/name/stage sideways. The row
   * variant keeps the flash and makes it the row's own highlight.
   */
  it('flashes an opened row as a row highlight, not a check badge with a border', () => {
    expect(HTML).toContain('k-btn--row');
    expect(HTML).toContain('.row:has(.rowopen.is-success)');
    expect(HTML).toContain('var(--k-surface-selected)');
  });

  it('lets the pending spinner take the glyph’s slot rather than widen the row', () => {
    // Inserted ahead of the marker, the spinner shifted the name and stage pill
    // right and back again on every click.
    expect(HTML).toContain('.rowopen[aria-busy="true"] .glyph{display:none}');
  });

  it('labels the session button with the continue-or-start verb, not a generic word', () => {
    // The verb comes from row.sessionAction so the button says which it does.
    expect(HTML).toContain('row.sessionAction');
    expect(HTML).toContain('${sessVerb} session');
  });

  it('renders the session subtitle from row.sessionAction.detail', () => {
    expect(HTML).toContain('row.sessionAction.detail');
  });

  it('falls back rather than painting an empty pill from a stale snapshot', () => {
    expect(HTML).toContain("row.stageLabel || row.description || '—'");
  });

  it('marks each row logo with a status dot, tinted by the same glyph class, decorative (UI-R28)', () => {
    // The glyph itself carries role="img" + aria-label (the status word); the
    // sdot is a redundant visual reinforcement of the SAME meaning, so it is
    // aria-hidden rather than a second accessible name.
    expect(HTML).toContain('class="sdot" aria-hidden="true">');
    expect(HTML).toContain('.glyph .sdot{');
  });

  it('lets multiple status chips light at once (multi-select fix)', () => {
    // A chip click reports which facet was clicked; the host owns the union.
    expect(HTML).toContain("post({ type:'toggle-facet', facet: t.dataset.facet })");
    // Lit state is membership in the selection SET, not equality with one facet.
    expect(HTML).toContain('const sel = new Set(state.facets || [');
    expect(HTML).toContain('const pressed = sel.has(f.key);');
    // The single-facet equality check must be gone.
    expect(HTML).not.toContain('state.facet ===');
    expect(HTML).not.toContain("type:'set-facet'");
  });

  it('renders a follow-up annotation beside the row label when parentKey is set', () => {
    expect(HTML).toContain('row.parentKey');
    expect(HTML).toContain('class="parentref"');
  });

  it('keeps the injection markers — each fails silently when lost', () => {
    for (const marker of ['<!--KARST_CSP-->', '/*KARST_PALETTE*/']) {
      expect(HTML).toContain(marker);
    }
  });

  // ── UI-RULES.md remediation guards (Task 3.4) ───────────────────────────────

  it('carries the design-system markers ahead of any file-local rule (UI-R03)', () => {
    const [main] = styleBlocks();
    expect(main!.trimStart().startsWith('/*KARST_DS_CSS*/')).toBe(true);
    const script = scriptBlock();
    expect(script.trimStart().startsWith('/*KARST_DS_JS*/')).toBe(true);
  });

  it('declares no local :root block — status/spacing/type tokens come from the injected design system (UI-R04, R05)', () => {
    const [main] = styleBlocks();
    expect(main).not.toContain(':root');
    expect(main).not.toContain('--mono');
    expect(main).not.toContain('--g-running');
    expect(main).not.toContain('--g-input');
    expect(main).not.toContain('--g-failed');
    expect(main).not.toContain('--g-done');
    expect(main).not.toContain('--g-gray');
  });

  it('contains no raw hex/rgb/px/rem style literal outside the injected tokens (UI-R04)', () => {
    const [main] = styleBlocks();
    const local = main!.slice(main!.indexOf('/*KARST_DS_CSS*/') + '/*KARST_DS_CSS*/'.length);
    const offenders = local.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b[0-9]+(\.[0-9]+)?(px|rem)\b/g);
    expect(offenders, JSON.stringify(offenders)).toBeNull();
  });

  it('does not restyle a bare button, or the two-icon-button split (.tool/.ia) it used to have (UI-R07, R08)', () => {
    const [main] = styleBlocks();
    expect(main).not.toMatch(/(^|\s)button\s*\{/);
    expect(main).not.toContain('.tool{');
    expect(main).not.toContain('.ia{');
    expect(main).not.toContain('.ia:hover');
    expect(main).not.toContain('.ia.danger');
    // The old primary/secondary button classes are gone too.
    expect(main).not.toMatch(/(^|\s)\.btn\s*\{/);
    expect(main).not.toContain('.btn.pri');
    // The old bespoke pill/facet chrome is gone — replaced by .k-chip.
    expect(main).not.toMatch(/(^|\s)\.facet\s*\{/);
  });

  it('every static icon-only <button> uses the .k-iconbtn primitive', () => {
    const iconButtonTags = [...HTML.matchAll(/<button\b[^>]*class="[^"]*\bk-iconbtn\b[^"]*"[^>]*>/g)].map(
      (m) => m[0],
    );
    // btnNew, btnSettings, and the chevron are all static (rows are templated,
    // matched separately below).
    expect(iconButtonTags.length).toBeGreaterThanOrEqual(3);
  });

  it('every icon-only control (static or templated) carries a matching aria-label + title, ≤80 chars, no trailing period (UI-R19–R21, R24)', () => {
    // Anchored to `<button` — a row-action `<button ...>` template literal
    // embedded in the <script> block is still literal `<button ...>` text in
    // the source, so this ALSO catches the templated row actions without
    // separately (and too broadly) matching non-button elements like the
    // glyph's <span role="img"> — whose aria-label/title are deliberately
    // DIFFERENT strings (status word vs. full stage phrase), not a pair.
    const buttonTags = [...HTML.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    const pairs = buttonTags
      .map((tag) => {
        const label = /aria-label="([^"]*)"/.exec(tag);
        const title = /title="([^"]*)"/.exec(tag);
        return label && title ? ([label[1]!, title[1]!] as const) : null;
      })
      .filter((p): p is readonly [string, string] => p !== null);
    // Every icon-only control in this file (toolbar ×2, chevron, row actions ×6)
    // carries the pair; buttons with visible text (rowopen, body .k-btn actions)
    // legitimately have neither and are excluded by the filter above.
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    for (const [label, title] of pairs) {
      expect(label, `${label} vs ${title}`).toBe(title);
      expect(label.length, label).toBeGreaterThan(0);
      expect(label.length, label).toBeLessThanOrEqual(80);
      expect(label.endsWith('.'), label).toBe(false);
    }
  });

  it('the chevron is a real <button> with aria-expanded reflecting open/closed state (UI-R09, R26)', () => {
    expect(HTML).toContain('<button type="button" class="k-iconbtn chev" data-toggle="${row.ticketId}" aria-expanded="${isOpen}"');
    expect(HTML).not.toContain('<span class="chev"');
  });

  it('every click target is a real <button> or <a href> — no bare div/span data-* handler remains (UI-R09)', () => {
    expect(HTML).not.toMatch(/<div class="row"[^>]*data-open/);
    expect(HTML).not.toContain('<span class="chev" data-toggle');
    // The old href-less anchor for the empty-list "create" affordance is gone.
    expect(HTML).not.toContain('<a id="emptyNew">');
    expect(HTML).not.toContain("el('emptyNew')");
  });

  it('the empty-state "create ticket" affordance is a real k-btn, not a hrefless <a> (UI-R09)', () => {
    expect(HTML).toContain('<button type="button" class="k-btn k-btn--link" data-act="create">Create ticket</button>');
  });

  it('delete uses the danger variant on both the icon and the labeled body button (UI-R10b)', () => {
    expect(HTML).toContain('k-iconbtn k-iconbtn--danger" data-act="delete"');
    expect(HTML).toContain('k-btn k-btn--danger" data-act="delete"');
  });

  it('archive uses the danger variant (UI-R10b) while unarchive (a restore, not destructive) does not', () => {
    expect(HTML).toContain('k-iconbtn k-iconbtn--danger" data-act="archive"');
    expect(HTML).not.toMatch(/k-iconbtn--danger"\s*data-act="unarchive"/);
  });

  it('every async control (data-act / data-open) reports pending via the shared runtime, non-re-triggerable, before posting (UI-R11, R12)', () => {
    const script = scriptBlock();
    expect(script).toContain("if (karstIsPending(t) || t.disabled) { e.preventDefault(); return; }");
    expect(script).toContain('const requestId = karstRequestId();');
    expect(script).toContain('karstBeginPending(t, requestId);');
  });

  it('handles action-result by settling the pending control (UI-R13)', () => {
    const script = scriptBlock();
    expect(script).toContain("msg.type === 'action-result'");
    expect(script).toContain('karstSettle(msg.requestId, msg.ok, msg.message)');
  });

  it('toggle-facet and set-filter stay immediate — no requestId, no pending (unchanged behaviour, R37)', () => {
    const script = scriptBlock();
    expect(script).toContain("post({ type:'toggle-facet', facet: t.dataset.facet });");
    expect(script).toContain("post({ type:'set-filter', query:q })");
    // Neither call site includes a requestId.
    expect(script).not.toContain("type:'toggle-facet', facet: t.dataset.facet, requestId");
    expect(script).not.toContain("type:'set-filter', query:q, requestId");
  });

  it('the search input is a real .k-input with an accessible name (UI-R25)', () => {
    expect(HTML).toContain('id="search" class="k-input search-input" aria-label="Search tickets"');
  });

  it('every title attribute (static or single-quoted templated) is a non-empty, period-free string no longer than 80 characters (UI-R20)', () => {
    const staticTitles = [...HTML.matchAll(/title="([^"]*)"/g)].map((m) => m[1]!);
    for (const title of staticTitles) {
      // Skip attributes that are themselves template expressions with no
      // literal text to bound (e.g. title="${esc(stageText)}" alone) — those
      // are covered by the pairing test above when they carry a literal
      // co-string, and by construction (bounded by esc()+host data) otherwise.
      if (/^\$\{[^}]*\}$/.test(title)) continue;
      expect(title.length, title).toBeGreaterThan(0);
      expect(title.length, title).toBeLessThanOrEqual(80);
      expect(title.endsWith('.'), title).toBe(false);
    }
  });

  it('esc() escapes every interpolated ticket-derived string reaching innerHTML', () => {
    const script = scriptBlock();
    for (const expr of [
      'esc(row.glyph)',
      'esc(row.label)',
      'esc(row.parentKey)',
      'esc(stageClass)',
      'esc(stageText)',
      'esc(stageChip)',
      'esc(row.description)',
      'esc(glyphWord)',
    ]) {
      expect(script, expr).toContain(expr);
    }
  });
});
