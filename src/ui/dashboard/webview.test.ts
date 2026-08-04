import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

/**
 * Text-level guards on the dashboard webview.
 *
 * The webview is standalone HTML with no test harness: it cannot be imported,
 * and adding jsdom for it would make it the only DOM test in the repo. That is
 * affordable only because every DECISION was moved host-side — glyph and class
 * maps, geometry, clocks, durations, blurbs, the armed flag — leaving the file
 * with little more than `map` over precomputed data.
 *
 * What these tests can catch: a lost injection marker, the rail regressing to
 * the flat stepper, selection leaking into host-owned state, an action the host
 * does not validate. What they cannot catch: a mistyped class, a broken calc(),
 * or a selection round trip that fails in a real webview. Those need F5.
 */
describe('dashboard webview.html', () => {
  it('renders the Now session subtitle from action.detail', () => {
    expect(HTML).toContain('a.detail');
  });

  it('shows the live core/model and a payload-free switch action beside Now', () => {
    expect(HTML).toContain('agentSession.providerLabel');
    expect(HTML).toContain('agentSession.modelLabel');
    expect(HTML).toContain('data-act="switch-agent"');
    expect(HTML).toMatch(/agentSession\.canSwitch[\s\S]*switch-agent/);
    expect(HTML).not.toMatch(/data-act="switch-agent"[^>]*data-(?:provider|model|ticket)/);
  });

  it('builds the switch action on the shared secondary button, not a bespoke style rule', () => {
    // UI-R07: no local rule may restyle a <button> (background/border/padding/
    // radius/font-size) — `.switch-agent` used to declare its own colors with
    // a hex-adjacent VS Code fallback chain; it is now a layout-only class
    // riding on `.k-btn--secondary`, which already resolves through the same
    // secondaryBackground/secondaryForeground tokens.
    expect(HTML).toMatch(/class="k-btn k-btn--secondary[^"]*switch-agent"[^>]*data-act="switch-agent"/);
    expect(HTML).not.toMatch(/\.switch-agent\{[^}]*background/);
  });

  it('renders ticket changes as one accessible diff icon button', () => {
    expect(HTML.match(/data-act="show-changes"/g)).toHaveLength(1);
    expect(HTML).toMatch(/id="wtChanges"[^>]*aria-label="Show ticket changes"/);
    expect(HTML).toMatch(/id="wtChanges"[^>]*title="Show ticket changes"/);
    expect(HTML).toContain('href="#i-diff"');
    expect(HTML).not.toMatch(/id="wtChanges"[^>]*>Changes<\/button>/);
    expect(HTML).not.toContain('diff-worktree');
  });

  it('renders terminal, branch-copy, and reveal actions for each worktree', () => {
    expect(HTML).toContain('data-act="open-worktree-terminal"');
    expect(HTML).toContain('data-act="copy-worktree-branch"');
    expect(HTML).toContain('data-branch="${esc(w.branch)}"');
    expect(HTML).toContain('data-copy');
    expect(HTML).toContain('Open Terminal');
    expect(HTML).toContain('Reveal in Explorer');
    expect(HTML).not.toContain('>Open folder</button>');
  });

  it('renders ephemeral additions and deletions by host-owned repo identity', () => {
    expect(HTML).toMatch(/worktreeStats\[w\.repo\]/);
    expect(HTML).toContain("msg.type === 'worktree-stats'");
    expect(HTML).toContain('stats.additions');
    expect(HTML).toContain('stats.deletions');
    expect(HTML).toContain('worktreeStats = {}');
  });

  /**
   * The panels sit side by side in one grid row: a header that sizes itself to
   * its own contents puts its body on a different line from its neighbour's,
   * which is what made the Worktrees block read as drifted. One declared height
   * is what keeps them level whatever a header carries.
   */
  it('gives every panel header the same declared height', () => {
    // Composed from tokens rather than a bare 39px literal (UI-R04).
    expect(HTML).toMatch(/--phead-h:calc\(var\(--k-control-h-lg\) \+ var\(--k-space-4\) \+ var\(--k-border-w\)\)/);
    expect(HTML).toMatch(/\.phead\{[^}]*min-height:var\(--phead-h\)/);
    // No per-panel override may reintroduce a second height.
    expect(HTML).not.toMatch(/\.svpanel \.phead\{[^}]*(?:min-)?height:/);
    expect(HTML).not.toMatch(/\.svpanel \.phead\{[^}]*padding:/);
  });

  /**
   * `.count` earns its position from `margin-left:auto` against .phead's flex
   * line. Wrapped in a span it had nothing to push against and printed flush
   * against the label.
   */
  it('keeps the worktrees count a direct child of its panel header', () => {
    expect(HTML).toContain('<div class="phead">Worktrees<span class="count" id="wtCount"></span>');
  });

  it('keeps every injection marker — each one fails silently when lost', () => {
    // injectCsp no-ops on a marker-less document by design, and the provider
    // markers are load-bearing at runtime (renderKeyPill calls providerIconHtml,
    // which only exists because the JS marker was substituted).
    for (const marker of [
      '<!--KARST_CSP-->',
      '/*KARST_PROVIDER_CSS*/',
      '/*KARST_PROVIDER_JS*/',
      '/*KARST_PALETTE*/',
    ]) {
      expect(HTML, `missing marker: ${marker}`).toContain(marker);
    }
  });

  it('draws the rail from state.rail, not from the flat stepper', () => {
    // The regression net for the flattening bug: state.stepper contains fix, so
    // rendering the rail from it puts fix back on the forward path.
    expect(HTML).toContain('state.rail');
    expect(HTML).not.toContain('renderStepper(state.stepper)');
  });

  it('keeps fix off the forward path — it is drawn on the gate it retries', () => {
    // The regression net for the flattening bug, restated for the track: `fix` is
    // reached only by a failed verdict and its only edge returns to uat, so it can
    // never be a segment. It appears exactly once, as the retry meter's own
    // data-stage — which is also how it stays selectable now the node is gone.
    expect(HTML).toContain('rail.main.map');
    expect(HTML).not.toMatch(/rail\.(branch|geometry|armed|cap)\b/);
    expect(HTML.match(/data-stage="fix"/g)).toHaveLength(1);
    expect(HTML).toMatch(/class="fixm [^"]*"[^>]*data-stage="fix"/);
  });

  it('draws the retry meter only on the gate that carries the loop', () => {
    // Not on fix, not on every gate, and not at all before the loop is entered —
    // the host decides that (model/stageRail.ts) and the webview only renders
    // what it is given.
    expect(HTML).toMatch(/if \(s\.retry\) extra \+= renderMeter\(s\.retry\)/);
    expect(HTML).toMatch(/function renderMeter\(retry\)/);
  });

  it('draws one tick per ALLOWED attempt, from the host’s cap', () => {
    // A meter with more ticks than the driver will spend lies about how many
    // retries are left, which is the one thing the meter exists to say. The cap
    // comes from the manifest via the host; a literal 3 here would ignore a
    // narrowed uat.maxFixAttempts.
    expect(HTML).toContain('{ length: retry.cap }');
    expect(HTML).not.toMatch(/length:\s*3\b/);
    expect(HTML).toContain('i < retry.spent');
  });

  it('never nests a button inside a button — the parser would close the outer one', () => {
    // The segment is a <div> wrapper holding the select control AND, when the
    // stage is parked on the user, the action control. Nested, the parser closes
    // the outer button and the whole track loses its structure.
    expect(HTML).toMatch(/<div class="seg stg-\$\{esc\(k\)\}/);
    expect(HTML).not.toMatch(/<button[^>]*class="pick"[^>]*>[^<]*<button/);
  });

  it('makes every segment a real button, so the track is keyboard-reachable', () => {
    expect(HTML).toMatch(/<button type="button" class="pick"/);
    expect(HTML).toContain('aria-pressed');
    // Never a clickable div (UI-R09): the wrapper carries no handler of its own.
    expect(HTML).not.toMatch(/<div class="seg[^"]*"[^>]*data-stage=/);
  });

  it('puts the retry loop in the accessible name, not only in the meter', () => {
    // Everything the narrow steps drop must already be in the name, because the
    // name does not degrade — the attempt count and the return target included.
    expect(HTML).toContain('fix ${s.retry.spent}/${s.retry.cap}');
    expect(HTML).toContain('revalidates from ${s.retry.returnsTo}');
  });

  it('says needs-you in words, not only in the amber', () => {
    // UI-R28: four carriers — wash, glyph, the reason, the action.
    expect(HTML).toMatch(/needs \? `\$\{title\}: needs you`/);
    expect(HTML).toContain("const NEEDS_GLYPH");
    expect(HTML).toContain("const CONFLICT_GLYPH");
    expect(HTML).toMatch(/s\.needs \? s\.needs\.detail/);
  });

  it('reads needs-you from the host, never re-deriving it in the webview', () => {
    // A second answer to "is this blocked on the user" is exactly what the single
    // derivation (model/ticketGlyph.needsUser) exists to prevent.
    const track = HTML.slice(
      HTML.indexOf('function renderTrack('),
      HTML.indexOf('function renderPips('),
    );
    expect(track).toMatch(/s\.needsUser === true/);
    // No stage-name test and no status test: `needsConfirm(stage) && pending` is
    // the host's answer, and asking it a second time here is how two surfaces
    // start disagreeing about whether a ticket is blocked.
    expect(track).not.toMatch(/=== 'ship'|=== 'merge'|'pending'/);
  });

  it('makes the needs-you button navigational, never a second actor', () => {
    // karst never performs an irreversible step from the track: merge is per-repo
    // and its confirmation modal lives in the host, so a track-level Merge button
    // could neither pick a repo nor carry the confirmation.
    expect(HTML).toContain('data-goto');
    expect(HTML).toMatch(/function gotoAction\(\)/);
    const fn = HTML.slice(HTML.indexOf('function gotoAction()'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toContain('scrollIntoView');
    expect(body, 'the track posts nothing').not.toContain('post(');
  });

  it('fills a phase pip only for a phase the agent reported', () => {
    // Declared is not observed. A hollow pip means "not reported", never "not
    // done" — karst records no per-phase state it was not explicitly told.
    expect(HTML).toContain('approach.reported');
    expect(HTML).toMatch(/done\.has\(p\)/);
    expect(HTML).toContain('not reported');
  });

  it('names the approach on impl even when it declares no phases', () => {
    // An approach with an empty `workflow` (the built-in `direct`, or a package
    // that ships prompts only) is still the thing driving impl, and the current
    // segment is the one place the panel says so. Returning early on an empty
    // `phases` left the widest segment on the track completely blank.
    const fn = HTML.slice(HTML.indexOf('function renderPips('));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body, 'an approach with no phases renders nothing').not.toMatch(
      /if \(!phases\.length\) return ''/,
    );
    expect(body).toContain('approach.id');
  });

  it('keeps the current segment’s text legible on its own wash (UI-R29)', () => {
    // `--k-success-fg` is the KNOCKOUT foreground — `--vscode-editor-background`,
    // paired with a saturated feedback FILL. The running segment is not a fill:
    // it is a 34% wash of the stage hue over the lane, so the knockout resolves
    // to (near) the background it sits on — dark-on-dark in a dark theme and
    // white-on-lavender in a light one. The wash is designed to carry ordinary
    // body text, so it takes ordinary body text.
    expect(HTML).toMatch(/\.track \.seg\.running\{[^}]*color:var\(--k-text\)/);
    expect(HTML).not.toMatch(/\.track \.seg[^{]*\{[^}]*color:var\(--k-success-fg\)/);
  });

  it('marks the selected segment with the segment’s own shape, never a stray edge', () => {
    // A segment is a CHEVRON (clip-path), and `clip-path` clips a child's
    // rendering — so a rectangular ring on the inset `.pick` lost its left and
    // right strokes in the two notches and survived as two detached horizontal
    // bars; at the ends of the lane its square corners sat inside the lane's
    // `--k-radius-lg`, which read as the mark being shifted off the block it
    // marks. The underline that replaced it had the same problem from the other
    // side: it read as a stray bottom border on the segment. Selection is drawn
    // as the chevron ring, sharing one shape with focus.
    const ring = HTML.match(/@supports \(width: calc\(1px \* hypot[^{]*\{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(ring).toContain('.track .seg.sel .pick,');
    expect(ring).toContain('.track .seg:first-child.sel .pick,');
    expect(ring).toContain('.track .seg:last-child.sel .pick,');
    // Focus outranks selection on a segment that is both, so it is stated LAST —
    // and it is what drops the outline, so the two can never both be missing.
    const focusLast = ring.lastIndexOf('.track .seg .pick:focus-visible{outline:0');
    expect(focusLast, 'focus does not win the ring colour').toBeGreaterThan(
      ring.indexOf('.track .seg.sel .pick,'),
    );
    // The baseline survives for a browser that cannot compute the shape — and
    // the guard turns it off rather than painting both.
    expect(HTML).toMatch(/\.track \.seg\.sel\{box-shadow:inset[^}]*var\(--k-series-2\)\}/);
    expect(ring).toContain('.track .seg.sel{box-shadow:none}');
    // …which only works if the baseline is declared BEFORE the guard: same
    // specificity, so a later baseline would win and the underline would come
    // back underneath the ring.
    expect(HTML.indexOf('.track .seg.sel{box-shadow:inset')).toBeLessThan(
      HTML.indexOf('@supports (width: calc(1px * hypot'),
    );
  });

  it('draws the ring flush to the segment, joined without crossing itself', () => {
    // Brace-balanced, not `[\s\S]*?\n  }` — this test asserts on what the guard
    // does NOT contain, so an over-capture that ran into the next rule would
    // read a later `--k-focus-offset` as this block's.
    const at = HTML.indexOf('@supports (width: calc(1px * hypot');
    let depth = 0;
    let end = at;
    for (let i = HTML.indexOf('{', at); i < HTML.length; i += 1) {
      if (HTML[i] === '{') depth += 1;
      else if (HTML[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const ring = HTML.slice(at, end);
    expect(ring, 'the chevron ring is not behind an @supports guard').toContain('clip-path');
    // FLUSH. An outer boundary inset by `--k-focus-offset` read as a hairline gap
    // all the way round, and at the ends of the lane its square corners sat
    // inside the lane's own `--k-radius-lg`. On the segment's own edge, the
    // lane's rounded overflow clips ring and segment identically.
    expect(ring, 'the ring is inset off the segment edge').not.toContain('--k-focus-offset');
    for (const [, points] of ring.matchAll(/clip-path:polygon\(evenodd,([\s\S]*?)\)\}/g)) {
      const pts = points!
        .split(/,(?![^(]*\))/)
        .map((p) => p.replace(/\s+/g, ' ').trim());
      // Each ring opens on the segment's own polygon: its first point is the
      // segment's, and every outer point is free of the inset vars.
      expect(pts[0], `ring does not start on the segment corner: ${pts[0]}`).toBe('0 0');
      // ZERO-AREA SLIT. `polygon()` is ONE contour with no move-to, so the two
      // connectors that reach the hole REPLACE the inner edge they jump across —
      // and that edge, with the band it bounds, is simply gone from the shape.
      // Both earlier orderings lost the ring's left stroke that way. So the outer
      // loop closes on its own first point, and the inner loop starts AND ends on
      // one point: the two connectors coincide and cancel, and no edge is lost.
      const outerEnd = pts.indexOf('0 0', 1);
      expect(outerEnd, 'the outer loop is not closed before the hole').toBeGreaterThan(2);
      expect(pts[outerEnd + 1], 'the hole does not close on the point it opened on')
        .toBe(pts[pts.length - 1]);
      // Every inner point is derived perpendicularly; none is a bare axis inset.
      for (const p of pts.slice(outerEnd + 1)) {
        expect(p, `inner point is not inset from the edge: ${p}`).toMatch(/var\(--r[tlrq]\)/);
      }
    }
  });

  it('outlines a focused segment in the segment’s own shape, with a working fallback', () => {
    // Same defect as the selection ring, one state further: an `outline` is a
    // rectangle, `clip-path` clips a child's rendering, so the focus ring's
    // vertical strokes fell inside the two notches and were cut — a border that
    // visibly did not close around the arrow it belonged to. The ring is drawn
    // as a SHAPE instead: the chevron minus a smaller chevron (`evenodd`).
    const ring = HTML.match(/@supports \(width: calc\(1px \* hypot[^{]*\{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(ring, 'the chevron ring is not behind an @supports guard').not.toBe('');
    expect(ring).toContain('clip-path:polygon(evenodd,');
    // The inner chevron is offset PERPENDICULARLY to the edge — derived from the
    // edge length, never the same px in both axes, which would splay the
    // diagonals and taper the ring.
    expect(ring).toContain('var(--trk-diag)');
    expect(HTML).toMatch(/--trk-diag:hypot\(var\(--trk-notch\),var\(--trk-half\)\)/);
    // Both ends of the lane carry one notch, not two.
    expect(ring).toContain('.track .seg:first-child .pick:focus-visible');
    expect(ring).toContain('.track .seg:last-child .pick:focus-visible');
    // The guard exists because a browser that cannot compute the ring would drop
    // the clip-path and keep the fill — a focus-coloured block over the whole
    // segment. Outside it, the plain outline must survive as the indicator.
    const outside = HTML.replace(ring, '');
    expect(outside).toMatch(
      /\.track \.seg \.pick:focus-visible\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/,
    );
  });

  it('names the track’s two controls for a screen reader, not just a hover title', () => {
    // Both are glyph-or-shape only — aria-label and title must carry the SAME
    // string (UI-R21/R24).
    expect(HTML).toMatch(/aria-label="\$\{esc\(aria\)\}" title="\$\{esc\(aria\)\}"/);
    expect(HTML).toMatch(/aria-label="\$\{esc\(label\)\}" title="\$\{esc\(label\)\}"/);
  });

  it('keeps the selection beside the host state, never inside it', () => {
    // Persisting `sel` inside `state` would mean the next pushState — which the
    // host builds from the DB — silently drops it, and would put a webview
    // concern into a host-owned type.
    expect(HTML).toContain('vscode.setState({ state:');
    expect(HTML).not.toMatch(/state\.sel\s*=/);
  });

  it('resolves selection locally, so a state push cannot reset it', () => {
    // pushState fires on every driver progress tick; anything that reset the
    // selection would snap the panel back to the current stage during a run.
    expect(HTML).toContain('selectedStage');
    expect(HTML).toMatch(/selectedStage\s*\|\|\s*\w+\.stageCurrent/);
  });

  it('emits no action the host does not validate', () => {
    const declared = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'messages.ts'),
      'utf8',
    );
    // Literal names only. The Now line's button interpolates its action from
    // NOW_MESSAGE, whose values are themselves literals declared below.
    const emitted = [...HTML.matchAll(/data-act="([^"$]+)"/g)].map((m) => m[1]!);
    expect(emitted.length).toBeGreaterThan(0);
    for (const act of new Set(emitted)) {
      expect(declared, `unvalidated action: ${act}`).toContain(`'${act}'`);
    }
  });

  /**
   * Guards on the rail's decoration geometry.
   *
   * Be honest about what these are: a text assertion CANNOT catch a visual
   * regression. It cannot tell you the ring is clipped, fused, or painted under
   * a connector — only that the rule which stops that is still in the file. Each
   * one below was written after reproducing the defect in a browser, and each
   * exists so the fix cannot be quietly deleted by someone tidying the CSS.
   * Re-verifying the pixels needs F5 (or the iframe harness).
   */
  it('keeps the lane scrollable, never clipped', () => {
    // overflow:hidden is what turned an over-wide track into an INVISIBLE defect:
    // the current segment's own action button was clipped away with nothing to
    // say so, and the two-step degradation only looked correct because of it. A
    // scrollbar is something the user can act on; silent clipping is not.
    expect(HTML).toMatch(/\.lane\{[^}]*overflow-x:auto/);
    expect(HTML).not.toMatch(/\.lane\{[^}]*overflow:hidden/);
    // …and the wrapper no longer needs a scroller of its own.
    expect(HTML).not.toMatch(/\.railwrap\{[^}]*overflow-x:auto/);
  });

  it('degrades in three measured steps, each of which drops something', () => {
    // Two was the first draft and it did not fit: at a 397px lane five of the
    // eight mockup cases were still over after `tight`.
    for (const step of ['snug', 'tight', 'bare']) {
      const rules = HTML.match(new RegExp(`\\.track\\.${step}[^{]*\\{[^}]*\\}`, 'g')) ?? [];
      expect(rules.length, `no .track.${step} rule`).toBeGreaterThan(0);
      expect(
        rules.some((r) => /display:none|min-width:0|padding/.test(r)),
        `.track.${step} drops nothing`,
      ).toBe(true);
    }
  });

  it('never hides the current segment’s name or its action, at any step', () => {
    // The floor: the name says where the ticket is and the button says what is
    // wanted. Both survive to 300px; only annotations are given up.
    const hiders = HTML.match(/\.track\.(?:snug|tight|bare)[^{]*\{[^}]*display:none[^}]*\}/g) ?? [];
    for (const rule of hiders) {
      const selector = rule.slice(0, rule.indexOf('{'));
      expect(selector, 'a step hides the current segment’s name').not.toMatch(/\.seg\.cur \.nm[,{\s]*$/);
      expect(selector, 'a step hides the current segment’s action').not.toMatch(/\.seg\.cur \.go/);
    }
  });

  it('measures rather than positions — the track pushes no geometry from the host', () => {
    // The old rail bolted a second lane to specific columns with calc() inputs
    // written inline from state.rail.geometry. There is no second lane, so the
    // one measurement left picks a class and positions nothing.
    expect(HTML).toContain('lane.scrollWidth > lane.clientWidth');
    expect(HTML).not.toMatch(/--cols:\$\{/);
    expect(HTML).toMatch(/window\.addEventListener\('resize', place\)/);
  });

  it('lets the stage palette win the hue, because the segment never claims it', () => {
    // `.track .seg` is (0,2,0); the injected `stg-<stage>` classes are (0,1,0), so
    // a `color`/`--stg-color` on the scoped rule beats them at ANY source order
    // and every travelled segment renders neutral grey — which silently kills the
    // one thing the wash exists to say. The old `.st` rule tied at (0,1,0) and
    // lost to the later injection; scoping is what broke that tie.
    const base = HTML.match(/\.track \.seg\{[^}]*\}/)?.[0] ?? '';
    expect(base, 'the base segment rule must not set a colour').not.toMatch(/(^|[;{])color:/);
    expect(base, 'the base segment rule must not set --stg-color').not.toContain('--stg-color:');
    // Untravelled is neutral by its own class, not by the base rule's default.
    expect(HTML).toMatch(/\.track \.seg\.pending\{color:var\(--k-text-faint\)\}/);
    expect(HTML).toMatch(/pending: 'pending'/);
  });

  it('scopes every track selector, so it cannot collide with the strip', () => {
    // The dashboard already owns `.act` (the activity strip) and `.ph*`; an
    // unscoped `.seg`/`.fixm` would silently restyle them.
    expect(HTML).not.toMatch(/^\s*\.seg\{/m);
    expect(HTML).not.toMatch(/^\s*\.fixm\{/m);
    expect(HTML).toMatch(/\.track \.seg\{/);
    expect(HTML).toMatch(/\.track \.fixm\{/);
  });

  it('stops the spinner and the needs-you breathe under reduced motion (UI-R30)', () => {
    const rm = HTML.match(/@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(rm).toContain('.spin');
    expect(rm).toContain('.track .seg.needs');
    expect(rm).toContain('animation:none');
  });

  /**
   * Servers panel. Every rule below was written after reproducing the defect it
   * prevents in a browser against `design/servers-variants.html`; each is here
   * so the fix cannot be quietly deleted by someone tidying the file. As with
   * the rail guards: text assertions catch DELETION, not visual regression.
   */
  it('puts the whole-ticket server controls in the panel header, not the body', () => {
    // They act on every service, so they must survive the states where the body
    // has no rows to hang a button off — the empty body is exactly when Start
    // matters most. Rendering into a header slot is what makes that possible.
    expect(HTML).toContain('id="srvOps"');
    expect(HTML).toMatch(/panelOps/);
  });

  it('drops the panel controls entirely when nothing in scope can run', () => {
    // Not disabled — absent. A control that can never become available is a
    // permanent dead affordance, and greying it only asks the user to keep
    // re-checking it.
    expect(HTML).toMatch(/hasRunnableRepos === false\) return ''/);
  });

  it('gives every disabled icon button a title saying why', () => {
    // A greyed icon with no explanation is a dead end: the user cannot tell a
    // broken button from an inapplicable one.
    expect(HTML).toMatch(/disabledWhy \? ' disabled' : ''/);
    expect(HTML).toMatch(/title="\$\{esc\(disabledWhy \|\| label\)\}"/);
  });

  it('keeps the status word on the bare dot, for pointer and screen reader', () => {
    // The row shows a 9px dot and no text, so aria-label + title are the ONLY
    // things still carrying "running"/"offline". Shape (filled disc vs hollow
    // ring) plus the "—" address keep it off colour alone.
    expect(HTML).toMatch(/class="glyph \$\{on \? 'on' : 'off'\}" role="img"/);
    expect(HTML).toMatch(/aria-label="\$\{status\}" title="\$\{status\}"/);
    expect(HTML).toMatch(/\.glyph\.off\{[^}]*border:calc\(var\(--k-border-w\) \* 2\) solid/);
  });

  it('names every icon-only action, since the icon is the whole label', () => {
    // aria-label and title carry the SAME string (UI-R21), including the
    // disabled-reason case — a screen-reader user needs to know WHY an icon
    // is greyed out exactly as much as a sighted one reading the tooltip.
    expect(HTML).toMatch(/aria-label="\$\{esc\(disabledWhy \|\| label\)\}" title="\$\{esc\(disabledWhy \|\| label\)\}"/);
  });

  it('restacks nothing at narrow width — one service is one line at every size', () => {
    // The specificity trap this encodes: `td.c-acts` (0,2,1) out-specifies a
    // bare `td` (0,1,1) REGARDLESS of source order, so the container query's
    // reset must re-qualify the class or the 1% action column survives into
    // narrow and wraps every icon onto its own line.
    expect(HTML).toMatch(/@container \(max-width: ?400px\)/);
    expect(HTML).toMatch(/td\.c-acts\{[^}]*width:auto/);
  });

  it('scopes the container query to the servers panel, not every panel', () => {
    // .panel is shared with Worktrees and Pull requests; containment belongs to
    // the one panel that reacts to its own column width.
    expect(HTML).toMatch(/\.svpanel\{[^}]*container-type:inline-size/);
    expect(HTML).not.toMatch(/\.panel\{[^}]*container-type/);
  });

  it('keeps the server filter beside the host state, like the selection', () => {
    // A state push arrives on every server change; if the filter lived in
    // DashboardState (or nowhere) the text would be wiped mid-typing.
    expect(HTML).toMatch(/srvFilter/);
    expect(HTML).not.toMatch(/state\.srvFilter/);
    expect(HTML).toMatch(/srvFilter:\s*srvFilter/);
  });

  it('offers the terminal binding as a real pressed-state toggle', () => {
    // Icon-free text button, but still a toggle: screen readers need the pressed
    // state, since "Bind" alone does not say whether it is currently on.
    expect(HTML).toContain('data-act="toggle-bind"');
    expect(HTML).toMatch(/id="bindBtn"[^>]*aria-pressed/);
  });

  it('renders the binding from the host push, never from its own memory', () => {
    // The binding is window-wide and host-owned: two dashboards are open at
    // once, so a webview that remembered its own value would drift from the
    // other panel and from the host after a toggle.
    expect(HTML).toMatch(/'bind'|"bind"/);
    expect(HTML).toMatch(/bindEnabled\s*=\s*[^;]*\bmsg\b/);
    // Not persisted beside the snapshot, unlike sel/fixExpanded/srvFilter —
    // the host re-pushes it on every open, so a stored copy could only be stale.
    expect(HTML).not.toMatch(/setState\(\{ state:[^}]*bindEnabled/);
  });

  it('no longer carries the removed impl-phase strip', () => {
    expect(HTML).not.toContain('renderSubsteps');
    expect(HTML).not.toContain('implPhases');
  });

  /**
   * Confirm-ship progress feedback. The bug: clicking Confirm ship kicked off
   * slow backend work (model call + `gh pr create`) with zero UI change until it
   * finished — the button looked inert and users could not tell the click even
   * registered. Later, the live progress it DID show was free text hijacking the
   * Now line instead of structured rows in the Inside block — these guard the
   * pieces that fix both; the pixels need F5.
   */
  it('registers the confirm-ship click before the host round trip', () => {
    // shipping is flipped and shipOps seeded inside the click handler, not on
    // the next state push — so there is no window where the button looks inert.
    expect(HTML).toMatch(/act === 'ship-ticket'/);
    expect(HTML).toMatch(/shipping = true/);
    expect(HTML).toMatch(/shipOps = seedShipOps\(/);
  });

  it('guards against a double confirm-ship submit while one is in flight', () => {
    // Re-clicking must not fire a second ship. The handler bails when already
    // shipping.
    expect(HTML).toMatch(/if \(shipping\) return/);
  });

  it('holds the ship Now line across state pushes until the stage resolves', () => {
    // Every push still reads the ship stage as "ready" (it sits at running), so
    // renderNow must short-circuit to a static sentence while shipping, and the
    // resolution must key off host stage truth — not the button copy.
    expect(HTML).toMatch(/function renderNow\(now(?:, agentSession)?\) \{[\s\S]*?if \(shipping\)/);
    expect(HTML).toMatch(/stageCurrent === 'ship'/);
    expect(HTML).toMatch(/status === 'failed'/);
  });

  it('feeds live ship-progress events into the Inside block, not the Now line', () => {
    // The live per-step state ("pushing", "describing") is not in
    // DashboardState; it rides its own transient message, applied only while a
    // ship is in flight, and is read by renderInside via the shippingView
    // overlay — never rendered as free text on the Now line.
    expect(HTML).toContain("'ship-progress'");
    expect(HTML).toMatch(/shipOps\[e\.repo\]\[e\.step\] = /);
    expect(HTML).toMatch(/renderInside\(shippingView\(state, sel\), sel\)/);
    expect(HTML).not.toContain('renderShipProgress');
    expect(HTML).not.toMatch(/shipLabel/);
  });

  it('shows the follow-up button only once the ticket is done', () => {
    expect(HTML).toContain('id="followUpBtn"');
    expect(HTML).toContain(
      "el('followUpBtn').classList.toggle('hidden', state.stageCurrent !== 'done')",
    );
  });

  it('wires the follow-up button to create-follow-up-ticket', () => {
    // Posts through the generic delegated [data-act] handler (pending on
    // click, non-re-triggerable, settled by action-result) rather than a
    // bespoke fire-and-forget listener.
    expect(HTML).toMatch(/id="followUpBtn"[^>]*data-act="create-follow-up-ticket"/);
    expect(HTML).not.toContain("el('followUpBtn').addEventListener('click'");
  });

  /**
   * Mergeability on the PR panel. The bug: ship probed once, said "clean", and
   * nothing ever re-asked — a PR that stopped being mergeable an hour later read
   * as fine until a human hit the merge button.
   */
  it('renders each PR’s merge verdict from the host-rendered headline', () => {
    // The wording is `buildMergeCheckPanelRows`', host-side. A verdict phrased in
    // the webview would be a fourth voice describing the same three-valued fact.
    expect(HTML).toMatch(/renderPrs\(state\.prs,\s*state\.mergeChecks/);
    expect(HTML).toContain('esc(m.headline)');
    // The old single-line summary is gone, not merely unused.
    expect(HTML).not.toContain('m.summary');
  });

  /**
   * `mgwrap`'s `mg-${state}` class is the SOLE driver of the dot colour and the
   * red conflicted text (`.mg-conflicted .mgdot` / `.mg-conflicted .mgtext`
   * above). Nothing else in this suite pinned it before, so a future edit that
   * dropped the class, moved it back onto `.mg`, or emitted `<details>` outside
   * `.mgwrap` would render a colourless dot for a real conflict and this suite
   * would stay green.
   */
  it('pins the state class to the wrapper, not just anywhere in the row', () => {
    expect(HTML).toContain('class="mgwrap mg-${esc(m.state)}"');
  });

  it('opens the conflict list only when the host supplied a label for it', () => {
    // '' means "there is nothing to open" — it must render no disclosure at all,
    // not an empty one.
    expect(HTML).toContain('m.detailsLabel');
    expect(HTML).toContain('<details class="mgd"');
  });

  it('escapes the paths and git’s prose, which both come from outside karst', () => {
    expect(HTML).toContain('esc(m.reason)');
    expect(HTML).toContain('esc(f)');
    expect(HTML).not.toContain('${m.reason}');
    expect(HTML).not.toContain('${m.headline}');
  });

  it('hangs the absolute stamp off the headline as its tooltip', () => {
    // The relative age drifts between state pushes; this is the part that stays
    // true when it has. Pinned to the exact element and attribute — asserting
    // only that `m.checkedTitle` appears somewhere would still pass if the
    // tooltip moved onto the wrong node.
    expect(HTML).toContain('<span class="mgtext"${title}>');
    expect(HTML).toContain('title="checked ${esc(m.checkedTitle)}"');
  });

  it('keeps an open merge disclosure open across a re-render, like the stage selection', () => {
    // render() replaces #prs wholesale on every `state` push AND every
    // ship-progress tick ("pushState fires on every driver progress tick",
    // above) — a user reading a long conflict list mid-ship must not have it
    // snap shut under them. So which disclosures are open is local view state,
    // exactly like `selectedStage`: never inside DashboardState, never
    // round-tripped through the host, toggled only by a delegated listener.
    expect(HTML).toMatch(/let openMergeRepos = new Set\(\)/);
    expect(HTML).toContain('openMergeRepos.has(m.repo)');
    expect(HTML).toMatch(/addEventListener\('toggle'/);
    // render() itself must never reset the set — only the toggle listener may.
    expect((HTML.match(/openMergeRepos\s*=\s*new Set\(\)/g) || []).length).toBe(1);
  });

  it('offers Resolve conflicts only on a repo the host called conflicted', () => {
    // Not disabled-when-clean: a button that can never apply is a dead
    // affordance. It exists only for the conflicted row, and carries the repo —
    // never a path, which would let the webview name a directory to open a
    // session in.
    expect(HTML).toMatch(/m\.state === 'conflicted'/);
    expect(HTML).toContain('data-act="resolve-conflicts"');
    expect(HTML).toContain('data-repo=');
    expect(HTML).not.toMatch(/data-act="resolve-conflicts"[^>]*data-path=/);
  });

  it('sends the repo along with the click, so the host can resolve the worktree', () => {
    // Goes through the generic pending path (unlike merge-pr, resolve-conflicts
    // is not one of the three long-running actions that settle from a state
    // push), so it carries a requestId same as every other generic control.
    expect(HTML).toMatch(/post\(\{ type: act, repo: btn\.dataset\.repo, requestId \}\)/);
  });

  /**
   * The PR panel's refresh icon. The complaint: PR status and mergeability only
   * move on a 60s sweep behind a 5-minute freshness floor, so after pushing a fix
   * a user watches a stale panel for minutes with no way to ask again.
   */
  it('offers a refresh control on the Pull requests panel header', () => {
    expect(HTML).toContain('id="prRefresh"');
    expect(HTML).toContain('data-act="refresh-prs"');
    // An icon, per the request — and a titled, labelled one, because an icon
    // with no accessible name is a button a screen reader cannot announce.
    expect(HTML).toMatch(/id="prRefresh"[^>]*aria-label=/);
  });

  it('carries no target on the refresh click — the host owns which ticket it is', () => {
    // The delegated handler picks its payload from the button's dataset, so
    // carrying none of `data-id`/`data-path`/`data-url`/`data-repo` is what makes
    // the post `{ type: 'refresh-prs' }` and nothing else.
    const btn = /<button id="prRefresh"[\s\S]*?>/.exec(HTML)?.[0] ?? '';
    expect(btn).toContain('data-act="refresh-prs"');
    expect(btn).not.toMatch(/data-(id|path|url|repo)=/);
  });

  /**
   * A refresh runs `gh` and a `git fetch` per repo: seconds, not milliseconds.
   * Without a pending state the click is silent and gets pressed again, queueing
   * sweeps behind a slow remote.
   */
  it('shows the refresh as busy until the next state push clears it', () => {
    expect(HTML).toMatch(/prRefreshId = karstRequestId\(\)/);
    expect(HTML).toMatch(/karstSettle\(prRefreshId, true\)/);
    expect(HTML).toMatch(/prRefreshId = null/);
  });

  it('resolves the ship to an explicit success flash', () => {
    // On completion the indicator settles to a clear success beat, distinct from
    // the idle and processing states.
    expect(HTML).toMatch(/shipDone = 'success'/);
    expect(HTML).toContain('✓ Shipped');
  });
  it('renders the PR path through the host’s display form, never the raw path', () => {
    // The path-display preference (relative/absolute) is resolved host-side into
    // repoDisplay. Rendering `p.repo` here would print an absolute path in a
    // workspace set to relative — the bug this replaces.
    expect(HTML).toContain('p.repoDisplay || p.repo');
  });

  it('renders PR metadata from host-rendered strings only', () => {
    // Each part is '' when the fact is absent, so the webview can place them
    // without formatting a date or counting a thread — no Date() in this file.
    for (const field of ['p.branches', 'p.opened', 'p.merged', 'p.commentsLabel']) {
      expect(HTML, `missing PR metadata field: ${field}`).toContain(field);
    }
    // A comment stamp is likewise pre-formatted (`c.when`), never parsed here.
    expect(HTML).toContain('c.when');
  });

  it('offers merge from the host’s verdict, and disables it with the host’s reason', () => {
    expect(HTML).toContain('data-act="merge-pr"');
    expect(HTML).toContain('p.canMerge');
    expect(HTML).toContain('p.mergeBlockedReason');
    // A merged PR gets no control at all — there is nothing left to do to it.
    expect(HTML).toContain("p.status === 'merged'");
  });

  it('guards the merge click against a double fire and clears it on the next state', () => {
    // Merging is irreversible: a second click while the host's confirmation is up
    // must not post a second request, and the pending flag must not be able to
    // stick (the host pushes state on success, failure, AND cancel).
    const pendingAt = HTML.indexOf('mergeRequests = { ...mergeRequests');
    expect(pendingAt).toBeGreaterThan(-1);
    expect(HTML).toContain('if (!repo || mergeRequests[repo]) return;');
    // Cleared unconditionally on every state push — resolveMergeOutcome() is
    // called before this and settles each outstanding request first.
    expect(HTML).toContain('mergeRequests = {};');
    expect(HTML).toMatch(/function resolveMergeOutcome/);
  });

  it('settles a merge request from the fresh PR list, never as a false failure', () => {
    // The only outcome the webview can verify over this channel is "merged".
    // Anything else settles unknown (null), never false — a user who simply
    // cancelled the host's confirmation dialog must not be told the merge
    // failed (UI-R14: unknown is a different claim from failed).
    const fn = HTML.match(/function resolveMergeOutcome[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(fn).toMatch(/merged \? true : null/);
    expect(fn).not.toMatch(/karstSettle\([^)]*,\s*false/);
  });

  it('carries no requestId on the merge-pr wire payload — it settles from state', () => {
    // UI-R37: merge-pr keeps posting only {type:'merge-pr', repo}. Attaching
    // the generic requestId would make extension.ts's immediate (unawaited)
    // ack settle the button long before the real merge finishes.
    expect(HTML).toMatch(/post\(\{ type: act, repo \}\);/);
  });

  it('never lets the webview choose the merge strategy', () => {
    // The method is the host's question to the user (a modal), so no strategy flag
    // may appear in the posted message.
    expect(HTML).not.toContain('--squash');
    expect(HTML).not.toMatch(/method:\s*'(squash|merge|rebase)'/);
  });

  // ── Task 3.6 remediation guards (docs/ui/UI-RULES.md) ──────────────────────

  /**
   * UI-R04: no raw hex/rgba/px/rem left in <style>. This is not a claim that
   * NOTHING in the sheet is a literal — a handful of one-off component
   * dimensions (a scroll cap, a column's minimum width, an @container/@media
   * breakpoint) have no scale match and are exempt by the same reasoning
   * `diffs/webview.html` already established for its own 440px breakpoint;
   * every one of them carries an inline comment explaining why. What must be
   * literally zero is hex and rgba() — those have no legitimate exception.
   */
  it('carries no hex or rgba() color literal in <style>', () => {
    const style = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>') + '</style>'.length);
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(style).not.toMatch(/rgba?\(/);
  });

  it('is a CLOSED, allowlisted set of raw px values left in <style>', () => {
    // Everything else in the sheet is a --k-* token or a calc() of tokens.
    // These ten are the deliberate UI-R04 exceptions: geometry with no scale
    // match (a scroll cap, a column minimum, a rail offset), an
    // @container/@media breakpoint (which cannot read a custom property at
    // all), and two letter-spacing values (tracking is not in UI-R04's
    // enumerated list of raw-value properties). Every one of them carries an
    // explanatory comment in the file; this test pins the set so a NEW raw px
    // cannot slip in silently, and shrinking the set (by adding a token) is
    // always welcome.
    // `560px` left with the old rail: the track degrades in three measured steps
    // instead of holding a floor, so there is no minimum width to declare. `46px`
    // replaces it — the lane's own height, the one piece of the track's geometry
    // the space scale has no step for.
    // The four `1px` are ONE value in one place: the `@supports` probe that
    // guards the track's chevron focus ring (`calc(1px * hypot(1px,1px) / 1px)`).
    // A feature query cannot be written in tokens — a `var()` inside the
    // condition makes it parse as valid on every browser, which is exactly the
    // question being asked — so the probe is literal by construction. It is a
    // type test, not geometry: nothing is drawn at 1px because of it.
    const ALLOWED = ['46px', '72px', '640px', '82px', '74px', '4px', '180px', '288px', '6px', '400px',
      '1px', '1px', '1px', '1px'];
    const style = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>') + '</style>'.length);
    const withoutComments = style.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = [...withoutComments.matchAll(/[0-9]+(\.[0-9]+)?px/g)].map((m) => m[0]);
    const remaining = [...found];
    for (const allowed of ALLOWED) {
      const at = remaining.indexOf(allowed);
      if (at !== -1) remaining.splice(at, 1);
    }
    expect(remaining, `unexpected raw px value(s) in <style>: ${remaining.join(', ')}`).toEqual([]);
  });

  it('carries no bare numeric border-radius — every radius is a token or the 0/50% exemptions', () => {
    const style = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>') + '</style>'.length);
    const radii = [...style.matchAll(/border-radius:\s*([^;{}]+)[;}]/g)].map((m) => m[1]!.trim());
    for (const value of radii) {
      // Every token/calc() reference is stripped first; what is left must be
      // only whitespace, arithmetic operators, parens, digits that are
      // exactly "0", or "50%" — never a bare Npx radius.
      const stripped = value
        .replace(/calc\(/g, '')
        .replace(/var\(--[\w-]+\)/g, '')
        .replace(/[+\-*/()]/g, ' ')
        .replace(/\b0\b/g, '')
        .replace(/50%/g, '')
        .trim();
      expect(stripped, `unexpected content in border-radius: "${value}"`).toBe('');
    }
  });

  /**
   * The three ad-hoc pending booleans this task replaces: `shipping`,
   * `mergePending`, `prRefreshing`. `shipping` itself survives (it drives the
   * ship-progress overlay content, which the task explicitly keeps) but is now
   * PAIRED with `shipRequestId` for the runtime lifecycle; the other two are
   * gone by name, replaced by requestId-keyed state that reports a real
   * terminal outcome instead of clearing identically on every state push.
   */
  it('replaces the three ad-hoc pending booleans with the runtime lifecycle', () => {
    expect(HTML).not.toMatch(/\bmergePending\b/);
    expect(HTML).not.toMatch(/\bprRefreshing\b/);
    expect(HTML).toMatch(/let mergeRequests = \{\}/);
    expect(HTML).toMatch(/let prRefreshId = null/);
    expect(HTML).toMatch(/let shipRequestId = null/);
  });

  it('gives merge the danger variant, ship and refresh the runtime pending lifecycle', () => {
    expect(HTML).toMatch(/k-btn--danger k-btn--sm mgbtn" data-act="merge-pr"/);
    expect(HTML).toMatch(/shipRequestId = karstRequestId\(\)/);
    expect(HTML).toMatch(/karstBeginPending\(btn, shipRequestId\)/);
    expect(HTML).toMatch(/prRefreshId = karstRequestId\(\)/);
    expect(HTML).toMatch(/karstBeginPending\(btn, prRefreshId\)/);
  });

  it('handles action-result in the message listener, settling through karstSettle', () => {
    expect(HTML).toMatch(/msg\.type === 'action-result'/);
    expect(HTML).toMatch(/karstSettle\(msg\.requestId, msg\.ok, msg\.message\)/);
  });

  it('routes every OTHER mutating/handoff control through the pending runtime with a requestId', () => {
    // edit-ticket, create-follow-up-ticket, open-worktree-terminal,
    // open-worktree-folder, resolve-conflicts, resume-ticket, stop-server,
    // restart-server, spin-servers (row + panel), open-server, open-pr,
    // open-ticket-link, open-stage-log, switch-agent — all fall through the
    // generic branch of the delegated click handler, which begins pending and
    // attaches a requestId before posting.
    const generic = HTML.slice(
      HTML.indexOf('// Every other posting control settles'),
      HTML.indexOf('window.addEventListener'),
    );
    expect(generic).toMatch(/karstIsPending\(btn\)/);
    expect(generic).toMatch(/karstBeginPending\(btn, requestId\)/);
    expect(generic).toMatch(/requestId \}\)/);
  });

  /**
   * Every `.k-iconbtn`/icon-only control in this file: the rail/fix nodes
   * (glyph-only), the servers panel's `iact()`-built row actions, the panel
   * header refresh/diff icons, and the copy-branch icon all carry a matching
   * aria-label + title pair (UI-R19–R21, R24).
   */
  it('gives every icon-only control a matching aria-label and title', () => {
    const iconOnlyBlocks = [
      /aria-label="\$\{esc\(aria\)\}" title="\$\{esc\(aria\)\}"/, // track segment select
      /aria-label="\$\{esc\(label\)\}" title="\$\{esc\(label\)\}"/, // the retry meter
      /aria-label="\$\{esc\(disabledWhy \|\| label\)\}" title="\$\{esc\(disabledWhy \|\| label\)\}"/, // iact()
      /aria-label="Copy branch name" title="Copy branch name"/, // copy-worktree-branch
      /aria-label="Show ticket changes"[\s\S]{0,80}title="Show ticket changes"/, // wtChanges
      /aria-label="Re-check pull request status and mergeability now" title="Re-check pull request status and mergeability now"/, // prRefresh (idle)
    ];
    for (const re of iconOnlyBlocks) {
      expect(HTML, `missing matching aria-label/title for ${re}`).toMatch(re);
    }
    // The dynamic prRefresh busy-state pair — set together, from one string.
    expect(HTML).toMatch(/refresh\.title = refreshName;\s*\n\s*refresh\.setAttribute\('aria-label', refreshName\)/);
  });

  it('titles every previously-untitled control named in the remediation brief', () => {
    for (const title of [
      'Return the strip to the stage the ticket is actually on', // .ghost[data-back]
      "Open this stage's log file in an editor", // open-stage-log
      "Switch this ticket\\'s live agent session", // .switch-agent (JS string literal, escaped apostrophe)
      'Open a terminal in this worktree', // open-worktree-terminal
      'Reveal this worktree in the file explorer', // open-worktree-folder
      "Hand this repo's conflict to an agent session", // resolve-conflicts
      'Open this pull request', // open-pr
    ]) {
      expect(HTML, `missing title: ${title}`).toContain(title);
    }
  });

  it('keeps every STATIC title within the 80-character bound (UI-R20)', () => {
    // Excludes titles built from an interpolated template literal (contain
    // `${`) — their rendered length depends on runtime data (a PR number, a
    // base ref name), so a static character count on the source text checks
    // the wrong thing. Every literal, non-interpolated title in the file is
    // checked here.
    const titles = [...HTML.matchAll(/title="([^"][^"]*)"/g)]
      .map((m) => m[1]!)
      .filter((t) => !t.includes('${'));
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      expect(t.length, `title too long (${t.length} chars): "${t}"`).toBeLessThanOrEqual(80);
    }
  });

  it('marks the optimistic copy confirmation as such, and only for the copy actions (UI-R15)', () => {
    expect(HTML).toMatch(/Optimistic \(UI-R15\)/);
    expect(HTML).toMatch(/Optimistic feedback for the copy button \(UI-R15\)/);
    // Never invoked from ship/merge/refresh — the three mutations this task
    // wires to real terminal outcomes.
    const shipBranch = HTML.slice(HTML.indexOf("if (act === 'ship-ticket')"), HTML.indexOf("if (act === 'merge-pr')"));
    const mergeBranch = HTML.slice(HTML.indexOf("if (act === 'merge-pr')"), HTML.indexOf("if (act === 'refresh-prs')"));
    expect(shipBranch).not.toContain('flashCopied');
    expect(mergeBranch).not.toContain('flashCopied');
  });

  it('gives every rounded pill in the file the shared .k-chip primitive (UI-R08)', () => {
    // keypill and the PR status pill build on one shared shape instead of
    // divergent bespoke radii. The fixtoggle and the approach chips left with the
    // branch band: the track carries the fix loop inside the gate it retries and
    // the approach inside impl's own segment, so neither is a pill any more.
    expect(HTML).toMatch(/class="k-chip keypill/);
    expect(HTML).toMatch(/class="k-chip pst pst-/);
    expect(HTML).not.toMatch(/class="k-chip fixtoggle/);
  });

  it('resolves the three purples (selection mark, merged badge, merged timestamp) to one token', () => {
    expect(HTML).not.toMatch(/#8957e5|#a371f7|#8a63d2|#c297ff/);
    expect(HTML).toMatch(/\.track \.seg\.sel\{box-shadow:[^}]*var\(--k-series-2\)/);
    expect(HTML).toMatch(/\.pr \.pst-merged\{background:var\(--k-series-2\)/);
    expect(HTML).toMatch(/\.pmeta \.pmerged\{color:var\(--k-series-2\)/);
  });

  it('gives every native <summary> disclosure its own focus-visible ring', () => {
    // <summary> is neither a <button> nor an <a>/<input>, so the primitives'
    // generic :focus-visible rule never reaches it.
    // The approach disclosure left with the branch band — impl's phases are pips
    // inside impl's own segment now, so there is nothing to open.
    expect(HTML).not.toMatch(/\.approach > summary/);
    expect(HTML).toMatch(/\.mgd summary:focus-visible\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/);
    expect(HTML).toMatch(/\.pcms summary:focus-visible\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/);
  });

  it('makes the inert local key pill visibly non-interactive, never a real control', () => {
    expect(HTML).toMatch(/class="k-chip keypill local"/);
    expect(HTML).toMatch(/\.dhead \.keypill\.local\{border-style:dashed;color:var\(--k-text-dim\);\s*\n\s*background:transparent;cursor:default\}/);
  });

  it('renders a blocked banner from state.currentStage.blocked, hidden by default', () => {
    expect(HTML).toContain('<div class="fault blocked hidden" id="blocked">');
    expect(HTML).toMatch(/function renderBlocked\(state\)/);
    expect(HTML).toMatch(/cell && cell\.blocked/);
    expect(HTML).toMatch(/box\.classList\.toggle\('hidden', !blocked\)/);
    expect(HTML).toContain('renderBlocked(state);');
  });

  it('resumes a blocked stage on its own dataset key, never the rail\'s selection one', () => {
    // The rail's stage-selection click handler matches ANY `[data-stage]`
    // ancestor via `closest`, so the Resume button must use a differently
    // named attribute — `data-stagekey` — or clicking it would also silently
    // re-point the Inside panel to whatever stage it names.
    const renderBlockedBody = HTML.slice(
      HTML.indexOf('function renderBlocked(state)'),
      HTML.indexOf('// The fault card scans the FLAT stepper'),
    );
    expect(renderBlockedBody).toMatch(/data-act="stage-resume"/);
    expect(renderBlockedBody).toMatch(/data-stagekey="\$\{esc\(cell\.stageKey\)\}"/);
    expect(renderBlockedBody).not.toMatch(/data-stage="/);
  });

  it('posts stage-resume with the ticket id and the button\'s own stage key', () => {
    const generic = HTML.slice(
      HTML.indexOf('// Every other posting control settles'),
      HTML.indexOf('window.addEventListener'),
    );
    expect(generic).toMatch(
      /btn\.dataset\.stagekey[\s\S]{0,200}post\(\{ type: act, ticketId: lastState\.ticketId, stageKey: btn\.dataset\.stagekey, requestId \}\)/,
    );
  });

  it('leaves stop-driver unreachable from the rendered UI (tracked, not silently wired)', () => {
    // No control in this file posts stop-driver — confirmed here so a future
    // edit does not accidentally wire it up without updating the host/tests
    // that assume it stays unreachable. See the remediation report for why
    // this is left as-is rather than invented a control for it.
    expect(HTML).not.toMatch(/data-act="stop-driver"/);
  });

  it('renders a glyph for every OpStatus the host can produce', () => {
    const map = /const OP_GLYPH = \{([^}]*)\}/.exec(HTML)?.[1] ?? '';
    for (const status of ['pass', 'fail', 'run', 'wait', 'pending', 'note', 'skip']) {
      expect(map, `OP_GLYPH is missing ${status}`).toContain(`${status}:`);
    }
  });

  it('renders a Gates panel with a per-gate toggle button', () => {
    expect(HTML).toContain('id="gates"');
    expect(HTML).toContain('data-act="set-disabled-gates"');
  });

  it('handles the gate-options host message', () => {
    expect(HTML).toContain("msg.type === 'gate-options'");
  });

  it('gives every gate toggle a matching aria-label and title (UI-R19–R21)', () => {
    const row = /function gateRow\([\s\S]*?\n  \}/.exec(HTML)?.[0] ?? '';
    expect(row).toContain('aria-label="${esc(label)}"');
    expect(row).toContain('title="${esc(label)}"');
  });

  it('uses a real button for the gate toggle, never a clickable div (UI-R09)', () => {
    const row = /function gateRow\([\s\S]*?\n  \}/.exec(HTML)?.[0] ?? '';
    expect(row).toContain('<button type="button"');
    expect(row).not.toMatch(/<div[^>]*data-act=/);
  });

  it('reports pending on click and cannot be re-triggered while pending (UI-R11–R14)', () => {
    const click = HTML.slice(
      HTML.indexOf("if (act === 'set-disabled-gates')"),
      HTML.indexOf("// Every other posting control settles"),
    );
    expect(click).toContain('karstIsPending(btn)');
    expect(click).toContain('karstBeginPending(btn, requestId)');
    expect(click).toContain("type: act");
  });

});
