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

  it('replaces only the status dot with a spinner so the row never shifts', () => {
    /* The spinner takes the dot's absolute slot (same position/size) while the
    karst mark stays visible, so the row width never changes on click. Driven
    by pure CSS on the rowopen button's own aria-busy — no MutationObserver. */
    expect(HTML).toContain('.glyph .sdot-spin{');
    expect(HTML).toContain('.rowopen[aria-busy="true"] .glyph .sdot{display:none}');
    expect(HTML).toContain('.rowopen[aria-busy="true"] .glyph .sdot-spin{display:block}');
    expect(HTML).not.toContain('g-spinning');
    // The generic ::before spinner (a leading flex icon) would push the glyph
    // aside; suppressed HERE, scoped to the sidebar's own control. Never on
    // `.k-btn--row` — the diffs view's file rows rely on that spinner.
    expect(HTML).toContain('.rowopen[aria-busy="true"]::before{content:none}');
    expect(HTML).not.toContain('.k-btn--row[aria-busy="true"]::before');
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

  it('rows carry the approved #35 silhouette, not the old three-node graph', () => {
    expect(HTML).toContain('M 96 20');
    expect(HTML).toContain('M 151 42');
    expect(HTML).toContain('cx="106.5" cy="111.5" r="26.5"');
    expect(HTML).not.toContain('cx="6"');
    expect(HTML).not.toContain('7.6 7.6');
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

  it('caps the follow-up badge so the title keeps its share of the row (balance fix)', () => {
    // A long parent key used to take as much width as it needed (`flex:0 0
    // auto`, no max-width), so the title's flex:1 share shrank toward nothing.
    // The badge now caps at a share of the row and trims with its own ellipsis
    // (the full key stays in the tooltip), leaving the title the remainder.
    const parentref = HTML.match(/\.parentref\s*\{[^}]*\}/)?.[0] ?? '';
    expect(parentref, parentref).toContain('flex:0 1 auto');
    expect(parentref, parentref).toContain('max-width:40%');
    expect(parentref, parentref).toContain('overflow:hidden');
    expect(parentref, parentref).toContain('white-space:nowrap');
    expect(parentref, parentref).toContain('text-overflow:ellipsis');
    // The title stays the flex-1 remainder that trims last — never flex:0.
    expect(HTML).toMatch(/\.name\{[^}]*flex:1/);
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

  it('pins toolbar/search/facets and scrolls only the ticket list (UI-R38)', () => {
    const [main] = styleBlocks();
    // App shell: html/body fill the view; body is a non-scrolling column.
    expect(main).toContain('html,body{height:100%}');
    const bodyRule = main!.match(/body\{[^}]*\}/)?.[0] ?? '';
    expect(bodyRule).toContain('display:flex;flex-direction:column;');
    expect(bodyRule).toContain('overflow:hidden');
    // The three header blocks are pinned — they never flex out of view.
    expect(main!).toMatch(/\.toolbar\{[^}]*flex:0 0 auto/);
    expect(main).toMatch(/\.search\{[^}]*flex:0 0 auto/);
    expect(main).toMatch(/\.facets\{[^}]*flex:0 0 auto/);
    // The list is the one flex child that may shrink below its content, and it
    // is the ONLY scroll container in the file.
    const listRule = main!.match(/\.list\{[^}]*\}/)?.[0] ?? '';
    expect(listRule).toContain('flex:1;');
    expect(listRule).toContain('min-height:0;');
    expect(listRule).toContain('overflow-y:auto');
    expect(main!.match(/overflow-y:auto/g) ?? []).toHaveLength(1);
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

  it('the chevron keeps the .k-iconbtn hit target — only its padding is overridden (UI-R29)', () => {
    // `.chev` may tighten the INSET (zero padding per the prototype) but never
    // the min-size: the expand/collapse control must keep the --k-hit-min
    // target the .k-iconbtn primitive guarantees (WCAG 2.5.8).
    const chev = HTML.match(/\.chev\s*\{[^}]*\}/)?.[0] ?? '';
    expect(chev).toContain('padding:0');
    expect(chev).not.toContain('min-width:auto');
    expect(chev).not.toContain('min-height:auto');
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

  it('marks the row active when its ticket view (dashboard/edit/diffs) is the window ACTIVE view', () => {
    // The class rides the row root so the highlight spans the whole ticket
    // (collapsed row + expanded body), and it is a no-op when absent.
    expect(HTML).toContain("${row.isActive ? ' active' : ''}");
    expect(HTML).toMatch(/class="ticket\$\{isOpen \? ' open' : ''\}/);
  });

  it('highlights the active row with the focus color, never the selection wash (STYLE-GUIDE §10)', () => {
    const [main] = styleBlocks();
    // "Currently active" is its own meaning: the active row uses --k-focus (the
    // focused-surface color) instead of --k-surface-selected ("this item is
    // selected"), and gets a left rail as the shape carrier so the state is
    // never color-only (UI-R28 spirit — a distinct glyph per state).
    expect(main).toContain('.ticket.active .row{');
    expect(main).toContain('var(--k-focus)');
    expect(main).not.toContain('.ticket.active .row{background:var(--k-surface-selected)');
    expect(main).toContain('.ticket.active .row::before');
  });

  it('the active highlight outranks the hover wash so it survives pointer motion', () => {
    const [main] = styleBlocks();
    const active = main!.indexOf('.ticket.active .row{');
    const hover = main!.indexOf('.row:hover{');
    expect(active).toBeGreaterThan(hover);
  });

  // ── Current / Recently Done / Older Completed sections (869egrd09) ─────────

  it('renders lightweight section headers with the rendered count (CURRENT · N)', () => {
    const script = scriptBlock();
    expect(script).toContain('class="sec" role="presentation"');
    expect(script).toContain('class="sec-name"');
    expect(script).toContain('">· ${count}</span>');
    // The header count is the rows rendered below it — never a promise of rows
    // a query has hidden.
    expect(script).toContain('secHtml(');
  });

  it('the Older Completed disclosure is a real button, keyboard accessible, with aria-expanded (UI-R09, R26)', () => {
    const script = scriptBlock();
    expect(script).toContain(
      '<button type="button" class="k-btn k-btn--ghost hist" data-history="1" aria-expanded="${expanded}"',
    );
    expect(script).toContain('${n} more completed');
    expect(script).toContain('aria-controls="histlist"');
    // The disclosure is handled before the ticket-toggle branch in the
    // delegated click handler — a click on it must never reach a ticket id.
    expect(script).toContain("if (t.dataset.history) {");
    // data-history carries a VALUE: `dataset` reads a valueless attribute as
    // '' (falsy), which would make the toggle dead on arrival.
    expect(script).toContain('data-history="1"');
  });

  it('the disclosure chevron rotates on the aria-expanded state, and the whole row is the button', () => {
    const [main] = styleBlocks();
    expect(main).toMatch(/\.hist\[aria-expanded="true"\] \.hist-chev\{[^}]*transform:rotate\(90deg\)/);
    expect(main).toContain('.hist{display:flex;');
  });

  it('completed rows use the compact treatment: check indicator, muted title, no stage pill', () => {
    const script = scriptBlock();
    // The check-in-ring replaces the karst mark + status dot on compact rows…
    expect(script).toContain('class="glyph chk g-${esc(row.glyph)}" aria-hidden="true"');
    // …the stage pill renders only on full rows (a redundant DONE badge would
    // restate what the section header already says)…
    expect(script).toContain('(compact\n        ? (opts.time');
    expect(script).toContain(": `<span class=\"stage ${esc(stageClass)}\"");
    // …and the row root carries the compact/older markers for the quieter CSS.
    expect(script).toContain("${compact ? ' done' : ''}");
    expect(script).toContain("${opts.older ? ' older' : ''}");
    // Recently Done shows the relative completion time; Older Completed does not.
    expect(script).toContain("opts.time ? `<span class=\"time\">${esc(relTime(row.lastActiveAt))}</span>` : ''");
  });

  it('search auto-reveals Older Completed without marking the reveal as the user choice', () => {
    const script = scriptBlock();
    // A query matching older tickets expands the section…
    expect(script).toContain("const expanded = histUser ? histOpen : (q !== '' && older.length > 0);");
    // …but only an explicit click sets histUser — clearing the search then
    // restores the default collapsed state.
    expect(script).toContain('histUser = true;');
    expect(script).toContain('histOpen = !histOpen;');
  });

  it('the Done facet renders the full completed list directly with no history control', () => {
    const script = scriptBlock();
    expect(script).toContain("secHtml('Done', rows.length)");
    expect(script).toContain('rowHtml(r, { compact: true, time: true })');
    expect(script).toContain("L.innerHTML = emptyHtml('done'); return;");
  });

  it('a pre-upgrade snapshot (no sections) degrades to the flat rows rather than an empty list', () => {
    const script = scriptBlock();
    expect(script).toContain('(state.sections && state.sections.current) || state.rows || []');
  });

  it('the older-completed list is one section of the single scroll surface, never its own scroller', () => {
    const [main] = styleBlocks();
    // UI-R38: the ticket list stays the ONLY scroll container — no
    // overflow-y on .histlist or any section.
    expect(main!.match(/overflow-y:auto/g) ?? []).toHaveLength(1);
    expect(main).not.toContain('.histlist{overflow');
  });

  it('keeps the completed-history expand state out of the host protocol (view state only)', () => {
    const script = scriptBlock();
    expect(script).not.toContain("type:'toggle-history'");
    expect(script).not.toContain("type:'set-history'");
  });
});
