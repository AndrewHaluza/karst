import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectPalette } from '../../model/palette.js';
import { injectProviderIdentity } from '../../model/providerIdentity.js';
import { injectAgentIdentity } from '../../model/agentIdentity.js';
import { implementationPrototypeFixture, renderFixtures, renderStateFor } from './renderFixtures.js';
import type { RenderRepoCount } from './renderFixtures.js';
import type { DashboardState } from './state.js';
import { buildDashboardState } from './state.js';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { EVIDENCE_KINDS } from '../../model/inside/types.js';
import type { InsideProcessView, InsideStageKey, InsideStageView } from '../../model/inside/types.js';
import type { ArtifactSummary } from '../../model/artifacts.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

/** One brace-balanced `@container (max-width: <w>)` block from the source. */
function containerBlock(w: string): string {
  const at = HTML.indexOf(`@container (max-width: ${w}){`);
  expect(at, `missing @container (max-width: ${w})`).toBeGreaterThan(-1);
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
  return HTML.slice(at, end);
}

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
  it('renders the header ship action from state.ship, never a Now sentence', () => {
    expect(HTML).toMatch(/function renderShip\(state\)[\s\S]*?state\.ship/);
    expect(HTML).not.toContain('id="now"');
    expect(HTML).not.toMatch(/function renderNow\(/);
  });

  it('renders ticket changes as one accessible diff icon button', () => {
    expect(HTML.match(/data-act="show-changes"/g)).toHaveLength(1);
    expect(HTML).toMatch(/id="wtChanges"[^>]*aria-label="Show ticket changes"/);
    expect(HTML).toMatch(/id="wtChanges"[^>]*title="Show ticket changes"/);
    // The glyph is the Tabler catalog's `git-compare` on the shared treatment
    // (docs/ui/ICONS.md §4) — never a hand-rolled sprite reference.
    expect(HTML).toMatch(/id="wtChanges"[^>]*>[\s\S]{0,200}<svg class="k-icon"[^>]*viewBox="0 0 24 24"[^>]*><path d="M4 6a2 2/);
    expect(HTML).not.toContain('href="#i-');
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

  it('offers Launch Dev only on worktrees the host marked launchable', () => {
    expect(HTML).toContain('data-act="launch-worktree-extension"');
    expect(HTML).toContain('data-path="${esc(w.path)}"');
    // Rendered conditionally on the host-probed flag — a non-karst worktree
    // must not show a button that can only fail.
    expect(HTML).toContain('w.launchable');
    expect(HTML).toMatch(/Build this worktree and open its extension in a new dev window/);
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
    // markers are load-bearing at runtime (renderTicketIdentity calls
    // providerIconHtml, which only exists because the JS marker was
    // substituted). The agent
    // markers are equally load-bearing since B1: identityChipHtml calls
    // agentIconHtml, so a marker-less dashboard would throw ReferenceError on
    // the first process row that carries an execution identity.
    for (const marker of [
      '<!--KARST_CSP-->',
      '/*KARST_PROVIDER_CSS*/',
      '/*KARST_PROVIDER_JS*/',
      '/*KARST_AGENT_CSS*/',
      '/*KARST_AGENT_JS*/',
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
    expect(track).not.toMatch(/=== 'ship'|'pending'/);
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
    expect(HTML).toMatch(/selectedStage\s*\|\|\s*state\.presentedStage\s*\|\|\s*state\.stageCurrent/);
  });

  it('emits no action the host does not validate', () => {
    const declared = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'messages.ts'),
      'utf8',
    );
    // Literal names only. Ship rides the fixed confirmShip button markup; the
    // other data-act values are static strings declared below.
    const emitted = [...HTML.matchAll(/data-act="([^"$]+)"/g)].map((m) => m[1]!);
    expect(emitted.length).toBeGreaterThan(0);
    for (const act of new Set(emitted)) {
      expect(declared, `unvalidated action: ${act}`).toContain(`'${act}'`);
    }
    // The menu's edit entry and the identity's copy-key ride data-act; the
    // agent switch is a dedicated popover button, never a data-act value.
    expect(emitted).toContain('edit-ticket');
    expect(emitted).toContain('copy-ticket-key');
    expect(emitted).not.toContain('switch-agent');
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
    // The dashboard owns `.ph*` (panel headers) and the inside ledger owns the
    // `.p*` row classes (the activity strip `.act` was retired with the
    // legacy inside block, Task 3); an unscoped `.seg`/`.fixm` would silently
    // restyle them.
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

  it('offers the terminal binding as a menu switch reflecting the host push', () => {
    expect(HTML).toContain('id="linkViews"');
    expect(HTML).toMatch(/bindEnabled[\s\S]*linkViews/);
    expect(HTML).not.toMatch(/id="bindBtn"/);
    expect(HTML).toMatch(/'bind'|"bind"/);
    expect(HTML).toMatch(/bindEnabled\s*=\s*[^;]*\bmsg\b/);
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
   * registered. Live feedback now rides the generic inside-progress protocol
   * (Finding 12): the host streams `active`/`completed`/`cleared` ship events
   * that overlay the ledger, and the click's own pending lifecycle is keyed to
   * `shipRequestId` — the same runtime every other control uses. The old
   * `shipping` flag and its flat `ship-progress` overlay are gone.
   */
  it('registers the confirm-ship click before the host round trip', () => {
    expect(HTML).toMatch(/act === 'ship-ticket'/);
    expect(HTML).toMatch(/shipRequestId = karstRequestId\(\)/);
    expect(HTML).toMatch(/karstBeginPending\(btn, shipRequestId\)/);
  });

  it('guards against a double confirm-ship submit while one is in flight', () => {
    expect(HTML).toMatch(/if \(shipRequestId\) return/);
  });

  it('holds the ship header slot across state pushes until the stage resolves', () => {
    expect(HTML).toMatch(/function renderShip\(state\)[\s\S]*?(?:shipRequestId|\bslot\b)/);
    expect(HTML).toMatch(/stageCurrent === 'ship'/);   // resolveShipping still keys off host truth
    expect(HTML).toMatch(/status === 'failed'/);
    expect(HTML).not.toMatch(/if \(shipping\)/);
    expect(HTML).not.toContain('id="now"');
  });

  it('feeds live Ship events through the generic inside-progress protocol, never a flat overlay', () => {
    // Finding 12: the per-repo/per-step `ship-progress` stream is gone; ship's
    // lifecycle rides the same `inside-progress` union as gates and Fix, and
    // renderInside always consumes the authoritative ledger + generic overlays.
    // (The word "shipping" now lives in the header ship button's label.)
    expect(HTML).toContain("'inside-progress'");
    expect(HTML).not.toContain("'ship-progress'");
    expect(HTML).not.toMatch(/\blet shipping\b|shipping\s*=\s*(?:true|false)/);
    expect(HTML).not.toMatch(/shipOps|seedShipOps/);
    expect(HTML).not.toMatch(/renderInside\(shippingView/);
    expect(HTML).not.toMatch(/renderInsideFlat/);
  });

  it('shows the follow-up menu item only once the ticket is done', () => {
    expect(HTML).toContain('id="followUpItem"');
    expect(HTML).toMatch(/el\('followUpItem'\)\.classList\.toggle\('hidden', state\.stageCurrent !== 'done'\)/);
    expect(HTML).not.toMatch(/id="followUpBtn"/);
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
    // inside-progress tick ("pushState fires on every driver progress tick",
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

  it('resolves the ship to an explicit success toast', () => {
    // On completion the indicator settles to a clear success beat, distinct from
    // the idle and processing states — the header toast now carries it.
    expect(HTML).toMatch(/shipDone = 'success'/);
    expect(HTML).toContain('Shipped ✓');
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
    // The three `300px`/`360px`/`430px` are the B7 inside-block breakpoints —
    // handoff §10's widths. An @container condition cannot read a custom
    // property, so they are literal by construction, the same exemption class
    // as the servers panel's 400px rule below.
    // `110px`/`160px` (and the ≤430 `104px`) are the session timeline's phase-name
    // column — a column minimum/maximum, the same exemption class as `82px`: the
    // detail column starts on ONE x at every width, which no space step expresses.
    // `200px` is the artifact shelf's card grid minimum — a single-column floor
    // that reads "wide enough" without a space step for the exact width. `720px`
    // caps the in-webview artifact detail surface, the same layout-width class as
    // `640px` but narrower for the detail-heavy content. `12px` (×4) sizes the
    // origin chip's two icon marks — no space step at the chip's 12px scale.
    // `2px` (×4) sets focus outlines and the artifact-finding left border; `1px`
    // (×9) offsets those focus outlines plus the … menu's divider, the bind
    // switch's focus ring, and the quick-setting help's optical nudge. All ten
    // are the same exemption class as `74px` — a deliberate geometry with no
    // token equivalent.
    const ALLOWED = ['46px', '72px', '640px', '82px', '74px', '4px', '180px', '288px', '6px', '400px',
      '300px', '360px', '430px', '110px', '160px', '104px',
      '1px', '1px', '1px', '1px', '1px', '1px',
      '200px', '720px',
      '2px', '2px', '2px', '2px',
      '1px', '1px', '1px',
      '12px', '12px', '12px', '12px',
      '4px', '4px', '4px', '4px', '4px'];
    // The ported Inside block is the ONE exempt region (see its own header
    // comment): it is the A37 prototype's geometry, scoped under `#inside`,
    // and its pixel values ARE the design. Its colours still go through
    // `--k-*` tokens, which is the part UI-R04 exists to protect; the
    // exemption is delimited by markers so it cannot silently widen.
    const style = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>') + '</style>'.length);
    const protoStart = style.indexOf('/*KARST_INSIDE_PROTO_START*/');
    const protoEnd = style.indexOf('/*KARST_INSIDE_PROTO_END*/');
    expect(protoStart, 'the Inside prototype block lost its start marker').toBeGreaterThan(-1);
    expect(protoEnd, 'the Inside prototype block lost its end marker').toBeGreaterThan(protoStart);
    const outsideProto = style.slice(0, protoStart) + style.slice(protoEnd);
    const withoutComments = outsideProto.replace(/\/\*[\s\S]*?\*\//g, '');
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
   * The three ad-hoc pending booleans this work replaced: `shipping`,
   * `mergePending`, `prRefreshing`. All three are gone — `shipping` with the
   * legacy ship-progress overlay it drove (Finding 12) — replaced by
   * requestId-keyed state that reports a real terminal outcome instead of
   * clearing identically on every state push.
   */
  it('replaces the three ad-hoc pending booleans with the runtime lifecycle', () => {
    expect(HTML).not.toMatch(/\bmergePending\b/);
    expect(HTML).not.toMatch(/\bprRefreshing\b/);
    expect(HTML).not.toMatch(/\blet shipping\b|shipping\s*=\s*(?:true|false)/);
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
      "Open this stage's log file", // open-stage-log (Inside block)
      'Open a terminal in this worktree', // open-worktree-terminal
      'Reveal this worktree in the file explorer', // open-worktree-folder
      'Build this worktree and open its extension in a new dev window', // launch-worktree-extension
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
    // The PR status pill builds on the shared shape instead of a bespoke
    // radius. The keypill left the header with Task 5 (the key is a plain
    // monospace button now). The fixtoggle and the approach chips left with the
    // branch band: the track carries the fix loop inside the gate it retries and
    // the approach inside impl's own segment, so neither is a pill any more.
    expect(HTML).toMatch(/class="k-chip pst pst-/);
    expect(HTML).not.toMatch(/class="k-chip fixtoggle/);
    expect(HTML).not.toMatch(/class="k-chip keypill/);
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

  it('renders ticket identity as provider mark + copy-key button + separate board link', () => {
    expect(HTML).toMatch(/id="keyBtn"[^>]*data-act="copy-ticket-key"/);
    expect(HTML).toMatch(/id="keyBtn"[^>]*data-copy/);
    expect(HTML).toMatch(/id="boardLink"[^>]*data-act="open-ticket-link"/);
    expect(HTML).toMatch(/id="boardLink"[^>]*data-url="\$\{esc\(state\.ticketUrl\)\}"/);
    expect(HTML).toMatch(/id="providerMark"/);
    // The key itself must NOT be the board link any more.
    expect(HTML).not.toMatch(/class="k-chip keypill/);
  });

  it('renders the active agent through the Karst identity pattern with runtime status', () => {
    expect(HTML).toMatch(/agentBadgeHtml\(state\.agentSession\.provider\)/);
    expect(HTML).toMatch(/id="agentModel"[\s\S]*?state\.agentSession\.modelLabel/);
    expect(HTML).toMatch(/id="agentLiveText"[\s\S]*?agentState/);
    expect(HTML).toContain('id="agentButton"');
  });

  it('stages the agent switch in a popover that does nothing until Switch agent is clicked', () => {
    expect(HTML).toContain('id="agentPopover"');
    expect(HTML).toContain('id="coreSelect"');
    expect(HTML).toContain('id="modelSelect"');
    expect(HTML).toContain('id="switchBtn"');
    expect(HTML).toMatch(/Closing this menu takes no action/);
    expect(HTML).toMatch(/draftCore !== s\.provider \|\| /); // changed-draft gate
    expect(HTML).toMatch(/post\(\{ type: 'switch-agent', provider: draftCore, model: draftModel \|\| null \}\)/);
    expect(HTML).not.toMatch(/data-act="switch-agent"/);      // no longer a Now-line button
  });

  it('titles the header identity and agent controls (UI-R20/R21)', () => {
    for (const title of [
      'Switch the live agent session', // #agentButton
      'Open ticket in provider', // #boardLink
      'Ticket controls', // #moreBtn
      'Copy ticket key', // #keyBtn
    ]) {
      expect(HTML, `missing header title: ${title}`).toContain(title);
    }
  });

  it('sizes every header and controls-menu icon explicitly (PR #166 balloon)', () => {
    // The shared `.k-icon` rule applies ONLY the Tabler stroke treatment — no
    // size. An unsized inline svg in the agent button's unclipped flex row
    // rendered at the browser's default replaced-object size (~275px),
    // inflating the whole header to match. Every other icon in this file
    // carries its size (the panel headers' width/height attributes, `.ib svg`);
    // the header's five (board link, agent chevron, … dots, Edit, follow-up)
    // did not, so one token-derived rule sizes all of them (UI-R04).
    expect(HTML).toMatch(/\.dhead \.k-icon\{[^}]*var\(--k-space-7\)/);
    // And the header svgs must not smuggle their own raw size either — one
    // rule, one 16px step, so a future header icon is sized or visibly broken.
    const header = HYDRATED.slice(
      HYDRATED.indexOf('<div class="dhead">'),
      HYDRATED.indexOf('<div class="stepper">'),
    );
    const icons = [...header.matchAll(/<svg class="k-icon"[^>]*>/g)];
    expect(icons.length, 'the header carries the unsized icon set').toBeGreaterThan(0);
    for (const m of icons) {
      expect(m[0], m[0]).not.toMatch(/\s(width|height)="\d/);
    }
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
      HTML.indexOf('let toastTimer = 0;'),
    );
    expect(renderBlockedBody).toMatch(/data-act="stage-resume"/);
    expect(renderBlockedBody).toMatch(/data-stagekey="\$\{esc\(cell\.stageKey\)\}"/);
    expect(renderBlockedBody).not.toMatch(/data-stage="/);
  });

  it('renders a waiting-to-merge banner instead of a fault, and offers no Resume for it', () => {
    // A ticket parked at `ship` blocked with `awaiting-merge` is not a fault —
    // it's a normal wait for a PR to land, and (per stageResume.ts) a Resume
    // click there would be refused anyway: only the merge gate observing the
    // actual landing may clear that block, so a Resume button would be a dead
    // affordance for this kind specifically. The RESUMABILITY verdict is the
    // host's `resumable` flag, never a reason-string match in the webview.
    const renderBlockedBody = HTML.slice(
      HTML.indexOf('function renderBlocked(state)'),
      HTML.indexOf('let toastTimer = 0;'),
    );
    expect(renderBlockedBody).toMatch(/blocked\.resumable === false/);
    // The non-resumable branch is the code between its own `if` and the next
    // statement that builds the generic title — it must return before ever
    // reaching the Resume-button markup.
    const nonResumableBranch = renderBlockedBody.slice(
      renderBlockedBody.indexOf('if (blocked.resumable === false)'),
      renderBlockedBody.indexOf('const title = `${STAGE_TITLE'),
    );
    expect(nonResumableBranch).toContain('Waiting to merge');
    expect(nonResumableBranch).not.toMatch(/data-act="stage-resume"/);
    // A wait is not a fault (UI-R28): the awaiting-merge branch swaps the red
    // failure styling for the `waiting` treatment — the amber attention edge
    // plus the pause glyph, so hue is not the only carrier — and the
    // `.fault.waiting` CSS rule uses `--k-attention`, never `--k-failed`.
    expect(nonResumableBranch).toContain("box.classList.add('waiting')");
    expect(nonResumableBranch).toContain("karstIcon('player-pause'");
    expect(HTML).toMatch(/\.fault\.waiting\{[^}]*var\(--k-attention\)[^}]*\}/);
    expect(HTML).toMatch(/\.fault\.waiting\{[^}]*background:color-mix[^}]*\}/);
    expect(HTML).not.toMatch(/\.fault\.waiting\{[^}]*var\(--k-failed\)/);
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

  it('draws a glyph for every OpStatus the host can produce', () => {
    // The ported prototype draws each state on `.glyph` with CSS — a ring
    // plus a check, a cross, a dot, a spinning arc, two bars, a slash — so a
    // status is a SHAPE, not a character that has to survive a font. Every
    // status the host can ship must have a rule, or it renders as a bare ring
    // indistinguishable from another state.
    for (const status of ['pass', 'fail', 'run', 'wait', 'pending', 'note', 'skip']) {
      expect(HTML, `.glyph has no ${status} rule`).toMatch(
        new RegExp(`#inside \\.glyph\\.${status}[,{]`),
      );
    }
  });

  it('keeps the causal connector out of the status vocabulary (B8)', () => {
    // N5: `note` used to BE '↳', the same mark the timeline's causal
    // connector renders for a switch/resume — an informational row and a
    // relationship marker were indistinguishable. With the port they cannot
    // collide by construction: a status is a DRAWN glyph shape and the
    // connector is the switch row's own branch arrow, which appears in
    // exactly one template.
    expect(HTML).toMatch(/class="switch-arrow" aria-hidden="true">↳/);
    expect(HTML).not.toMatch(/const OP_GLYPH/);
    // `note` still draws its own shape, distinct from pending's placement.
    expect(HTML).toMatch(/#inside \.glyph\.pending,#inside \.glyph\.note\{/);
  });

  it('renders the gate toggles inside the … menu, per-gate', () => {
    expect(HTML).toContain('id="menuGates"');
    expect(HTML).toContain('data-act="set-disabled-gates"');
    expect(HTML).toMatch(/renderMenuGates/);
  });

  it('handles the gate-options host message', () => {
    expect(HTML).toContain("msg.type === 'gate-options'");
  });

  it('removes the standalone Gates panel — the toggles live in the … menu', () => {
    expect(HTML).not.toMatch(/class="panel span"[^>]*>\s*<div class="phead">Gates/);
    expect(HTML).not.toContain('id="gateCount"');
    expect(HTML).toContain('id="menuGates"');
    expect(HTML).toMatch(/renderMenuGates/);
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

  // ── inside ledger (the inside redesign) ─────────────────────────────────
  it('renders the inside ledger from state.insideViews, always (Finding 12)', () => {
    // The redesigned block consumes the six-stage view contract: ordered
    // process rows with evidence. There is no flat fallback any more — live
    // Ship events overlay the ledger through the generic inside-progress
    // protocol (live header / completed process row), so the renderer always
    // reads `state.insideViews[sel]`.
    expect(HTML).toMatch(/state\.insideViews/);
    expect(HTML).toMatch(/function processRowHtml/);
    expect(HTML).toMatch(/const cls = `op \$\{esc\(p\.status\)\}/);
    expect(HTML).toMatch(/function renderInside\(state, sel\)[\s\S]*state\.insideViews/);
    expect(HTML).not.toMatch(/function renderInsideFlat/);
    expect(HTML).not.toMatch(/shipping && sel === 'ship'/);
  });

  it('overlays live Ship events onto the authoritative ledger (Finding 12)', () => {
    // Step 2 of the remediation: feed an authoritative Ship InsideStageView,
    // overlay active and completed Ship process events. `active` rides the
    // stage header as the live line, `completed` replaces it with a process
    // row via overlayProcesses — the ledger (state.insideViews) stays the
    // base, and no per-repository step is derived in the webview.
    expect(HTML).toMatch(/const view = \(state\.insideViews \|\| \{\}\)\[sel\]/);
    expect(HTML).toMatch(/const lop = \(live && live\.active\) \|\| view\.live \|\| null;/);
    expect(HTML).toMatch(/const procs = overlayProcesses\(view\)/);
    expect(HTML).toMatch(/function overlayProcesses/);
    expect(HTML).not.toMatch(/renderInsideFlat/);
    expect(HTML).not.toMatch(/flattenShipOps/);
  });

  it('retires the legacy ship derivation wholesale (Finding 12, step 6)', () => {
    expect(HTML).not.toMatch(/SHIP_STEP_ORDER|flattenShipOps|shippingView|renderInsideFlat/);
  });

  it('renders a process row from the snapshot, never deriving a verdict', () => {
    // Status glyph, label, detail, counts, tokens and the action id all come
    // pre-built; the webview only maps the closed status vocabulary to glyphs
    // and the closed action vocabulary to static button copy.
    expect(HTML).toMatch(/class="glyph \$\{esc\(p\.status\)\}"/);
    expect(HTML).toMatch(/INSIDE_ACTION_LABEL\[a\.kind\]/);
    expect(HTML).toMatch(/p\.execution \|\| p\.configuredExecution/);
    expect(HTML).not.toMatch(/p\.status = /);
  });

  it('renders execution identity as one chip, never both claims at once', () => {
    // `execution` (what ran) and `configuredExecution` (what settings said
    // would run) are two different claims; one chip renders whichever exists,
    // and the title says which claim it is.
    // `execution` wins; `configuredExecution` is the fallback; the host's
    // absence copy is the last resort. One branch, in that order — never two
    // identity runs on one row.
    expect(HTML).toMatch(/if \(p\.execution\) return agentIdHtml\(p\.execution\);/);
    expect(HTML).toMatch(/if \(p\.configuredExecution\) return agentIdHtml\(p\.configuredExecution\);/);
    expect(HTML).toMatch(/if \(p\.identityNote\)/);
  });

  it('discloses process evidence with a native details/summary (B3)', () => {
    // UI-R09: the disclosure IS the element — keyboard operability comes from
    // <details>/<summary>, not from a click handler. The open state rides the
    // row's OWN data-proc-id (the composite `${stageKey}:${p.id}` the renderer
    // looks up, Task 0.1), persisted through the native `toggle` listener.
    expect(HTML).toMatch(/<details class="\$\{cls\}" data-proc-id="\$\{esc\(key\)\}"/);
    expect(HTML).toMatch(/<summary>\$\{glyph\}\$\{name\}\$\{detail\}\$\{tail\}<span class="chev"/);
    expect(HTML).toMatch(/openProcesses = next;/);
    expect(HTML).not.toMatch(/data-chev/);
    // The disclosure element itself is the native <details> — no aria-expanded
    // toggle on it (the header's popover buttons legitimately carry
    // aria-expanded; that is the button-controlling-a-dialog pattern, not this
    // disclosure).
    expect(HTML).not.toMatch(/<details[^>]*aria-expanded/);
  });

  it('posts inside actions with only the opaque actionId', () => {
    // The closed inside-action message: type + actionId + requestId and
    // NOTHING else — the webview never ships a path, URL, PR number, repo or
    // stage as authority (messages.ts drops any payload with a companion
    // field).
    expect(HTML).toMatch(/data-action-id="\$\{esc\(a\.actionId\)\}"/);
    expect(HTML).toMatch(/btn\.dataset\.actionId\) \{\n\s*post\(\{ type: act, actionId: btn\.dataset\.actionId, requestId \}\)/);
  });

  it('renders the host-shipped continuation label, falling back to the static one (B9)', () => {
    // handoff §10: a continuation says exactly what it reveals — "Show 4
    // more". The count is host-computed and rides the action; the static
    // map stays the fallback for actions without a count.
    expect(HTML).toMatch(/INSIDE_ACTION_LABEL\[a\.kind\]/);
    expect(HTML).toMatch(/a\.label \|\| INSIDE_ACTION_LABEL\[a\.kind\]/);
  });

  it('renders the identity note chip when the host ships one (B9)', () => {
    // §11: "No historical execution identity recorded" — the reducer ships it
    // when a run recorded no provider; the webview renders the shipped string
    // in the identity chip's place, never inventing an identity. The literal
    // must NOT appear here: that copy is host-side (UI-R31).
    expect(HTML).toContain('p.identityNote');
    expect(HTML).toMatch(/identityNote[^]*esc\(p\.identityNote\)/);
    expect(HTML).not.toContain('No historical execution identity recorded');
  });

  it('renders a live operation in the header, never as a second process row', () => {
    // The inside-progress protocol is a same-tick overlay: `active` rides the
    // stage header, `completed` replaces the snapshot's same-id process row, and
    // the full snapshot that follows retires both. The header is status-aware
    // (F6): only `run` draws the spinner; a `wait` or `fail` draws its own glyph.
    expect(HTML).toMatch(/'inside-progress'/);
    expect(HTML).toMatch(/liveOps\[e\.stage\] = \{ active: e\.live/);
    expect(HTML).toMatch(/liveOps\[e\.stage\] = \{ completed: e\.process \}/);
    expect(HTML).toMatch(/function overlayProcesses/);
    expect(HTML).toMatch(/\(live && live\.active\) \|\| view\.live/);
    expect(HTML).toMatch(/lop \? \(lop\.status \|\| 'run'\)/);
  });

  it('retires a live overlay only when the snapshot contains its process', () => {
    // A snapshot that does not know the process cannot answer about it; a
    // `completed` overlay dies on any presence, an `active` one only once its
    // row reads terminal (an unrelated mid-gate push must not drop the live
    // header while the snapshot still reads `run`).
    expect(HTML).toMatch(/entry\.completed \? entry\.completed\.id : entry\.processId/);
    expect(HTML).toMatch(/row\.status !== 'run'/);
    expect(HTML).toMatch(/delete liveOps\[stage\]/);
  });

  it('does not persist the live overlay across reloads', () => {
    // A restored overlay would claim a process is running that nobody is —
    // persist() saves only the snapshot, the selection and the filter.
    expect(HTML).toMatch(/setState\(\{ state: lastState, sel: selectedStage, srvFilter: srvFilter, artView: artView, artScrolls: artScrolls \}\)/);
    expect(HTML).not.toMatch(/liveOps: /);
  });

  it('gives every closed evidence kind a renderer, dispatched by kind', () => {
    // The ported prototype has ONE body per kind — the gates table, the
    // findings list, the session timeline, the receipt lines, the recovery
    // history, and the generic evidence rows the remaining kinds share. The
    // map is closed and an unknown kind falls back to the generic body, so a
    // newer host can never reach an unhandled branch.
    expect(HTML).toContain('const EVIDENCE_RENDERERS');
    for (const kind of EVIDENCE_KINDS) {
      expect(HTML, `no renderer entry for ${kind}`).toMatch(
        new RegExp(`const EVIDENCE_RENDERERS = \\{[\\s\\S]*?\\n\\s*${kind}: evidence`),
      );
    }
    for (const fn of ['evidenceRowsHtml', 'evidenceGatesHtml', 'evidenceFindingsHtml',
      'evidenceTimelineHtml', 'evidenceRecoveryHtml', 'evidenceReceiptHtml']) {
      expect(HTML, `missing ${fn}`).toContain(`function ${fn}`);
    }
  });

  it('gives each evidence kind the prototype container its CSS hangs off (Task 5)', () => {
    // Each body emits the prototype's own container, so the kind-specific
    // geometry (the gates table's four columns, the findings severity column,
    // the timeline's rail) has exactly one selector to hang off. The gates
    // container's class is DYNAMIC — `no-repo` drops the repo column when no
    // row names one — and both shapes still hang off `.gates`.
    expect(HTML).toMatch(/function evidenceGatesHtml[\s\S]*?class="gates\$\{hasRepo/);
    expect(HTML).toMatch(/function evidenceFindingsHtml[\s\S]*?class="findings"/);
    expect(HTML).toMatch(/function evidenceTimelineHtml[\s\S]*?class="session-segments"/);
    expect(HTML).toMatch(/function evidenceRecoveryHtml[\s\S]*?class="recovery-history"/);
    expect(HTML).toMatch(/function evidenceReceiptHtml[\s\S]*?class="done-line"/);
    expect(HTML).toMatch(/function evidenceRowsHtml[\s\S]*?class="evidence-row"/);
  });

  it('draws the timeline connector from the structural field, never the label', () => {
    // A switch/resume row carries `connector` from the host; the webview maps
    // the CLOSED vocabulary to the branch class + static tooltip and must not
    // guess a switch from parsing the label (phase names are prose).
    const fn = /function timelineRowHtml[\s\S]*?\n  \}/.exec(HTML)?.[0] ?? '';
    expect(fn).toMatch(/r\.connector === 'switch' \|\| r\.connector === 'resume'/);
    expect(fn).toMatch(/class="timeline-row switch-event"/);
    expect(HTML).toMatch(/Provider switched here/);
    expect(HTML).toMatch(/Session resumed here/);
    expect(fn).not.toMatch(/r\.label\s*(?:===|!==|\.includes|\.startsWith|\.indexOf)/);
    expect(HTML).not.toMatch(/r\.label === 'switch'/);
    // The label-based branch class is the failure this test exists to catch.
    expect(HTML).not.toContain('label-switch');
  });

  it('never reads the evidence kind to derive a verdict', () => {
    // Kind is a presentation hint only: the row statuses are host-set, and a
    // renderer that switches on kind to invent a status would break the
    // "webview receives verdicts" invariant. The dispatcher selects a RENDERER
    // by kind; the statuses it renders come from the rows alone.
    expect(HTML).toContain('EVIDENCE_RENDERERS[ev.kind]');
    expect(HTML).toMatch(/EVIDENCE_RENDERERS\[ev\.kind\] \|\| evidenceRowsHtml/);
    expect(HTML).not.toMatch(/evidence\.kind === .*status/);
  });

  it('keeps the ledger rows wrappable at narrow widths (UI-R04/R05)', () => {
    // The process summary is a GRID whose content column is minmax(0,1fr) and
    // every evidence row flex-wraps, so 300px never scrolls the component
    // horizontally: only the glyph column is fixed, and the detail column
    // truncates with an ellipsis instead of pushing the row.
    expect(HTML).toMatch(/#inside \.op summary,#inside \.op-static\{[\s\S]*?minmax\(0,1fr\)/);
    expect(HTML).toMatch(/#inside \.evidence-row\{display:grid[^}]*minmax\(0,1fr\)/);
    // The detail cell is a pure grid item (min-width:0 lets it shrink to its
    // ellipsis), never a fixed or minimum width that could overflow at 300px.
    // The console-bearing gates row wraps its text in the same cell and keeps
    // the ellipsis contract on the text span (869e7n906-fu1).
    expect(HTML).toMatch(/<span class="op-detail-text">\$\{esc\(p\.detail\)\}<\/span>/);
    expect(HTML).toMatch(/#inside \.op-detail\.detail-console \.op-detail-text\{[\s\S]*?min-width:0/);
    const detail = HTML.slice(HTML.indexOf('#inside .op-detail{'), HTML.indexOf('#inside .op-detail{') + 240);
    expect(detail).toContain('min-width:0');
    expect(detail).not.toContain('overflow-x');
  });

  it('makes the inside block its own query container (B7)', () => {
    // The responsive rules are CONTAINER queries on #inside itself, so they
    // follow the panel's real width (the old preview's width frame targeted
    // .stepper, a sibling, and never resized the block it existed to test).
    expect(HTML).toMatch(/#inside\{[^}]*container-type:inline-size/);
  });

  it('covers the handoff breakpoints 300/360/430 with ledger rules (B7)', () => {
    const blockFor = (w: string): string => {
      const at = HTML.indexOf(`@container (max-width: ${w}){`);
      expect(at, `missing @container (max-width: ${w})`).toBeGreaterThan(-1);
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
      return HTML.slice(at, end);
    };
    // ≤430: identity + token metadata move to a second line as ONE cluster
    // (handoff §10) — the summary grid re-areas so ident lands on its own row
    // under label+detail — and both the process detail and the evidence
    // detail wrap instead of ellipsising to nothing (the §3.9 finding).
    const wide = blockFor('430px');
    expect(wide).toMatch(/#inside \.op summary,#inside \.op-static\{grid-template-columns:20px minmax\(68px,86px\)/);
    expect(wide).toMatch(/#inside \.finding-title,#inside \.ev-detail,#inside \.done-copy,#inside \.op-detail\{/);
    expect(wide).toMatch(/#inside \.gate-row\{grid-template-columns:58px 70px minmax\(0,1fr\)\}/);
    // The timeline keeps node/edge alignment (§10): its spine and time column
    // re-lock onto one line where the generic evidence detail now wraps.
    expect(wide).toMatch(
      /#inside \.timeline-row\{grid-template-columns:var\(--timeline-col\) minmax\(82px,104px\)/,
    );
    // ≤360: the block's chrome thins — row gaps and padding tighten.
    expect(blockFor('360px')).toMatch(/#inside \.op summary,#inside \.op-static\{/);
    expect(blockFor('360px')).toMatch(/#inside \.evidence-row,#inside \.gate-row\{/);
    // ≤300: the floor — only row chrome thins; the status and the name are
    // never dropped (handoff §10: "Do not hide the only status or action").
    const floor = blockFor('300px');
    expect(floor).toMatch(/#inside \.inside\{/);
    expect(floor).toMatch(/#inside \.op-body\{/);
    expect(floor).toMatch(/#inside \.evidence-row,#inside \.gate-row,#inside \.finding,#inside \.done-line\{/);
    expect(floor).not.toMatch(/display:none/);
  });

  it('never introduces whole-component horizontal scrolling at the breakpoints (B7)', () => {
    // handoff §10: "Do not introduce whole-component horizontal scrolling."
    for (const w of ['300px', '360px', '430px']) {
      const at = HTML.indexOf(`@container (max-width: ${w}){`);
      expect(at, `missing @container (max-width: ${w})`).toBeGreaterThan(-1);
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
      const block = HTML.slice(at, end);
      expect(block, `@container (max-width: ${w}) scrolls horizontally`).not.toMatch(
        /overflow-x:\s*(?:scroll|auto)/,
      );
    }
  });

  it('keeps the glyph and the process name leading the op grid at every width (Task 6)', () => {
    // The prototype's five-column op row: glyph | name | detail | tail | chev.
    // Every breakpoint narrows the NAME column; none reorders the columns, so
    // the eye's read order (state, then what it is about) is width-invariant.
    expect(HTML).toMatch(
      /#inside \.op summary,#inside \.op-static\{[\s\S]*?grid-template-columns:20px minmax\(78px,110px\) minmax\(0,1fr\) auto 16px/,
    );
    expect(containerBlock('430px')).toMatch(
      // Matched up to the track list's own terminator, so the rule may carry
      // further declarations (the compact width also tightens its padding)
      // without this assertion pinning the rule's whole text.
      /#inside \.op summary,#inside \.op-static\{grid-template-columns:20px minmax\(68px,86px\) minmax\(0,1fr\) auto 16px[;}]/,
    );
  });

  it('thins row chrome at ≤360 without dropping a cell (Task 6)', () => {
    // The floor tightens gaps and padding only. Nothing is hidden and no
    // column is collapsed away: at this width the row still reads name,
    // detail, tail (handoff §10).
    const narrow = containerBlock('360px');
    expect(narrow).toMatch(/#inside \.op summary,#inside \.op-static\{[^}]*padding-left/);
    expect(narrow).not.toMatch(/display:none/);
  });

  it('never hides the name, status, identity, disclosure, or action at any narrow width (Task 6)', () => {
    // handoff §10: "Do not hide the only status or action." Enforced for ALL
    // three breakpoints and for the identity cluster and timeline node too — a
    // narrow rule may RE-AREA a cell, never display:none it.
    for (const w of ['430px', '360px', '300px'] as const) {
      const block = containerBlock(w);
      for (const [sel, what] of [
        ['.op-name', 'the process name'],
        ['.glyph', 'the status glyph'],
        ['.agent-id', 'the identity run'],
        ['#inside .op-tail', 'the status/action cluster'],
        ['.ev-state', 'a row status'],
        ['.chev', 'the disclosure marker'],
        ['.timeline-slot', 'the timeline node cell'],
      ] as const) {
        // The cell ITSELF may never be hidden. A rule that hides one part of
        // its contents at a narrow width (the model name inside an identity
        // run, whose core still renders) is a legal degradation, so the match
        // is anchored to the cell's own declaration.
        const hiding = new RegExp(`${sel.replace(/\./g, '\\.')}\\{[^}]*display:none`).exec(block);
        expect(hiding, `≤${w} hides ${what}`).toBeNull();
      }
    }
  });

  it('keeps the Inside root itself free of horizontal scrolling (Task 6)', () => {
    // The breakpoint blocks already never scroll (B7); the ROOT must not
    // carry an overflow-x either — a stray scroller on #inside would scroll
    // the whole ledger instead of degrading it.
    const root = /#inside\{[^}]*\}/.exec(HTML)?.[0] ?? '';
    expect(root, '#inside container declaration lost').toContain('container-type:inline-size');
    expect(root).not.toContain('overflow-x');
  });

  it('wraps unbounded paths and branches mid-token, but never the compact cells (Task 6)', () => {
    // white-space:normal alone still cannot break an UNBROKEN token (a long
    // branch name or SHA) — overflow-wrap:anywhere is what actually wraps it.
    // The unbounded kinds (findings/commits/PRs) get it; the compact
    // status/timestamp/duration cells stay one line and carry no wrap claim.
    expect(containerBlock('430px')).toMatch(
      /#inside \.finding-title,#inside \.ev-detail,#inside \.done-copy,#inside \.op-detail\{[\s\S]*?overflow-wrap:anywhere/,
    );
    for (const [sel, label] of [
      ['#inside .phase-time', 'the timestamp'],
      ['#inside .duration', 'the duration'],
    ] as const) {
      const rule = new RegExp(`${sel.replace(/\./g, '\\.')}[,{]([^}]*)\\}`).exec(HTML)?.[1] ?? '';
      expect(rule, `${label} cell lost its nowrap`).toContain('white-space:nowrap');
      expect(rule, `${label} cell must never claim a wrap point`).not.toContain('overflow-wrap');
    }
  });

  it('gives the process summary its own focus ring and a rotating marker (B3)', () => {
    // <summary> is neither a <button> nor an <a>/<input>, so the primitives'
    // generic :focus-visible rule never reaches it (UI-R23 — same as .mgd and
    // .pcms). The marker is decorative; the rotation states the open state.
    expect(HTML).toMatch(/#inside \.op summary:focus-visible\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/);
    expect(HTML).toMatch(/class="chev" aria-hidden="true"/);
    expect(HTML).toMatch(/#inside \.op\[open\] \.chev:before\{transform:rotate\(45deg\)\}/);
  });

  it('places status and name before every piece of metadata on a process row', () => {
    // Step 8: inside the RENDERED summary template, status glyph → label →
    // detail → right-side identity/tokens → status/action → disclosure marker,
    // in that order, so the eye reads the claim before the facts about it and
    // the metadata can never outrank the name. (The disclosure button's markup
    // is BUILT earlier in the function — its position in the rendered template
    // is what counts.)
    const row = /function processRowHtml[\s\S]*?\n  \}/.exec(HTML)?.[0] ?? '';
    // The receipt branch returns EARLIER than the disclosure rows (it is not
    // a disclosure — 869egdr2u-fu1), so the summary template under test is
    // the LAST return: the one that carries the disclosure marker.
    const rendered = row.slice(row.lastIndexOf('return `'));
    const positions = [
      rendered.indexOf('${glyph}'),
      rendered.indexOf('${name}'),
      rendered.indexOf('${detail}'),
      rendered.indexOf('${tail}'),
      rendered.indexOf('<span class="chev"'),
    ];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('keeps process metadata attached to its own row, inside the summary container', () => {
    // The aggregate/count/duration metadata and the visible status word render
    // inside `.pright` — a child of the process's `.process-summary` — so they
    // can never drift onto another process. The aggregate is a host-shipped
    // string (B4); the webview concatenates nothing.
    const row = /function processRowHtml[\s\S]*?\n  \}/.exec(HTML)?.[0] ?? '';
    expect(row).toMatch(/const tail = `<span class="op-tail">\$\{identityHtml\(p\)\}/);
    expect(row).toMatch(/p\.aggregate \? `<span class="count">\$\{esc\(p\.aggregate\)\}/);
    expect(row).toMatch(/p\.time \? `<span class="op-time">\$\{esc\(p\.time\)\}/);
    expect(row).toMatch(/p\.duration \? `<span class="duration"\$\{p\.durationExact/);
  });

  it('escapes every untrusted fixture string at the row templates (UI-R32)', () => {
    // Finding 1: the fixture matrix deliberately carries hostile labels and
    // long paths; every template that interpolates them must escape first.
    expect(HTML).toMatch(/<span class="ev-key">\$\{esc\(r\.label\)\}<\/span>/);
    expect(HTML).toMatch(/<span class="ev-detail">\$\{esc\(r\.detail \|\| ''\)\}[\s\S]*?<\/span>/);
    expect(HTML).toMatch(/<span class="op-name">\$\{esc\(p\.label\)\}/);
    expect(HTML).toMatch(/\$\{esc\(p\.detail\)\}<\/span>/);
    expect(HTML).toMatch(/<span class="phase-time">\$\{esc\(r\.time \|\| r\.duration \|\| ''\)\}<\/span>/);
    // The object-link templates (commit hash, PR number) escape the label.
    expect(HTML).toMatch(/class="obj-link commit-link"[^>]*>\$\{esc\(c\.sha\)\}<\/a>/);
    expect(HTML).toMatch(/class="obj-link pr-link"[^>]*>\$\{esc\(b\.number\)\}<\/a>/);
    // The merge rows' state chip escapes the prs.status class and text.
    expect(HTML).toMatch(/pr-status \$\{esc\(r\.prState\)\}"\>/);
  });

  it('keeps the timeline rail geometry centered on the status glyph column', () => {
    // Task 4: the timeline's node column shares ONE width with the evidence
    // rows' status glyph column, so the spine stays centered under the
    // ledger's own glyphs at every fixture width.
    // The rail has ONE source of truth for its x-position: the slot cell. The
    // node and both edge halves are centered on 50% of that same cell, so the
    // spine cannot drift off the nodes at any width — which is exactly what a
    // separately-positioned spine did.
    expect(HTML).toMatch(/#inside \.timeline-slot\{[^}]*width:var\(--timeline-col\)/);
    expect(HTML).toMatch(/#inside \.timeline-slot:before,#inside \.timeline-slot:after\{[^}]*left:50%/);
    expect(HTML).toMatch(/#inside \.timeline-slot:before\{top:0;height:calc\(50% - var\(--node-radius, 7px\)\)\}/);
    expect(HTML).toMatch(/#inside \.timeline-slot:after\{top:calc\(50% \+ var\(--node-radius, 7px\)\);bottom:0\}/);
    // The first row has nothing above it and the last nothing below.
    expect(HTML).toMatch(
      /#inside \.timeline-row:first-child \.timeline-slot:before,\s*#inside \.timeline-row:last-child \.timeline-slot:after\{display:none\}/,
    );
  });

  it('nulls animation under reduced motion without hiding the spinner ring', () => {
    // Step 8 + UI-R30: the ring stops spinning but stays VISIBLE (a static
    // ring), because `aria-busy`/`disabled` carry the pending state — never
    // `display:none`, which would hide the ring itself. Scoped to the media
    // block that names the spinner — the file carries several, and the first
    // one is a one-liner the naive regex would overrun.
    const medias: string[] = [];
    let at = 0;
    while ((at = HTML.indexOf('@media (prefers-reduced-motion:reduce){', at)) !== -1) {
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
      medias.push(HTML.slice(at, end));
      at = end;
    }
    const rm = medias.find((b) => b.includes('.spin')) ?? '';
    expect(rm).toContain('.spin');
    expect(rm).toContain('animation:none');
    expect(rm).not.toContain('display:none');
    // The rule names the spinner class directly, so EVERY .spin element — the
    // rail segment, the Now line's ship ring, and the inside header's `.alive`
    // ring — stops turning together and stays visible (UI-R30).
    expect(rm).toMatch(/\.spin[^{]*\{[^}]*animation:none/);
    // …and no scoped .spin rule may re-declare the animation afterwards: the
    // reduced-motion block is a (0,1,0) rule, so a later scoped rule such as
    // `.inside-head .alive .spin` (0,3,1) would win by specificity and spin
    // again under reduced motion.
    for (const scoped of ['.inside-head .alive .spin', '.track .seg .spin']) {
      expect(HTML, `${scoped} re-declares an animation`).not.toMatch(
        new RegExp(`${scoped.replace('.', '\\.')}\\{[^}]*animation`),
      );
    }
  });

  /**
   * The development preview harness was DELETED, not hidden (prototype-fidelity
   * Global Constraints): its toolbar labels and width controls are the
   * prototype's debug surface and must never come back. The prose labels are
   * verbatim guards; the width words collide with legitimate production text
   * (the 300px/360px/430px container breakpoints, `white-space:normal`,
   * `--k-weight-normal`, the Resume button's "Clear the block…" title), so
   * they are guarded in the exact forms the toolbar rendered them — as the
   * width-control attribute (`data-pv-w`) and as bare button text — never as
   * bare substrings.
   */
  it('carries no prototype toolbar labels or width controls', () => {
    for (const label of ['Stage / scenario', 'Repositories', 'Start live operation']) {
      expect(HTML, `prototype toolbar label reappeared: ${label}`).not.toContain(label);
    }
    expect(HTML).not.toContain('data-pv-w');
    expect(HTML).not.toMatch(/>\s*(?:300|360|430|normal)\s*</);
    expect(HTML).not.toMatch(/>\s*(?:Complete|Clear)\s*</);
  });

  it('carries no trace of the removed preview command or host modules', () => {
    // The dev-only command contribution, its host modules and the context key
    // died with the harness; nothing the shipped webview ships may reference
    // them.
    expect(HTML).not.toContain('karst.dev.openInsidePreview');
    expect(HTML).not.toContain('insidePreview');
    expect(HTML).not.toContain('previewContext');
  });

  it('package.json contributes no preview command and no harness labels', () => {
    // Unlike the webview, package.json has no legitimate occurrence of ANY
    // constraint literal — the width words and the button words are verbatim
    // forbidden here.
    const pkg = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'),
      'utf8',
    );
    for (const label of [
      'Stage / scenario',
      'Repositories',
      'Start live operation',
      '300',
      '360',
      '430',
      'normal',
      'Complete',
      'Clear',
    ]) {
      expect(pkg, `package.json carries prototype label: ${label}`).not.toContain(label);
    }
    expect(pkg).not.toContain('karst.dev.openInsidePreview');
    expect(pkg).not.toContain('insidePreview');
    expect(pkg).not.toContain('previewContext');
  });
});

// ── Executable render round trip ────────────────────────────────────────────
//
// The tests above are SOURCE guards: they pin the rules that stop a defect,
// but they cannot tell you a snapshot RENDERS. These execute the dashboard's
// real inline script (design system + provider identity hydrated exactly as
// dashboardWebviewHtml() does) in a `node:vm` context with DOM doubles, feed
// it the `{type:'state'}` message a real dashboard push ships, and assert
// what the snapshot actually rendered: the disclosure key the renderer looks
// up, evidence that survives a live overlay, and the presented-stage
// projection. Nothing here claims pixels: layout, overflow, focus and
// reduced-motion behavior stay source guards above, and only a Dev Host run
// can execute them.

/**
 * The dashboard webview hydrated exactly as the host renders it — except the
 * vendored xterm bundles. Production injects them at /*KARST_XTERM_*\/ (see
 * extension.ts dashboardWebviewHtml); the VM harness deliberately does not,
 * because the UMD needs a full DOM (navigator/document) that the doubles
 * cannot supply — which is exactly why the console tests inject their own
 * Terminal/FitAddon fakes instead. The wiring itself is pinned by
 * src/ui/xterm.test.ts; the markers remaining here mean the console surface
 * takes the harness's fake-library path.
 */
const HYDRATED = injectAgentIdentity(injectProviderIdentity(injectPalette(injectDesignSystem(HTML))));

function previewScriptSource(): string {
  const open = HYDRATED.indexOf('<script>');
  const close = HYDRATED.indexOf('</script>', open);
  if (open < 0 || close < 0) throw new Error('dashboard webview.html has no inline script');
  return HYDRATED.slice(open + '<script>'.length, close);
}

/**
 * Read the disclosure key a process row actually RENDERED, by locating the
 * row (data-proc-id) and taking the row's OWN data-proc-id — the composite
 * key the toggle listener stores verbatim. Never fabricates the dataset.
 */
function clickChevron(html: string, stageKey: string, processId: string): string {
  // Find the row by its own identity, then read the attribute on the row.
  const rowAt = html.indexOf(`data-proc-id="${stageKey}:${processId}"`);
  if (rowAt < 0) throw new Error(`no process row for ${stageKey}:${processId}`);
  const procAt = html.indexOf('data-proc-id="', rowAt);
  const procId = html.slice(procAt + 'data-proc-id="'.length, html.indexOf('"', procAt + 'data-proc-id="'.length));
  return procId;
}

/** Render the Inside block for one stage through the render fixture envelope. */
function renderInsideFor(stage: InsideStageKey): string {
  const h = bootPreviewHarness();
  h.receive({ type: 'state', state: renderStateFor(stage) });
  return h.htmlOf('inside');
}

/** Render the whole dashboard for one host-built state message. */
function renderWith(state: DashboardState): string {
  const h = bootPreviewHarness();
  h.receive({ type: 'state', state });
  return h.htmlOf('inside');
}

/** A minimal stage view carrying one process with 3 evidence rows. */
function viewWithEvidence(stageKey: string, id: string): InsideStageView {
  return {
    stageKey: stageKey as InsideStageView['stageKey'],
    title: 'UAT',
    dot: 'run',
    clock: '',
    blurb: '',
    processes: [
      {
        id,
        kind: 'gates',
        label: 'Gates',
        status: 'pass',
        evidence: {
          kind: 'gates',
          rows: [
            { status: 'pass', label: 'a' },
            { status: 'pass', label: 'b' },
            { status: 'pass', label: 'c' },
          ],
          passed: 3,
          failed: 0,
          skipped: 0,
        },
      },
    ],
  };
}

/**
 * Execute the webview's OWN overlayProcesses against one live-ops entry, so
 * the test asserts the shipped merge rule, never a copy of it.
 */
function overlayProcesses_forTest(
  view: InsideStageView,
  live: { completed: { id: string; status: string; label: string } },
): InsideProcessView[] {
  const src = /function overlayProcesses[\s\S]*?\n  \}/.exec(HYDRATED)?.[0];
  if (!src) throw new Error('overlayProcesses not found in the webview script');
  const run = new Function('liveOps', 'view', `${src}\n;return overlayProcesses(view);`) as (
    liveOps: unknown,
    view: unknown,
  ) => InsideProcessView[];
  return run({ [view.stageKey]: live }, view);
}

/**
 * Read the static `class` attribute off an element's markup, so a harness
 * element starts with the same classes the real webview has (e.g. `hidden`).
 * Without this a popover/menu that the script only ever OPENS would read as
 * already-open, because the stub's class list starts empty.
 */
function initialClasses(id: string): string[] {
  const tag = HYDRATED.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0];
  if (!tag) return [];
  const cls = /class="([^"]*)"/.exec(tag)?.[1];
  return cls ? cls.split(/\s+/).filter(Boolean) : [];
}

/** A minimal element double for whatever the script touches through `el()`. */
function previewElement(id: string, initial: string[] = []) {
  const attrs: Record<string, string> = {};
  const classes: string[] = [...initial];
  const listeners = new Map<string, (event?: unknown) => void>();
  return {
    id,
    innerHTML: '',
    textContent: '',
    title: '',
    value: '',
    checked: false,
    disabled: false,
    dataset: {} as Record<string, string>,
    scrollWidth: 100,
    clientWidth: 100,
    attrs,
    classes,
    classList: {
      add: (name: string) => {
        if (!classes.includes(name)) classes.push(name);
      },
      remove: (name: string) => {
        const i = classes.indexOf(name);
        if (i >= 0) classes.splice(i, 1);
      },
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classes.includes(name) : !!force;
        if (on) {
          if (!classes.includes(name)) classes.push(name);
        } else {
          const i = classes.indexOf(name);
          if (i >= 0) classes.splice(i, 1);
        }
        return on;
      },
      contains: (name: string) => classes.includes(name),
    },
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
    addEventListener: (type: string, handler: (event?: unknown) => void) => {
      listeners.set(type, handler);
    },
    fire: (type: string, event?: unknown) => {
      const handler = listeners.get(type);
      if (handler) handler(event);
    },
    querySelectorAll: (_sel: string): unknown[] => [],
    querySelector: () => null,
    focus: () => {},
    setSelectionRange: () => {},
    scrollIntoView: () => {},
  };
}

type PreviewElement = ReturnType<typeof previewElement>;

interface PreviewHarness {
  /** Deliver a host message through the script's `window.addEventListener('message')`. */
  receive(message: unknown): void;
  /** Click one evidence disclosure chevron, exactly like a user expanding/collapsing a process. */
  clickChevron(key: string): void;
  /** Click through the delegated document listeners at ONE selector. */
  click(sel: string, dataset: Record<string, string>): void;
  /** Press a key on the document keydown listener. */
  key(key: string): void;
  htmlOf(id: string): string;
  textOf(id: string): string;
  classesOf(id: string): string[];
  /** The stub element for `id` — read `.checked` or `.fire('change', event)` on it. */
  element(id: string): PreviewElement;
  bodyDataset: Record<string, string>;
  bodyClasses: string[];
  /** The most recent message the script dispatched on `window` (the selected snapshot). */
  lastDispatched(): { type: string; state?: DashboardState } | undefined;
  posted: unknown[];
  /** Every `Terminal` instance the script created, in order (the console view). */
  terminals(): Array<{ opts: Record<string, unknown>; opened: boolean; written: string; disposed: boolean }>;
  /** The number of `fit()` calls on each created terminal's FitAddon. */
  fits(): number[];
}

function bootPreviewHarness(): PreviewHarness {
  const elements: Record<string, PreviewElement> = {};
  for (const id of [
    'servers',
    'inside',
    'rail',
    'title',
    'blocked',
    'toast',
    'confirmShip',
    'shipWait',
    'providerMark',
    'keyBtn',
    'boardLink',
    'agentButton',
    'agentCore',
    'agentModel',
    'agentDot',
    'agentLiveText',
    'agentPopover',
    'coreSelect',
    'modelSelect',
    'switchBtn',
    'moreBtn',
    'menuPopover',
    'followUpItem',
    'linkViews',
    'menuGates',
    'srvCount',
    'srvOps',
    'worktrees',
    'wtCount',
    'wtChanges',
    'prs',
    'prCount',
    'prRefresh',
    'artPanel',
    'artCount',
    'artTotal',
    'artViewAll',
    'artifacts',
    'artView',
    'termView',
    'termHost',
  ]) {
    elements[id] = previewElement(id, initialClasses(id));
  }

  const bodyClasses: string[] = [];
  const bodyDataset: Record<string, string> = {};
  const bodyClassList = {
    add: (name: string) => {
      if (!bodyClasses.includes(name)) bodyClasses.push(name);
    },
    remove: (name: string) => {
      const i = bodyClasses.indexOf(name);
      if (i >= 0) bodyClasses.splice(i, 1);
    },
    toggle: (name: string, force?: boolean) => {
      const on = force === undefined ? !bodyClasses.includes(name) : !!force;
      if (on) {
        if (!bodyClasses.includes(name)) bodyClasses.push(name);
      } else {
        const i = bodyClasses.indexOf(name);
        if (i >= 0) bodyClasses.splice(i, 1);
      }
      return on;
    },
    contains: (name: string) => bodyClasses.includes(name),
  };

  const docListeners = new Map<string, Array<(event?: unknown) => void>>();
  const winListeners = new Map<string, Array<(event?: unknown) => void>>();
  const dispatched: Array<{ type: string; state?: DashboardState }> = [];
  const posted: unknown[] = [];

  const lane = { scrollWidth: 100, clientWidth: 100 };
  const track = { classList: previewElement('track').classList, querySelector: (sel: string) => (sel === '.lane' ? lane : null) };

  const documentDouble = {
    getElementById: (id: string) => elements[id] ?? null,
    addEventListener: (type: string, handler: (event?: unknown) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(handler);
      docListeners.set(type, list);
    },
    querySelector: (sel: string) => (sel === '.track' ? track : null),
    body: { classList: bodyClassList, dataset: bodyDataset, appendChild: () => {} },
    createElement: () => previewElement('__created'),
  };
  const windowDouble = {
    addEventListener: (type: string, handler: (event?: unknown) => void) => {
      const list = winListeners.get(type) ?? [];
      list.push(handler);
      winListeners.set(type, list);
    },
    dispatchEvent: (event: { type: string; data?: unknown }) => {
      if (event && event.data !== undefined) {
        dispatched.push(event.data as { type: string; state?: DashboardState });
      }
      for (const handler of winListeners.get(event.type) ?? []) {
        handler({ data: event.data });
      }
    },
  };

  // The console view's xterm double: record every instance, its options, and
  // whether the webview opened/wrote/disposed it — the closest the VM can get
  // to a real terminal, and exactly the surface the console tests assert on.
  const terminalInstances: Array<{
    opts: Record<string, unknown>;
    opened: boolean;
    written: string;
    disposed: boolean;
    addon: { fit: () => void; fitCalls?: number } | null;
  }> = [];
  class FakeTerminal {
    opts: Record<string, unknown>;
    opened = false;
    written = '';
    disposed = false;
    addon: { fit: () => void; fitCalls?: number } | null = null;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      terminalInstances.push(this as unknown as (typeof terminalInstances)[number]);
    }
    open() { this.opened = true; }
    write(s: string) { this.written += s; }
    loadAddon(addon: { fit: () => void }) { this.addon = addon; }
    dispose() { this.disposed = true; }
  }
  class FakeFitAddon {
    fitCalls = 0;
    fit() { this.fitCalls += 1; }
    activate() {}
    dispose() {}
  }

  runInNewContext(`${previewScriptSource()}\n;globalThis.__karst = { esc };`, {
    acquireVsCodeApi: () => ({
      getState: () => null,
      setState: () => {},
      postMessage: (message: unknown) => void posted.push(message),
    }),
    document: documentDouble,
    window: windowDouble,
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: FakeFitAddon },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  const fireDocumentClick = (event: unknown) => {
    for (const handler of docListeners.get('click') ?? []) handler(event);
  };

  return {
    receive: (message) => {
      windowDouble.dispatchEvent({ type: 'message', data: message });
    },
    clickChevron: (key) => {
      const [stageKey, processId] = key.split(':');
      const html = elements.inside!.innerHTML;
      const rowAt = html.indexOf(`data-proc-id="${stageKey}:${processId}"`);
      if (rowAt < 0) throw new Error(`no process row for ${key}`);
      const tag = html.slice(rowAt, html.indexOf('>', rowAt));
      // A native <details> toggles: the browser flips `open` and fires the
      // `toggle` event, which the capture-phase listener persists by procId.
      // The new state is the OPPOSITE of what the rendered row currently has,
      // so clicking an open row collapses it (Task 3's default-open session
      // is exactly that case) and clicking a closed row expands it.
      const open = !tag.includes(' open');
      for (const handler of docListeners.get('toggle') ?? []) {
        handler({
          target: {
            closest: (sel: string) =>
              sel === '.inside-process' ? { dataset: { procId: `${stageKey}:${processId}` }, open } : null,
          },
        });
      }
    },
    // Click a document-level listener through a fake target whose `closest`
    // answers only the ONE selector that carries the node — every earlier
    // guard in the delegated handlers sees null, exactly as it would for a
    // target that is not inside those elements. The node carries the minimal
    // element surface the delegated action handler touches (pending state,
    // disabled, preventDefault).
    click: (sel: string, dataset: Record<string, string>) => {
      const node = {
        dataset,
        closest: (s: string) => (s === sel ? node : null),
        setAttribute: () => {},
        removeAttribute: () => {},
        classList: { add: () => {}, remove: () => {} },
        hasAttribute: () => false,
        disabled: false,
      };
      for (const handler of docListeners.get('click') ?? []) {
        handler({ target: node, preventDefault: () => {} });
      }
    },
    // Press a key on the document's keydown listener (Esc mirrors Back).
    key: (key: string) => {
      for (const handler of docListeners.get('keydown') ?? []) handler({ key });
    },
    htmlOf: (id) => elements[id]!.innerHTML,
    textOf: (id) => elements[id]!.textContent,
    classesOf: (id) => elements[id]!.classes,
    element: (id) => elements[id]!,
    bodyDataset,
    bodyClasses,
    lastDispatched: () => dispatched.at(-1),
    posted,
    terminals: () => terminalInstances,
    fits: () => terminalInstances.map((t) => t.addon?.fitCalls ?? 0),
  };
}

describe('inside render round trip (executed in a VM)', () => {
  it('emits a disclosure key that matches the open-state key the renderer looks up', () => {
    // The renderer asks openProcesses for `${stageKey}:${p.id}`; the row must
    // carry exactly that on its own data-proc-id, or the toggle is inert and
    // no evidence is reachable (the F1 regression).
    const html = renderInsideFor('uat');       // use the suite's existing helper
    expect(clickChevron(html, 'uat', 'gates')).toBe('uat:gates');
  });

  it('restores a disclosed process row across a full re-render (B3)', () => {
    // The F1 fix must not regress: the open-state key the toggle listener
    // stores (the row's own data-proc-id) is the exact key the renderer
    // consults, so a disclosure survives the next wholesale re-render.
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    expect(h.htmlOf('inside')).toContain('data-proc-id="uat:gates"');
    expect(h.htmlOf('inside')).not.toContain('data-proc-id="uat:gates" open');
    h.clickChevron('uat:gates');
    // The browser flips `open` on the details element itself; the open set is
    // what carries the state across renders — proven by the next re-render.
    h.receive({ type: 'state', state: renderStateFor('uat') });
    expect(h.htmlOf('inside')).toContain('data-proc-id="uat:gates" open');
    // And the composite key is per-row: toggling the tester never opens gates.
    h.clickChevron('uat:tester');
    h.receive({ type: 'state', state: renderStateFor('uat') });
    expect(h.htmlOf('inside')).toContain('data-proc-id="uat:tester" open');
    expect(h.htmlOf('inside')).toContain('data-proc-id="uat:gates" open');
  });

  it('never renders a spinner on a stage that is blocked', () => {
    // The real host path (store → buildDashboardState → render): a uat stage
    // parked by `parkGateStage`, which writes the block columns and leaves the
    // runner's `running` status in place. Every surface — the rail segment,
    // the strip header's clock, the gates row — used to keep reading `running`
    // beside the banner saying the stage is blocked.
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'BLK-1', title: 'blocked at uat' });
    setStage(store, t.id, 'uat', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: t.id,
      stageKey: 'uat',
      kind: 'nothing-to-run',
      reason: 'no worktree resolved to a manifest repository',
      runAt: '2026-08-09T10:33:42.000Z',
      gates: [],
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);
    const state = buildDashboardState(store, t.id);
    store.close();

    const h = bootPreviewHarness();
    h.receive({ type: 'state', state });
    const html = h.htmlOf('inside');
    // The gates row is not running and does not promise the first gate's row.
    expect(html).not.toContain('running the first gate');
    expect(html).not.toMatch(/class="op run"/);
    expect(html).not.toMatch(/class="glyph run"/);
    // The strip header's clock stops at the block's own timestamp, never at now.
    expect(html).toContain('· 33m 42s elapsed');
    // The stage strip's segment for the blocked stage carries no spinner.
    expect(h.htmlOf('rail')).not.toContain('<span class="spin"');
  });

  it('renders a non-resumable block as a banner with no Resume button', () => {
    // `awaiting-merge` is the one block a retry cannot clear — the merge sweep
    // clears it when the PR lands — so the banner shows the wait and no dead
    // button. The resumability verdict is the host's `resumable` flag on the
    // cell's `blocked`, never a reason-string match.
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'AWM-1', title: 'awaiting merge at ship' });
    setStage(store, t.id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: t.id,
      stageKey: 'ship',
      kind: 'awaiting-merge',
      reason: 'PR #412 is open and unmerged',
      runAt: '2026-08-09T10:33:42.000Z',
      gates: [],
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    const state = buildDashboardState(store, t.id);
    store.close();

    const h = bootPreviewHarness();
    h.receive({ type: 'state', state });
    const banner = h.htmlOf('blocked');
    expect(banner).toContain('Waiting to merge');
    expect(banner).toContain('PR #412 is open and unmerged');
    expect(banner).not.toContain('data-act="stage-resume"');
  });

  it('offers Resume on an unmapped-repository block', () => {
    // The block's own reason tells the user to edit karst.yml; once they
    // have, a retry is the only way forward and nothing sweeps this block
    // clear on its own. Withholding the button would strand the ticket.
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'UNM-1', title: 'unmapped at uat' });
    setStage(store, t.id, 'uat', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: t.id,
      stageKey: 'uat',
      kind: 'unmapped-repository',
      reason: 'these worktrees match no repository in karst.yml: /unmapped',
      runAt: '2026-08-09T10:33:42.000Z',
      gates: [],
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);
    const state = buildDashboardState(store, t.id);
    store.close();

    const h = bootPreviewHarness();
    h.receive({ type: 'state', state });
    const banner = h.htmlOf('blocked');
    expect(banner).toContain('these worktrees match no repository in karst.yml: /unmapped');
    expect(banner).toContain('data-act="stage-resume"');
    expect(banner).toContain('data-stagekey="uat"');
  });

  // ── the approved prototype ledger (Task 3) ──────────────────────────────
  // The outer Inside block is rebuilt to the designer handoff's anatomy: a
  // quiet ledger (`inside-ledger`) with a compact stage-key header
  // (`inside-head`), one process per native details (`inside-process`), and
  // the process summary grid / evidence / footer (`process-summary`,
  // `process-evidence`, `process-footer`). The implementation fixture is the
  // locked contract (renderFixtures.ts, Task 1) — the acceptance screenshot's
  // exact session, with its status label and footer facts (Task 2).

  /** Render the implementation prototype fixture through the real harness. */
  function renderPrototypeImpl(): string {
    const state = renderStateFor('impl');
    return renderWith({
      ...state,
      insideViews: { ...state.insideViews, impl: implementationPrototypeFixture().view },
    });
  }

  it('renders the approved quiet ledger markup (Task 3)', () => {
    const html = renderPrototypeImpl();
    expect(html).toContain('<section class="inside"');
    expect(html).toContain('class="ledger"');
    expect(html).toContain('class="inside-head"');
    expect(html).toContain('Inside impl');
    expect(html).toContain('<details class="op pass"');
    expect(html).toContain('Session');
    expect(html).toContain('Completed');
    expect(html).toContain('session c7f1');
    expect(html).toContain('same session continues across switches');
    // The old hover-card strip classes are gone wholesale — never reintroduce
    // `.act`/`.ahead`/`.procs` as the rendered shell.
    expect(html).not.toContain('class="act ');
    expect(html).not.toContain('class="procs"');
  });

  it('keeps the full stage title on the compact header (Task 3)', () => {
    const html = renderPrototypeImpl();
    expect(html).toContain('<div class="inside-head" title="Implementation">');
  });

  it('orders the summary label before detail before the right-side cluster (Task 3)', () => {
    const html = renderPrototypeImpl();
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    const glyph = summary.indexOf('<span class="glyph');
    const label = summary.indexOf('<span class="op-name">');
    const detail = summary.indexOf('<span class="op-detail');
    const tail = summary.indexOf('<span class="op-tail">');
    const chev = summary.indexOf('<span class="chev"');
    expect(glyph).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(glyph);
    expect(detail).toBeGreaterThan(label);
    expect(tail).toBeGreaterThan(detail);
    expect(chev).toBeGreaterThan(tail);
    // The footer follows the evidence inside the same disclosure body.
    expect(html.indexOf('class="session-foot"')).toBeGreaterThan(html.indexOf('class="session-segments"'));
  });

  it('carries the process status as the glyph name, never as tail text (Task 3)', () => {
    // The prototype's row has NO status word in its tail — the state is the
    // glyph, whose `aria-label` is the host-shipped `statusLabel`, so the word
    // still exists for anything that cannot see colour. A second textual
    // "Completed" beside the duration was ours, not the design's.
    const html = renderPrototypeImpl();
    expect(html).toContain('<span class="glyph pass" aria-label="Completed"></span>');
    expect(html).not.toContain('op-state');
  });

  it('opens the completed session disclosure on first render (Task 3)', () => {
    // The approved Implementation screenshot shows the timeline without a
    // preliminary click: a `session` process with evidence renders open on the
    // FIRST render, before the user has touched anything.
    const html = renderInsideFor('impl');
    expect(html).toContain('data-proc-id="impl:session" open');
    expect(html).toContain('class="session-segments"');
  });

  it('keeps the session collapsed across re-renders once the user closes it (Task 3)', () => {
    // Default-open is a first-render fallback only: the user's explicit close
    // must win on every later render, or a collapsed row would snap open again
    // on the next state push.
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('impl') });
    expect(h.htmlOf('inside')).toContain('data-proc-id="impl:session" open');
    h.clickChevron('impl:session');
    h.receive({ type: 'state', state: renderStateFor('impl') });
    // The body stays in the markup — <details> is what hides it, and rendering
    // it only when open is what made the first chevron click expand nothing.
    expect(h.htmlOf('inside')).not.toContain('data-proc-id="impl:session" open');
  });

  it('default-opens only session evidence, never gates, findings, PRs, or receipts (Task 3)', () => {
    // Repository-scaled evidence (gates, findings, commit/pr/merge rows, the
    // delivery receipt) stays closed on first render — only the ticket's own
    // session timeline earns the open default.
    for (const stage of ['uat', 'review', 'ship', 'done'] as const) {
      const html = renderInsideFor(stage);
      expect(html, `stage ${stage} default-opened a row`).not.toMatch(/data-proc-id="[^"]+"\s+open/);
    }
  });

  it('renders the prototype timeline as a connected phase ledger (Task 4)', () => {
    // The acceptance image's exact session, rendered through the real
    // harness: eight rows in order — a quiet hollow session start, four
    // phase checks, two connector branches, and the done marker — with the
    // injected core icons, secondary token pills and the right-aligned
    // timestamp column. `role`/`connector` drive every class; nothing here
    // is inferred from label prose.
    const html = renderPrototypeImpl();
    const ol = html.slice(
      html.indexOf('<div class="session-segments">'),
      html.indexOf('class="session-foot"'),
    );
    const labels = [
      ...ol.matchAll(/<span class="(?:timeline-start-label|phase-name)">([^<]*)<\/span>/g),
    ].map((m) => m[1]).concat();
    const switches = [...ol.matchAll(/<span class="switch-label"[^>]*>[\s\S]*?<span>([^<]*)<\/span>/g)]
      .map((m) => m[1]);
    expect(labels).toEqual(['started with', 'Understand', 'Plan', 'Implement', 'Tests', 'Done']);
    expect(switches).toEqual(['switched core + model', 'switched core + model']);
    // Phase rows carry the pass marker — Understand, Plan, Implement, Tests,
    // and the done marker, a phase row of its own in the acceptance image.
    expect(ol.match(/class="glyph phase-status pass"/g)).toHaveLength(5);
    // Switch rows branch from the STRUCTURAL connector — never a label match.
    expect(ol.match(/class="timeline-row switch-event"/g)).toHaveLength(2);
    expect(ol).not.toContain('label-switch');
    // The identity mark is the INJECTED canonical-icon renderer's.
    expect(ol).toContain('<span class="agenticon" aria-hidden="true">');
    // Token pills are the prototype's Σ stat, with the exact count as the
    // hover title.
    expect(ol.match(/class="token-stat"/g)).toHaveLength(3);
    expect(ol).toContain('title="18,600"');
    // Timestamps occupy the dedicated right-aligned cells.
    expect(ol).toContain('<span class="segment-window">10:03–10:09</span>');
    expect(ol).toContain('<span class="phase-time">10:22</span>');
  });

  it('feeds the timeline identity rows through the injected agent renderer (Task 4)', () => {
    // The timeline consumes the SAME injected identity API as the process
    // identity chip (B1): a marker-less dashboard would throw ReferenceError
    // on the first identity row, exactly like identityChipHtml. The pill is
    // a bordered mono token — border + mono font + faint text, all tokens.
    const fn = /function timelineRowHtml[\s\S]*?\n  \}/.exec(HTML)?.[0] ?? '';
    expect(fn).toContain('agentIconHtml(r.provider)');
    const pill = /#inside \.token-stat\{([^}]*)\}/.exec(HTML)?.[1] ?? '';
    expect(pill).toMatch(/border:/);
    expect(pill).toMatch(/--p-mono/);
    expect(pill).toMatch(/--p-muted/);
  });

  /**
   * Open one process row's disclosure and return the rendered evidence block.
   * The fixture matrix (renderFixtures) covers all eight kinds: rows on scope's
   * worktrees, gates/findings/recovery on uat+review, timeline on impl,
   * commits/prs on ship, receipt on done.
   */
  function openEvidence(stage: InsideStageKey, processId: string): string {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor(stage) });
    // The session disclosure is default-open on first render (Task 3); a row
    // already showing its evidence needs no click. Any other row is toggled
    // open exactly like a user clicking its chevron.
    if (!h.htmlOf('inside').includes(`data-proc-id="${stage}:${processId}" open`)) {
      h.clickChevron(`${stage}:${processId}`);
    }
    // A native <details> keeps its own DOM `open`; persistence is proven by
    // the NEXT render, which must restore the disclosure from the open set.
    h.receive({ type: 'state', state: renderStateFor(stage) });
    return h.htmlOf('inside');
  }

  /** The same envelope as `renderStateFor`, at a specific matrix repo count. */
  function renderStateForCount(stage: InsideStageKey, n: RenderRepoCount): DashboardState {
    const base = renderStateFor(stage);
    const fixture = renderFixtures().find((f) => f.stage === stage && f.repositoryCount === n);
    if (!fixture) throw new Error(`no render fixture for ${stage} @ ${n} repos`);
    return { ...base, insideViews: { ...base.insideViews, [stage]: fixture.view } };
  }

  /** Open one process row's disclosure at a specific matrix repo count. */
  function openEvidenceCount(
    stage: InsideStageKey,
    processId: string,
    n: RenderRepoCount,
  ): string {
    const state = renderStateForCount(stage, n);
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state });
    if (!h.htmlOf('inside').includes(`data-proc-id="${stage}:${processId}" open`)) {
      h.clickChevron(`${stage}:${processId}`);
    }
    h.receive({ type: 'state', state });
    return h.htmlOf('inside');
  }

  it('renders rows evidence through the generic renderer (B2)', () => {
    const html = openEvidence('scope', 'worktrees');
    expect(html).toContain('class="evidence-row"');
    expect(html).toMatch(/<span class="ev-key">worktree<\/span>/);
    // The row's status is the glyph, whose accessible name is the word.
    expect(html).toMatch(/<span class="ev-state [a-z]+">(?:<span class="ev-dur">[^<]*<\/span>)?<span class="glyph [a-z]+" aria-label="(?:pending|passed)"><\/span><\/span>/);
  });

  it('renders gates evidence with a per-row status glyph (B2)', () => {
    // handoff §6's gate template: "lint  exit 0  ✓". The status word repeated
    // what the row already said, so it is the glyph's accessible name now —
    // still never colour alone (UI-R06). The fixture rows carry no recorded
    // repository, so the body drops the repo column (`no-repo`).
    const html = openEvidence('uat', 'gates');
    expect(html).toContain('class="gates no-repo"');
    expect(html).toContain('<span class="glyph pass" aria-label="passed"></span>');
    expect(html).toContain('<span class="gate-name">lint</span>');
  });

  it('renders findings evidence with severity rows and their status words (B2)', () => {
    const html = openEvidence('review', 'review');
    expect(html).toContain('class="findings"');
    // The level is coloured per LEVEL, from the host's closed severity key —
    // every level rendered in one amber before this (869egdr2u-fu2).
    expect(html).toContain('<span class="sev sev-critical">critical</span>');
    expect(html).toContain('<span class="sev sev-high">high</span>');
    expect(html).toContain('<span class="sev sev-medium">medium</span>');
    expect(html).toContain('class="finding-title"');
  });

  it('renders timeline evidence as the phase ledger with a time column (Task 4)', () => {
    // handoff §6 impl: the connector branch keeps its own aligned node column,
    // and the range reads as a right-aligned time column. The `<ol>` is the
    // timeline's semantic list; the rows are its nodes on the shared spine.
    const html = openEvidence('impl', 'session');
    expect(html).toContain('class="session-segments"');
    expect(html).toMatch(/class="timeline-row switch-event"/);
    expect(html).toMatch(/<span class="switch-arrow" aria-hidden="true">↳<\/span>/);
    // The start stamp rides the tail beside its span — the identity slot is
    // not a place for a time (869egdr2u-fu1).
    expect(html).toContain('<span class="segment-window">09:12:33</span>');
    expect(html).toContain('<span class="segment-window">4m 12s</span>');
  });

  it('renders commits evidence as the prototype commit grid (B2)', () => {
    // The rich body: one block per repository, its host-formatted count line
    // and its provenance pill, then the recorded commits by sha and subject.
    const html = openEvidence('ship', 'commit');
    expect(html).toContain('class="commit-grid"');
    expect(html).toContain('<span class="commit-repo-name">web</span>');
    expect(html).toContain('<span class="commit-repo-summary">2 created · 1 before</span>');
    expect(html).toContain('<span class="commit-origin ship">created by ship</span>');
    expect(html).toContain('class="commit-item"');
    // The commit hash IS the open-commit control — a link, never a button.
    expect(html).toMatch(/<a class="obj-link commit-link" href="#" data-act="inside-action"[^>]*>a1b2c30<\/a>/);
    expect(html).not.toContain('<span class="commit-sha">a1b2c30</span>');
    // Commit subjects are untrusted prose and are escaped at the template.
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain("<script>alert('xss')");
  });

  it('falls back to the generic row body when a snapshot carries no commit grid', () => {
    // Back-compat: `repos` is optional, so a snapshot produced before the
    // rich body existed still renders exactly what it always did.
    const state = renderStateFor('ship');
    const ship = { ...state.insideViews.ship };
    ship.processes = ship.processes.map((p) =>
      p.id === 'commit' && p.evidence?.kind === 'commits'
        ? { ...p, evidence: { kind: 'commits' as const, rows: p.evidence.rows, total: p.evidence.total } }
        : p,
    );
    const h = bootPreviewHarness();
    const next = { ...state, insideViews: { ...state.insideViews, ship } };
    h.receive({ type: 'state', state: next });
    h.clickChevron('ship:commit');
    h.receive({ type: 'state', state: next });
    const html = h.htmlOf('inside');
    expect(html).toContain('class="evidence-row"');
    expect(html).not.toContain('class="commit-grid"');
  });

  it('renders prs evidence as the prototype branch paths (B2)', () => {
    // The rich body: the PR object karst recorded (number + state pill), the
    // arrow-separated recorded step path, and the host's own note.
    const html = openEvidence('ship', 'pr');
    expect(html).toContain('class="pr-branches"');
    expect(html).toContain('<span class="pr-repo">web</span>');
    expect(html).toContain('class="pr-path"');
    expect(html).toContain('<span class="pr-link">#120</span>');
    expect(html).toContain('<span class="pr-status draft">draft</span>');
    expect(html).toContain('<span class="pr-step done">PR opened</span>');
    expect(html).toContain('class="pr-branch-note"');
    expect(html).toContain('PR #120 was created in this ship run.');
  });

  it('falls back to the generic row body when a snapshot carries no branches', () => {
    const state = renderStateFor('ship');
    const ship = { ...state.insideViews.ship };
    ship.processes = ship.processes.map((p) =>
      p.id === 'pr' && p.evidence?.kind === 'prs'
        ? {
            ...p,
            evidence: {
              kind: 'prs' as const,
              rows: p.evidence.rows,
              open: p.evidence.open,
              merged: p.evidence.merged,
            },
          }
        : p,
    );
    const h = bootPreviewHarness();
    const next = { ...state, insideViews: { ...state.insideViews, ship } };
    h.receive({ type: 'state', state: next });
    h.clickChevron('ship:pr');
    h.receive({ type: 'state', state: next });
    const html = h.htmlOf('inside');
    expect(html).toContain('class="evidence-row"');
    expect(html).not.toContain('class="pr-branches"');
  });

  it('renders the delivery receipt hero and its three-block grid (B2)', () => {
    const html = openEvidence('done', 'delivery-receipt');
    expect(html).toContain('class="done-receipt"');
    expect(html).toContain('class="done-hero"');
    expect(html).toContain('<span class="done-hero-main">Delivered</span>');
    expect(html).toContain('<span class="done-hero-time">completed 09:58:44</span>');
    expect(html).toContain('class="receipt-grid"');
    expect(html).toContain('<div class="receipt-label">Validated</div>');
    expect(html).toContain('<div class="receipt-value">110.9k recorded tokens</div>');
    expect(html).toContain('class="ai-usage-breakdown"');
    expect(html).toContain('<span class="ai-usage-item"><strong>58.3k</strong> implementation</span>');
    // The delivery lines the receipt has always carried are still below it.
    expect(html).toContain('class="done-lines"');
    expect(html).toContain('<span class="done-key">commits</span>');
  });

  it('keeps the receipt overview visible without any click — it is not a disclosure (869egdr2u-fu1)', () => {
    // The done overview (hero + receipt grid + timing) is NEVER behind the
    // process chevron: the row renders static and the body sits beneath it
    // unconditionally. Only the detail lines expand, behind the receipt's own
    // inner <details>.
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('done') });
    const html = h.htmlOf('inside');
    expect(html).toContain('data-proc-id="done:delivery-receipt"');
    expect(html).not.toMatch(/data-proc-id="done:delivery-receipt" open/);
    expect(html).toContain('class="done-hero"');
    expect(html).toContain('class="receipt-grid"');
    expect(html).toContain('<details class="done-details">');
    expect(html).toMatch(/<summary><span class="done-chev" aria-hidden="true"><\/span>Details<\/summary>/);
  });

  it('renders the Timing strip with the host-stated total and stage spans (869egdr2u-fu1)', () => {
    // The sum of the stage spans IS the stated total — computed host-side
    // from the same stamps (UI-R31: the webview concatenates nothing).
    const html = renderInsideFor('done');
    expect(html).toContain('<div class="done-timing">');
    expect(html).toContain('<span class="done-timing-label">Timing</span>');
    expect(html).toContain('<span class="done-timing-value">37m 8s total</span>');
    expect(html).toContain(
      '<span class="done-timing-items">Scope 2m 10s · Implementation 22m 15s · UAT 5m 2s · Review 4m 30s · Ship 3m 11s</span>',
    );
  });

  it('renders a receipt with no hero or blocks as the plain line list', () => {
    const state = renderStateFor('done');
    const done = { ...state.insideViews.done };
    done.processes = done.processes.map((p) =>
      p.evidence?.kind === 'receipt'
        ? { ...p, evidence: { kind: 'receipt' as const, rows: p.evidence.rows } }
        : p,
    );
    const h = bootPreviewHarness();
    const next = { ...state, insideViews: { ...state.insideViews, done } };
    h.receive({ type: 'state', state: next });
    h.clickChevron('done:delivery-receipt');
    h.receive({ type: 'state', state: next });
    const html = h.htmlOf('inside');
    expect(html).toContain('class="done-line"');
    expect(html).not.toContain('class="done-hero"');
    expect(html).not.toContain('class="receipt-grid"');
  });

  it('renders recovery evidence with one row per round (B2)', () => {
    const html = openEvidence('uat', 'fix');
    expect(html).toContain('class="recovery-history"');
    expect(html).toContain('<span class="recovery-num">round 1</span>');
    expect(html).toContain('<span class="recovery-num">round 3</span>');
  });

  it('renders the receipt as a list with no per-row glyph column (B2)', () => {
    // handoff §6 done: the receipt is plain lines ("2 current PRs merged"),
    // not a status readout — the process row's own status is the verdict.
    const html = openEvidence('done', 'delivery-receipt');
    const blockAt = html.indexOf('class="done-line"');
    expect(blockAt).toBeGreaterThan(-1);
    const block = html.slice(blockAt);
    expect(block).toContain('<span class="done-key">merged</span>');
    expect(block).toContain('<span class="done-key">commits</span>');
    // A receipt states delivered facts; it carries no glyph column and no
    // per-row status readout.
    expect(block).not.toContain('class="glyph');
    expect(block).not.toContain('ev-state');
  });

  it('renders an unknown evidence kind through the generic renderer, never throwing (B2)', () => {
    // Forward compatibility: a host that ships a kind this build has no layout
    // for must degrade to the generic rows renderer, not a blank block.
    const state = renderStateFor('scope');
    const scope = { ...state.insideViews.scope };
    scope.processes = scope.processes.map((p) =>
      p.id === 'worktrees'
        ? { ...p, evidence: { kind: 'future-kind', rows: [{ status: 'note', label: 'future' }] } as unknown as InsideProcessView['evidence'] }
        : p,
    );
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: { ...state, insideViews: { ...state.insideViews, scope } } });
    h.clickChevron('scope:worktrees');
    h.receive({ type: 'state', state: { ...state, insideViews: { ...state.insideViews, scope } } });
    const html = h.htmlOf('inside');
    expect(html).toContain('class="evidence-row"');
    expect(html).toContain('<span class="ev-key">future</span>');
  });

  // ── the matrix evidence contract (Task 5) ────────────────────────────────
  // Every EVIDENCE_KINDS member renders through its own `pev-<kind>`
  // container with visible status text, its factual detail, and its actions in
  // the trailing cluster — one shared row helper behind all of it.

  /** Which fixture process answers for each evidence kind. */
  const EVIDENCE_AT: Readonly<Record<(typeof EVIDENCE_KINDS)[number], readonly [InsideStageKey, string]>> = {
    rows: ['scope', 'worktrees'],
    gates: ['uat', 'gates'],
    findings: ['review', 'review'],
    timeline: ['impl', 'session'],
    commits: ['ship', 'commit'],
    prs: ['ship', 'pr'],
    recovery: ['uat', 'fix'],
    receipt: ['done', 'delivery-receipt'],
  };

  it('renders every evidence kind through its own prototype container (Task 5)', () => {
    // Each kind lands in the container the ported prototype gives it. Every
    // kind now has a bespoke body; the generic evidence row remains the
    // fallback for `rows` and for any snapshot that ships no rich fields.
    const CONTAINER: Readonly<Record<(typeof EVIDENCE_KINDS)[number], string>> = {
      rows: 'class="evidence-row"',
      gates: 'class="gates no-repo"',
      findings: 'class="findings"',
      timeline: 'class="session-segments"',
      commits: 'class="commit-grid"',
      prs: 'class="pr-branches"',
      recovery: 'class="recovery-history"',
      receipt: 'class="done-receipt"',
    };
    for (const kind of EVIDENCE_KINDS) {
      const [stage, processId] = EVIDENCE_AT[kind];
      expect(openEvidence(stage, processId), `kind ${kind}`).toContain(CONTAINER[kind]);
    }
  });

  it('names the status on every status-bearing kind, never colour alone (Task 5)', () => {
    // gates carry the closed status word as their glyph's accessible name;
    // findings/commits/prs render host-supplied words. Either way the claim
    // survives a theme that ignores colour (UI-R06).
    expect(openEvidence('uat', 'gates')).toContain('<span class="glyph pass" aria-label="passed"></span>');
    const findings = openEvidence('review', 'review');
    expect(findings).toContain('>critical</span>');
    expect(findings).toContain('>medium</span>');
    // Ship's rich bodies carry their state as the recorded provenance pill and
    // the PR state pill — both host-supplied words, never colour alone.
    expect(openEvidence('ship', 'commit')).toContain('<span class="commit-origin ship">created by ship</span>');
    expect(openEvidence('ship', 'pr')).toContain('<span class="pr-status open">open</span>');
  });

  it('keeps every rendered status word inside the closed vocabulary (Task 5)', () => {
    // A status word is ALWAYS one of the closed set — the webview never
    // fabricates copy for a state, and a receipt line carries none at all
    // because delivered facts are not a status readout.
    const words = ['pending', 'running', 'waiting', 'passed', 'failed', 'note', 'skipped'];
    for (const [stage, id] of [['uat', 'gates'], ['scope', 'worktrees'], ['ship', 'pr']] as const) {
      const html = openEvidence(stage, id);
      for (const m of html.matchAll(/class="(?:ev|gate)-state[^"]*">([^<·]*)/g)) {
        const word = (m[1] ?? '').trim();
        if (word) expect(words, `${stage}:${id} rendered "${word}"`).toContain(word);
      }
    }
    const receipt = openEvidence('done', 'delivery-receipt');
    const body = receipt.slice(receipt.indexOf('class="op-body"'));
    expect(body).not.toContain('ev-state');
    expect(body).not.toContain('class="glyph');
  });

  it('renders each kind’s factual detail verbatim (Task 5)', () => {
    expect(openEvidence('uat', 'gates')).toContain('<span class="gate-detail">exit 0</span>');
    expect(openEvidence('review', 'review')).toContain('SQL injection in query builder');
    expect(openEvidence('ship', 'commit')).toContain('<span class="commit-repo-summary">2 created · 1 before</span>');
    expect(openEvidence('ship', 'pr')).toContain('<span class="pr-link">#120</span>');
    expect(openEvidence('uat', 'fix')).toContain('gate test failed');
    expect(openEvidence('done', 'delivery-receipt')).toContain('31 created by ship');
    expect(openEvidence('scope', 'worktrees')).toContain('<span class="ev-key">worktree</span>');
  });

  it('makes a finding location its own link, not an Open file button (fu2)', () => {
    // UI-R09c: the visible resource identifier IS the control. The "Open file"
    // button beside inert location text was a second, weaker way to reach the
    // same place, and it is gone from BOTH quality stages.
    const findings = openEvidence('review', 'review');
    expect(findings).toMatch(
      /<a class="obj-link file-link" href="#" data-act="inside-action"[^>]*>src\/db\/query\.ts:41<\/a>/,
    );
    expect(findings).toContain('data-action-id="fixture:open-file:1"');
    expect(findings).not.toContain('>Open file</button>');
    // Tester observations render through the SAME findings blueprint.
    const uat = openEvidence('uat', 'tester');
    expect(uat).toMatch(/<a class="obj-link file-link"[^>]*data-act="inside-action"/);
    expect(uat).not.toContain('>Open file</button>');
  });

  it('orders UAT Gates → causal Fix → Services → Tester (Task 5)', () => {
    // The plan's acceptance: the Fix process sits immediately after its
    // trigger — the gates process whose failure opened the recovery round —
    // never at the bottom as an unrelated retry meter (handoff §5.5).
    const html = renderInsideFor('uat');
    const pos = (id: string): number => html.indexOf(`data-proc-id="uat:${id}"`);
    expect(pos('gates')).toBeGreaterThan(-1);
    expect(pos('fix')).toBeGreaterThan(pos('gates'));
    expect(pos('services')).toBeGreaterThan(pos('fix'));
    expect(pos('tester')).toBeGreaterThan(pos('services'));
  });

  it('orders Review Gates → Services → Review (Task 5)', () => {
    // Review's matrix scenario records no recovery round, so no Fix row
    // appears — the fix-after-trigger rule applies where a Fix exists (uat).
    const html = renderInsideFor('review');
    const pos = (id: string): number => html.indexOf(`data-proc-id="review:${id}"`);
    expect(pos('gates')).toBeGreaterThan(-1);
    expect(pos('services')).toBeGreaterThan(pos('gates'));
    expect(pos('review')).toBeGreaterThan(pos('services'));
  });

  it('keeps Ship Commit → Push → PR → Merge with conflicts waiting, never failed (Task 5)', () => {
    const html = renderInsideFor('ship');
    const pos = (id: string): number => html.indexOf(`data-proc-id="ship:${id}"`);
    expect(pos('commit')).toBeGreaterThan(-1);
    expect(pos('push')).toBeGreaterThan(pos('commit'));
    expect(pos('pr')).toBeGreaterThan(pos('push'));
    expect(pos('merge')).toBeGreaterThan(pos('pr'));
    // The conflicted merge row reads WAITING — the ⏸ glyph on an `.erow.wait`
    // row — never a fail glyph and never a fail word.
    const merge = openEvidence('ship', 'merge');
    expect(merge).toContain('<span class="ev-key">conflict</span>');
    expect(merge).toContain('<span class="glyph wait" aria-label="waiting"></span>');
    expect(merge).not.toMatch(/ev-state fail/);
    // The merge PROCESS row reads waiting too — its glyph is the wait shape.
    expect(merge).toMatch(/<details class="op wait waiting-source"/);
  });

  it('renders Done as a receipt with no executable controls (Task 5)', () => {
    // The receipt is delivered facts, not an execution surface (handoff §6
    // done): at the default repo count it renders no control at all — no
    // glyph column, no status words, no buttons.
    const receipt = openEvidence('done', 'delivery-receipt');
    const block = receipt.slice(receipt.indexOf('class="pev pev-receipt"'));
    expect(block).not.toContain('eglyph');
    expect(block).not.toContain('estatus');
    expect(block).not.toContain('<button');
  });

  it('renders host-supplied Show-N-more continuations on bounded rows (Task 5)', () => {
    // handoff §10: a bounded continuation says exactly what it reveals — the
    // host ships the count-bearing label and the webview renders it verbatim
    // inside the row's action cluster. Ship's per-repo processes and the done
    // receipt carry one; the plain uat gates bound stays passive.
    const commits = openEvidenceCount('ship', 'commit', 20);
    expect(commits).toContain('Show 14 more');
    // The rich body's bound is stated on its own overflow note, which carries
    // the host's count copy and the host's count-bearing continuation label.
    expect(commits).toMatch(
      /<div class="overflow-note"><span>\+14 more<\/span><button[^>]*data-act="inside-action"[^>]*>Show 14 more<\/button><\/div>/,
    );
    const receipt = openEvidenceCount('done', 'delivery-receipt', 20);
    const block = receipt.slice(receipt.indexOf('receipt-body'));
    expect(block).toContain('Show 14 more');
    expect(block).toContain('data-action-id="fixture:open-bounded-evidence:20"');
    // A gate bound the reducer did not make actionable renders no control.
    const state = renderStateForCount('uat', 20);
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state });
    h.clickChevron('uat:gates');
    h.receive({ type: 'state', state });
    const gates = h.htmlOf('inside');
    const from = gates.indexOf('data-proc-id="uat:gates"');
    const gatesBody = gates.slice(from, gates.indexOf('</details>', from));
    expect(gatesBody).toContain('+32 more');
    expect(gatesBody).not.toContain('data-act="inside-action"');
  });

  it('renders the host-computed aggregate on the process row (B4)', () => {
    // "4 passed · 1 failed" arrives pre-worded from the reducer; the webview
    // only places it (UI-R31: it concatenates nothing).
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat };
    uat.processes = uat.processes.map((p) =>
      p.id === 'gates' ? { ...p, aggregate: '4 passed · 1 failed' } : p,
    );
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, uat } });
    expect(html).toContain('<span class="count">4 passed · 1 failed</span>');
    expect(html).not.toMatch(/4 passed.*4 passed/);
  });

  it('renders the unavailable token state as absence with a title, never 0 (B2)', () => {
    // decision 8: a provider that reports no per-session usage (Claude,
    // Antigravity) must read as absent with the handoff §11 title — "usage
    // unavailable" per handoff §6, never "0 tokens" and never "undefined".
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat };
    uat.processes = uat.processes.map((p) =>
      p.id === 'tester'
        ? { ...p, tokens: { state: 'unavailable', title: 'Token usage not available for this provider' } }
        : p,
    );
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, uat } });
    expect(html).toContain('usage unavailable');
    expect(html).toContain('title="Token usage not available for this provider"');
    expect(html).not.toContain('undefined');
    expect(html).not.toMatch(/\b0 tokens\b/);
  });

  it('keeps snapshot evidence when a live completed event has none', () => {
    const view = viewWithEvidence('uat', 'gates');       // 3 evidence rows
    const merged = overlayProcesses_forTest(view, { completed: { id: 'gates', status: 'pass', label: 'Gates' } });
    expect(merged.find((p) => p.id === 'gates')?.evidence?.rows).toHaveLength(3);
  });

  it('falls back to the host-computed presented stage when the ticket is in fix', () => {
    const state = { ...renderStateFor('uat'), stageCurrent: 'fix' };
    const html = renderWith(state);          // suite's existing render helper
    expect(html).toContain('Inside uat');    // not empty
  });

  it('renders a waiting live operation without a running spinner', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.receive({
      type: 'inside-progress',
      event: {
        kind: 'active',
        stage: 'uat',
        processId: 'tester',
        live: { label: 'Waiting for approval', status: 'wait' },
      },
    });
    const html = h.htmlOf('inside');
    // The live header draws the ported prototype's WAIT glyph — two bars, a
    // different SHAPE from the running arc, so a stalled operation can never
    // read as progress.
    // The word rides the glyph's accessible name and is NOT repeated as text
    // beside it — the shape already carries the state, the same trade the
    // process rows make.
    expect(html).toContain('<span class="glyph wait" aria-label="waiting"></span>');
    expect(html).not.toContain('class="live-state"');
    expect(html).not.toContain('class="glyph run"');
  });

  it('renders a running process row and live header regardless of animation (Task 6)', () => {
    // The running state is MARKUP, not animation: the status WORD ("running")
    // renders from the closed map when the host ships no label, and the live
    // header's spinner element is in the DOM whether or not it turns —
    // reduced-motion stops the ring (the source guard above), never the row.
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat };
    uat.processes = [{ id: 'tester', kind: 'tester', label: 'Tester', status: 'run' }];
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: { ...state, insideViews: { ...state.insideViews, uat } } });
    h.receive({
      type: 'inside-progress',
      event: {
        kind: 'active',
        stage: 'uat',
        processId: 'tester',
        live: { label: 'Running the gate suite', status: 'run' },
      },
    });
    const html = h.htmlOf('inside');
    expect(html).toContain('<span class="inside-live run">');
    expect(html).toContain('<span class="glyph run" aria-label="running"></span>');
  });

  it('renders the viewing bar with a way back when a non-current stage is shown (Task 6)', () => {
    // The vbar ("Viewing X — not the current stage.") had no render test: it
    // is the only thing that explains why the ledger contradicts the Now
    // line, so its markup must actually appear. Rendered from a state whose
    // stageCurrent differs from the presented stage.
    const state = { ...renderStateFor('impl'), stageCurrent: 'ship' };
    const html = renderWith(state);
    expect(html).toContain('Viewing Implementation — not the current stage.');
    expect(html).toMatch(
      /data-back[^>]*title="Return the strip to the stage the ticket is actually on"[^>]*>Back to Ship<\/button>/,
    );
    // The current stage renders no bar at all.
    expect(renderWith(renderStateFor('impl'))).not.toContain('class="vbar"');
  });

  it('renders the blurb empty state when a stage has no processes (Task 6)', () => {
    // A stage that never ran renders its static "what happens here" copy — an
    // empty processes array must not render an empty ledger. No render test
    // existed for the blurb before this one.
    const state = renderStateFor('scope');
    const scope = { ...state.insideViews.scope, processes: [] };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, scope } });
    expect(html).toContain('<div class="blurb">');
    expect(html).toContain(scope.blurb);
    expect(html).not.toContain('data-proc-id=');
  });

  it('renders the recorded repository as its own gates column', () => {
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat };
    uat.processes = uat.processes.map((p) =>
      p.id === 'gates'
        ? {
            ...p,
            evidence: {
              kind: 'gates',
              rows: [
                { status: 'pass', label: 'test (web)', detail: 'exit 0', repo: '/web' },
                { status: 'fail', label: 'lint (api)', detail: 'exit 1', repo: '/api' },
              ],
              passed: 1,
              failed: 1,
              skipped: 0,
            },
          }
        : p,
    );
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: { ...state, insideViews: { ...state.insideViews, uat } } });
    h.clickChevron('uat:gates');
    const html = h.htmlOf('inside');
    expect(html).toContain('<div class="gates">');
    expect(html).toContain('<span class="gate-repo">/web</span>');
    expect(html).toContain('<span class="gate-repo">/api</span>');
    expect(html).not.toContain('class="gates no-repo"');
  });

  it('drops the repo column for a gates body whose rows name none', () => {
    // A pre-v21 batch recorded no repository; drawing an empty 90px column
    // would read as a repo with no name.
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat };
    uat.processes = uat.processes.map((p) =>
      p.id === 'gates'
        ? {
            ...p,
            evidence: {
              kind: 'gates',
              rows: [{ status: 'pass', label: 'test (web)', detail: 'exit 0' }],
              passed: 1,
              failed: 0,
              skipped: 0,
            },
          }
        : p,
    );
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: { ...state, insideViews: { ...state.insideViews, uat } } });
    h.clickChevron('uat:gates');
    const html = h.htmlOf('inside');
    expect(html).toContain('class="gates no-repo"');
    expect(html).not.toContain('class="gate-repo"');
  });

  it('renders a recovery round status as a glyph, never a word', () => {
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat };
    uat.processes = [
      ...uat.processes,
      {
        id: 'fix',
        kind: 'fix',
        label: 'Fix',
        status: 'run',
        evidence: {
          kind: 'recovery',
          rows: [
            { status: 'run', label: 'round 1', detail: 'Fix started after UAT test failure · round 1 of 2' },
            { status: 'pass', label: 'round 2', detail: 'Fix started after UAT test failure · round 2 of 2' },
          ],
        },
      },
    ];
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: { ...state, insideViews: { ...state.insideViews, uat } } });
    h.clickChevron('uat:fix');
    const html = h.htmlOf('inside');
    // The status WORD is gone from the rendered row; it survives only as the
    // glyph's accessible name — the same trade `evStateHtml` documents.
    expect(html).not.toContain('<span class="recovery-result run">running</span>');
    expect(html).toContain('<span class="glyph run" aria-label="running"></span>');
    expect(html).toContain('<span class="glyph pass" aria-label="passed"></span>');
  });

  it('titles a duration with its exact span', () => {
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat };
    uat.processes = uat.processes.map((p) =>
      p.id === 'gates'
        ? {
            ...p,
            duration: '5.2s',
            durationExact: '5.234s',
            evidence: {
              kind: 'gates',
              rows: [
                {
                  status: 'pass',
                  label: 'test (web)',
                  detail: 'exit 0',
                  duration: '5.2s',
                  durationExact: '5.234s',
                },
              ],
              passed: 1,
              failed: 0,
              skipped: 0,
            },
          }
        : p,
    );
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: { ...state, insideViews: { ...state.insideViews, uat } } });
    h.clickChevron('uat:gates');
    const html = h.htmlOf('inside');
    // The process tail AND the row's ev-state cell both title their duration.
    expect(html).toContain('<span class="duration" title="5.234s">5.2s</span>');
    expect(html).toContain('<span class="ev-dur" title="5.234s">5.2s</span>');
  });

  it('renders a process start time beside its duration', () => {
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat };
    uat.processes = uat.processes.map((p) =>
      p.id === 'gates'
        ? { ...p, time: '12:00:00', duration: '5.2s', durationExact: '5.234s' }
        : p,
    );
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, uat } });
    expect(html).toContain('<span class="op-time">12:00:00</span>');
    expect(html).toContain('<span class="duration" title="5.234s">5.2s</span>');
    // Time renders BEFORE the duration in the tail.
    expect(html.indexOf('<span class="op-time">')).toBeGreaterThan(-1);
    expect(html.indexOf('<span class="op-time">')).toBeLessThan(
      html.indexOf('<span class="duration"'),
    );
  });

  it('falls back to the snapshot live line when no progress event has arrived', () => {
    // A reopened panel has no liveOps overlay; the stage's own derived live
    // line must fill the header.
    const state = renderStateFor('uat');
    const uat = { ...state.insideViews.uat, live: { status: 'run' as const, label: 'Tester' } };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, uat } });
    expect(html).toContain('<span class="inside-live run">');
    expect(html).toContain('<span class="glyph run" aria-label="running"></span>');
    expect(html).toContain('<strong>Tester</strong>');
  });

  it('keeps the recovery round word on the glyph only, never rendered text (source)', () => {
    const fn = /function evidenceRecoveryHtml[\s\S]*?\n  \}/.exec(HYDRATED)?.[0];
    expect(fn).toBeTruthy();
    // The word is used exactly once, and that one use is the glyph's
    // accessible name — pinned by ROLE rather than by the expression's text,
    // so the status fallback can match the class's without this failing.
    expect(fn!.match(/statusWord\(/g)).toHaveLength(1);
    expect(fn!).toMatch(/aria-label="\$\{esc\(statusWord\(/);
    expect(fn!).not.toContain('esc(r.duration || statusWord(r.status))');
  });
});

describe('agent popover round trip (executed in a VM)', () => {
  it('posts the staged core/model only on Switch agent, never on open or close', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'SW-H', title: 'switch' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
    const state = buildDashboardState(
      store, t.id, undefined, undefined, undefined, undefined, 'claude',
      { defaultModel: null, isSessionOpen: () => true },
    );
    store.close();
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state });
    h.click('#agentButton', {});
    const popover = h.classesOf('agentPopover');
    expect(popover.includes('hidden')).toBe(false);
    // Closing without switching posts nothing.
    const before = h.posted.length;
    h.click('body', {});
    expect(h.posted.length).toBe(before);
  });

  it('opens each header popover with the .open class, not just minus hidden (PR #166)', () => {
    // `.popover{display:none}` is the base state — removing `hidden` alone
    // leaves the popover invisible, because only `.popover.open` turns it on.
    // The shipped open/close helpers must toggle `open`, or the agent-switch
    // form and the … ticket-controls menu can never appear.
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'SW-H', title: 'switch' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
    const state = buildDashboardState(
      store, t.id, undefined, undefined, undefined, undefined, 'claude',
      { defaultModel: null, isSessionOpen: () => true },
    );
    store.close();
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state });

    h.click('#agentButton', {});
    expect(h.classesOf('agentPopover')).toEqual(expect.arrayContaining(['open']));
    expect(h.classesOf('agentPopover')).not.toContain('hidden');
    // A click elsewhere closes it: `hidden` returns and `open` is dropped.
    h.click('body', {});
    expect(h.classesOf('agentPopover')).toContain('hidden');
    expect(h.classesOf('agentPopover')).not.toContain('open');

    h.click('#moreBtn', {});
    expect(h.classesOf('menuPopover')).toEqual(expect.arrayContaining(['open']));
    expect(h.classesOf('menuPopover')).not.toContain('hidden');
    h.click('body', {});
    expect(h.classesOf('menuPopover')).toContain('hidden');
    expect(h.classesOf('menuPopover')).not.toContain('open');
  });

  it('posts toggle-bind from the menu switch and renders the host push', () => {
    const h = bootPreviewHarness();
    // The host's `bind` push drives the checkbox — the webview never remembers
    // the value, because the preference is window-wide and host-owned.
    h.receive({ type: 'bind', enabled: true });
    expect(h.element('linkViews').checked).toBe(true);
    h.receive({ type: 'bind', enabled: false });
    expect(h.element('linkViews').checked).toBe(false);
    // The change listener posts the payload-free flip; the host answers with
    // the `bind` message, which is the terminal outcome (UI-R13/R31).
    const before = h.posted.length;
    h.element('linkViews').fire('change', {});
    expect(h.posted.slice(before)).toEqual([{ type: 'toggle-bind' }]);
    // The shipped wiring, pinned so a future refactor cannot rename it.
    expect(HTML).toContain("msg.type === 'bind'");
    expect(HTML).toMatch(/toggle-bind/);
  });
});

describe('inside block issues p3 renderings (869egdr2u)', () => {
  it('makes a delivery line\'s PR number its own link, with the state chip beside it (fu2)', () => {
    const state = renderStateFor('done');
    const done: InsideStageView = {
      stageKey: 'done',
      title: 'Done',
      dot: 'done',
      clock: '',
      blurb: '',
      processes: [
        {
          id: 'delivery-receipt',
          kind: 'delivery-receipt',
          label: 'Delivery receipt',
          status: 'pass',
          detail: '1 current pull request merged',
          evidence: {
            kind: 'receipt',
            rows: [
              {
                status: 'pass',
                label: 'web',
                detail: '#412',
                prState: 'merged',
                time: '09:58:01',
                action: { actionId: 'snap:open-pr:1', kind: 'open-pr' },
              },
            ],
            hero: { title: 'Delivered', summary: '1 repository · 1 pull request merged', time: '' },
            blocks: [],
          },
        },
      ],
    };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, done } });
    expect(html).toMatch(
      /<a class="obj-link pr-link" href="#" data-act="inside-action" data-action-id="snap:open-pr:1"[^>]*>#412<\/a>/,
    );
    expect(html).toContain('<span class="pr-status merged">merged</span>');
    // The row keeps its stamp: the link replaced the BUTTON, not the tail.
    expect(html).toContain('<span class="ev-time">09:58:01</span>');
    expect(html).not.toContain('>Open PR</button>');
  });

  it('dates each expanded pull-request row (fu2)', () => {
    const state = renderStateFor('ship');
    const ship: InsideStageView = {
      stageKey: 'ship',
      title: 'Ship',
      dot: 'done',
      clock: '',
      blurb: '',
      processes: [
        {
          id: 'pr',
          kind: 'pr',
          label: 'Pull request',
          status: 'pass',
          detail: '1 created',
          time: '10:04:00',
          evidence: {
            kind: 'prs',
            rows: [],
            open: 1,
            merged: 0,
            branches: [
              {
                repo: 'web',
                number: '#412',
                prState: 'open',
                steps: [{ label: 'PR opened', state: 'done' }],
                note: 'PR #412 was created in this ship run.',
                current: false,
                time: '10:04:12',
              },
            ],
          },
        },
      ],
    };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, ship } });
    expect(html).toContain('<span class="pr-time" title="pull-request step started 10:04:12">10:04:12</span>');
    // …and the process row itself states when the step ran, which a per-repo
    // row can never answer for the process as a whole.
    expect(html).toContain('<span class="op-time">10:04:00</span>');
  });

  it('renders the scope prefill process with AI chip, identity and token pill', () => {
    const state = renderStateFor('scope');
    const scope: InsideStageView = {
      stageKey: 'scope',
      title: 'Scope',
      dot: 'pend',
      clock: '',
      blurb: '',
      processes: [
        {
          id: 'prefill',
          kind: 'prefill',
          label: 'Ticket analysis',
          status: 'pass',
          detail: 'prompt improved · approach, repos and type suggested',
          execution: { provider: 'opencode', providerLabel: 'OpenCode', model: 'x', modelLabel: 'DeepSeek V4 Flash' },
          tokens: { state: 'measured', total: '4.8k' },
        },
        {
          id: 'worktrees',
          kind: 'worktrees',
          label: 'Worktrees',
          status: 'pass',
          evidence: {
            kind: 'rows',
            rows: [
              { status: 'pass', label: 'worktree', detail: 'web · karst/x', time: '10:03:01' },
            ],
          },
        },
      ],
    };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, scope } });
    expect(html).toContain('<span class="ai-mark">AI</span>');
    expect(html).toContain('OpenCode');
    expect(html).toContain('DeepSeek V4 Flash');
    expect(html).toContain('<span class="sigma">Σ</span>4.8k tok');
    expect(html).toContain('<span class="ev-time" title="started 10:03:01">10:03:01</span>');
  });

  it('renders merge rows with the PR state chip and the row timestamp', () => {
    const state = renderStateFor('ship');
    const ship: InsideStageView = {
      stageKey: 'ship',
      title: 'Ship',
      dot: 'wait',
      clock: '',
      blurb: '',
      processes: [
        {
          id: 'merge',
          kind: 'merge',
          label: 'Merge',
          status: 'wait',
          evidence: {
            kind: 'rows',
            rows: [
              { status: 'wait', label: '/web · open', detail: '#120 · not merged yet', prState: 'open', time: '09:40:02' },
              { status: 'pass', label: '/api · merged', detail: '#121', prState: 'merged', time: '09:42:00' },
            ],
          },
        },
      ],
    };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, ship } });
    expect(html).toContain('<span class="pr-status open">open</span>');
    expect(html).toContain('<span class="pr-status merged">merged</span>');
    expect(html).toContain('<span class="ev-time" title="started 09:40:02">09:40:02</span>');
  });

  it('renders the PR number as a link carrying the opaque action id', () => {
    const state = renderStateFor('ship');
    const ship: InsideStageView = {
      stageKey: 'ship',
      title: 'Ship',
      dot: 'run',
      clock: '',
      blurb: '',
      processes: [
        {
          id: 'pr',
          kind: 'pr',
          label: 'Pull request',
          status: 'run',
          evidence: {
            kind: 'prs',
            rows: [],
            open: 1,
            merged: 0,
            branches: [
              {
                repo: 'web',
                number: '#120',
                prState: 'open',
                steps: [{ label: 'description generated', state: 'done' }, { label: 'PR opened', state: 'done' }],
                note: 'PR #120 was created in this ship run.',
                current: true,
                action: { actionId: 'snapshot-1:action-7', kind: 'open-pr' },
              },
            ],
          },
        },
      ],
    };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, ship } });
    expect(html).toMatch(/<a class="obj-link pr-link" href="#" data-act="inside-action" data-action-id="snapshot-1:action-7"[^>]*>#120<\/a>/);
    expect(html).not.toContain('Open this pull request</button>');
  });

  it('dates gate rows and renders the passed-start check on a completed timeline', () => {
    const state = renderStateFor('uat');
    const uat: InsideStageView = {
      stageKey: 'uat',
      title: 'UAT',
      dot: 'done',
      clock: '',
      blurb: '',
      processes: [
        {
          id: 'gates',
          kind: 'gates',
          label: 'Gates',
          status: 'pass',
          detail: '6/6 command gates passed',
          count: '6',
          evidence: {
            kind: 'gates',
            rows: [
              { status: 'pass', label: 'test', detail: 'exit 0', repo: 'web', time: '10:04:12', duration: '4.2s' },
            ],
            passed: 1,
            failed: 0,
            skipped: 0,
          },
        },
      ],
    };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, uat } });
    expect(html).toContain('<span class="ev-time" title="started 10:04:12">10:04:12</span>');
    expect(html).toContain('<span class="count">6</span>');

    // The completed session's START row reads as a green check, not the
    // hollow grey node; the phase-time cell carries the short HH:MM.
    const implState = renderStateFor('impl');
    const impl: InsideStageView = {
      stageKey: 'impl',
      title: 'Implementation',
      dot: 'done',
      clock: '',
      blurb: '',
      processes: [
        {
          id: 'session',
          kind: 'session',
          label: 'Session',
          status: 'pass',
          evidence: {
            kind: 'timeline',
            rows: [
              { status: 'pass', label: 'started', time: '10:03:01', role: 'identity' },
              { status: 'note', label: 'plan', detail: 'reported · 10:06:14', time: '10:06', role: 'phase' },
              { status: 'pass', label: 'done', detail: 'implementation marked done · 10:22:43', time: '10:22', role: 'phase' },
            ],
          },
        },
      ],
    };
    const implHtml = renderWith({ ...implState, insideViews: { ...implState.insideViews, impl } });
    expect(implHtml).toMatch(/timeline-start[\s\S]*?<span class="glyph phase-status pass"/);
    expect(implHtml).not.toMatch(/timeline-start[\s\S]*?timeline-node start/);
    expect(implHtml).toContain('<span class="phase-time">10:06</span>');
    // The start stamp renders BESIDE the duration in the tail — never in the
    // identity chip's blue (869egdr2u-fu1).
    expect(implHtml).toMatch(/<span class="segment-window">10:03:01<\/span>/);
    expect(implHtml).not.toMatch(/agent-core">10:03:01/);
  });

  it('renders the full done receipt — hero, three blocks and the lines', () => {
    const state = renderStateFor('done');
    const done: InsideStageView = {
      stageKey: 'done',
      title: 'Done',
      dot: 'done',
      clock: '',
      blurb: '',
      processes: [
        {
          id: 'delivery-receipt',
          kind: 'delivery-receipt',
          label: 'Delivery receipt',
          status: 'pass',
          detail: '2 current pull requests merged',
          evidence: {
            kind: 'receipt',
            rows: [
              { status: 'pass', label: 'merged', detail: 'web #120', time: '09:58:01' },
            ],
            hero: { title: 'Delivered', summary: '2 repositories · 2 pull requests merged', time: 'completed 09:58:44' },
            blocks: [
              { label: 'Delivered', value: '2 pull requests merged', details: ['2 repositories', '3 commits created by ship'] },
              { label: 'Validated', value: 'UAT passed', details: ['14 final gate checks passed'] },
              { label: 'AI usage', value: '110.9k recorded tokens', details: [] },
            ],
          },
        },
      ],
    };
    const html = renderWith({ ...state, insideViews: { ...state.insideViews, done } });
    expect(html).toContain('<div class="done-hero">');
    expect(html).toContain('<div class="receipt-grid">');
    expect(html).toContain('<div class="receipt-label">Validated</div>');
    // ONE delivered header: the green hero. The process summary above it
    // ("Delivery receipt · 2 current pull requests merged") said the same
    // thing a second time and is gone (869egdr2u-fu2).
    expect(html).not.toContain('2 current pull requests merged');
    expect(html).not.toContain('>Delivery receipt<');
    expect(html).toMatch(/<span class="done-state"><span class="ev-time">09:58:01<\/span> · passed<\/span>/);
  });
});

// ── Artifacts render round trip (executed in a VM) ─────────────────────────
//
// The artifacts shelf/index/detail are LOCAL render + navigation inside the
// SAME webview (spec §7: no second Karst tab, no drawer, no split). These
// tests execute the real inline script and drive the real delegated click/key
// listeners with fake targets, asserting the surfaces actually swap.

/** Three artifacts in the host's semantic-priority order (previews = first 3). */
function artifactFixtures(): ArtifactSummary[] {
  return [
    {
      id: 'uat-report',
      stage: 'uat',
      kind: 'uat-report',
      title: 'UAT report',
      scope: null,
      summary: '3 passed · 0 failed',
      status: 'passed',
      freshness: 'current',
      origin: { kind: 'karst', core: 'codex' },
      versionCount: 1,
      currentVersionLabel: 'v1',
      createdAt: '2026-08-01T10:00:00.000Z',
      metrics: [
        { label: 'passed', value: '3' },
        { label: 'failed', value: '0' },
      ],
      gates: [
        { name: 'lint', exitCode: 0 },
        { name: 'test', exitCode: 0 },
      ],
      findings: [],
      prs: [],
      commits: [],
      resources: [{ name: 'uat-ticket-1.log', path: '/data/karst/artifacts/1/uat-ticket-1.log' }],
      detail: null,
    },
    {
      id: 'review',
      stage: 'review',
      kind: 'review',
      title: 'Review',
      scope: null,
      summary: '1 finding · 1 needs attention',
      status: 'attention',
      freshness: 'stale',
      origin: { kind: 'karst', core: null },
      versionCount: 1,
      currentVersionLabel: 'v1',
      createdAt: null,
      metrics: [{ label: 'high', value: '1' }],
      gates: [],
      findings: [
        {
          severity: 'high',
          title: 'Credential cache is not cleared',
          detail: 'The cache outlives the session.',
          repo: '/wt/web',
          file: 'src/auth.ts',
          line: 12,
        },
      ],
      prs: [],
      commits: [],
      resources: [],
      detail: null,
    },
    {
      id: 'ship-summary',
      stage: 'ship',
      kind: 'ship-summary',
      title: 'PR summary',
      scope: null,
      summary: '1 PR opened · 1 commit',
      status: 'passed',
      freshness: 'current',
      origin: { kind: 'karst', core: 'claude' },
      versionCount: 1,
      currentVersionLabel: 'v1',
      createdAt: '2026-08-01T11:00:00.000Z',
      metrics: [
        { label: 'repos', value: '1' },
        { label: 'PRs', value: '1' },
        { label: 'commits', value: '1' },
      ],
      gates: [],
      findings: [],
      prs: [
        {
          repo: '/wt/web',
          number: 42,
          url: 'https://github.com/o/r/pull/42',
          status: 'open',
        },
      ],
      commits: [{ repo: '/wt/web', sha: 'abc123', message: 'feat: passkey login' }],
      resources: [],
      detail: null,
    },
  ];
}

function stateWithArtifacts(): DashboardState {
  return { ...renderStateFor('uat'), artifacts: artifactFixtures() };
}

describe('artifacts render round trip (executed in a VM)', () => {
  it('renders the shelf only when artifacts exist, with the semantic count and at most 3 previews', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    expect(h.classesOf('artPanel')).toContain('hidden');
    expect(h.htmlOf('artifacts')).toBe('');

    h.receive({ type: 'state', state: stateWithArtifacts() });
    expect(h.classesOf('artPanel')).not.toContain('hidden');
    expect(h.textOf('artCount')).toBe('3');
    expect(h.textOf('artTotal')).toBe('3');
    const body = h.htmlOf('artifacts');
    // Exactly the 3 previews, each a real button opening its detail.
    expect(body.match(/data-art-open=/g)).toHaveLength(3);
    expect(body).toContain('data-art-open="uat-report"');
    expect(body).toContain('data-art-open="ship-summary"');
    // Raw filenames never reach the shelf (spec §4.4) — resources exist only
    // in the detail view.
    expect(body).not.toContain('uat-ticket-1.log');
    // The origin chip labels ride every card (Karst · Codex / Karst).
    expect(body).toContain('Karst · Codex');
    expect(body).toContain('Karst');
  });

  it('opens the index in-webview from View all, grouped by stage, and returns via Back', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithArtifacts() });
    h.click('[data-art]', { art: 'index' });
    // The dashboard body is hidden while the index surface is active.
    expect(h.bodyClasses).toContain('art-nav');
    const index = h.htmlOf('artView');
    expect(index).toContain('Artifacts · 3');
    expect(index).toContain('← Ticket');
    // Grouped by producing stage, empty groups omitted; one row per artifact.
    expect(index).toMatch(/UAT[\s\S]*data-art-open="uat-report"/);
    expect(index).toMatch(/Review[\s\S]*data-art-open="review"/);
    expect(index).toMatch(/Ship[\s\S]*data-art-open="ship-summary"/);
    // The index is not a file browser: semantic titles, never paths.
    expect(index).not.toContain('/data/karst/artifacts');

    h.click('[data-art]', { art: 'back' });
    expect(h.bodyClasses).not.toContain('art-nav');
    expect(h.htmlOf('artView')).toBe('');
  });

  it('opens a detail from the index, renders semantic-first with files last, and Esc returns to the index', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithArtifacts() });
    h.click('[data-art]', { art: 'index' });
    h.click('[data-art-open]', { artOpen: 'uat-report' });

    const detail = h.htmlOf('artView');
    // Back label answers the ORIGIN: from the index → back to Artifacts.
    expect(detail).toContain('← Artifacts');
    // Semantic result first: title, status word, metrics, gates.
    expect(detail).toContain('UAT report');
    expect(detail).toContain('Passed');
    expect(detail).toContain('3');
    expect(detail).toContain('lint');
    // Provenance: produced-by carries the origin chip.
    expect(detail).toContain('Produced by');
    expect(detail).toContain('Karst · Codex');
    // Files LAST, each with the explicit editor escape carrying id + index.
    const filesAt = detail.indexOf('Underlying files');
    const detailsAt = detail.indexOf('Details');
    expect(filesAt).toBeGreaterThan(detailsAt);
    expect(detail).toContain('uat-ticket-1.log');
    expect(detail).toMatch(/data-act="artifact-open-resource"[\s\S]*data-artifact-id="uat-report"[\s\S]*data-index="0"/);

    // Esc mirrors Back: detail(from index) → index.
    h.key('Escape');
    expect(h.htmlOf('artView')).toContain('Artifacts · 3');
    // And Esc on the index → ticket.
    h.key('Escape');
    expect(h.bodyClasses).not.toContain('art-nav');
  });

  it('a detail opened from the shelf returns to the TICKET, and its editor escape posts id + index only', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithArtifacts() });
    // From the ticket dashboard (artView is null): from = 'ticket'.
    h.click('[data-art-open]', { artOpen: 'uat-report' });
    expect(h.htmlOf('artView')).toContain('← Ticket');

    // Open in editor posts the artifact id + a resource INDEX — never a path.
    h.click('[data-act]', {
      act: 'artifact-open-resource',
      artifactId: 'uat-report',
      index: '0',
    });
    const open = h.posted.find((m) => (m as { type?: string }).type === 'artifact-open-resource');
    expect(open).toMatchObject({ type: 'artifact-open-resource', artifactId: 'uat-report', index: 0 });
    expect(JSON.stringify(open)).not.toContain('/data/karst');

    // Back from a ticket-origin detail returns to the ticket.
    h.click('[data-art]', { art: 'back' });
    expect(h.bodyClasses).not.toContain('art-nav');
  });
});

/**
 * The repaint's focus rule, run as the webview's OWN functions against element
 * doubles — a snapshot push once a second rebuilds every section by innerHTML
 * assignment, and an unrestored focus would take the keyboard away from the
 * user roughly as often as they could press a key.
 */
describe('focus across a repaint', () => {
  /** The webview's OWN focus helpers, run against element doubles. */
  function focusApi(doc: unknown) {
    const src = `${/function focusMark[\s\S]*?\n  \}/.exec(HYDRATED)?.[0]}\n${
      /function restoreFocus[\s\S]*?\n  \}/.exec(HYDRATED)?.[0]
    }`;
    if (src.includes('undefined')) throw new Error('focus helpers not found in the webview script');
    const run = new Function('document', `${src}\n;return { focusMark, restoreFocus };`) as (
      document: unknown,
    ) => { focusMark: () => unknown; restoreFocus: (m: unknown) => void };
    return run(doc);
  }

  interface FakeControl {
    id: string;
    act: string;
    selectionStart?: number;
    selectionEnd?: number;
    getAttribute(name: string): string | null;
    focus(): void;
    setSelectionRange?(start: number, end: number): void;
  }

  function control(id: string, act: string, focused: string[], caret?: number): FakeControl {
    const el: FakeControl = {
      id,
      act,
      getAttribute: (name) => (name === 'data-act' ? act || null : null),
      focus: () => focused.push(id || act),
    };
    if (caret !== undefined) {
      el.selectionStart = caret;
      el.selectionEnd = caret;
      el.setSelectionRange = (start, end) => {
        el.selectionStart = start;
        el.selectionEnd = end;
      };
    }
    return el;
  }

  function repaint(before: FakeControl[], after: FakeControl[], activeIndex: number) {
    let controls = before;
    const doc = {
      get activeElement() {
        return controls[activeIndex];
      },
      querySelectorAll: () => controls.filter((c) => c.act),
      getElementById: (id: string) => controls.find((c) => c.id === id) ?? null,
    };
    const api = focusApi(doc);
    const mark = api.focusMark();
    controls = after;
    api.restoreFocus(mark);
    return mark;
  }

  it('returns the keyboard to the same control after the page is rebuilt', () => {
    const focused: string[] = [];
    repaint(
      [control('', 'edit-ticket', focused), control('', 'inside-action', focused)],
      [control('', 'edit-ticket', focused), control('', 'inside-action', focused)],
      1,
    );
    expect(focused).toEqual(['inside-action']);
  });

  it('never moves focus onto a DIFFERENT control when the page shape changed', () => {
    const focused: string[] = [];
    repaint(
      [control('', 'edit-ticket', focused), control('', 'inside-action', focused)],
      [control('', 'edit-ticket', focused), control('', 'merge-pr', focused)],
      1,
    );
    expect(focused).toEqual([]);
  });

  it('restores a control that carries no action at all, with its caret', () => {
    // The services filter input is rebuilt with the panel and has no
    // `data-act`: a repaint mid-typing took the keyboard away and dropped the
    // caret, and a controls-only rule could not even see it.
    const focused: string[] = [];
    const after = control('srvFilter', '', focused, 0);
    repaint([control('srvFilter', '', focused, 3)], [after], 0);
    expect(focused).toEqual(['srvFilter']);
    expect(after.selectionStart).toBe(3);
  });
});

describe('deferring a live repaint', () => {
  function safeWith(opts: { busy?: boolean; selecting?: boolean }): boolean {
    const src = /function liveRepaintSafe[\s\S]*?\n  \}/.exec(HYDRATED)?.[0];
    if (!src) throw new Error('liveRepaintSafe not found in the webview script');
    const doc = { querySelector: (sel: string) => (opts.busy && sel.includes('#inside') ? {} : null) };
    const win = {
      getSelection: () => ({ rangeCount: opts.selecting ? 1 : 0, isCollapsed: !opts.selecting }),
    };
    const run = new Function('document', 'window', `${src}\n;return liveRepaintSafe();`) as (
      document: unknown,
      window: unknown,
    ) => boolean;
    return run(doc, win);
  }

  it('repaints when the user is doing nothing', () => {
    expect(safeWith({})).toBe(true);
  });

  it('holds while an inside action is in flight — its pending state is element-keyed', () => {
    expect(safeWith({ busy: true })).toBe(false);
  });

  it('holds while a text selection is being made — a repaint would collapse it', () => {
    expect(safeWith({ selecting: true })).toBe(false);
  });

  it('defers only a LIVE push; a push that carries news always renders', () => {
    expect(HTML).toMatch(/msg\.live && !liveRepaintSafe\(\)/);
    expect(HTML).toContain('if (!msg.live) worktreeStats = {};');
  });
});

describe('terminal console view (VM)', () => {
  it('opens the console surface and posts stage-log-request with the stage', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    expect(h.bodyClasses).toContain('term-nav');
    expect(h.htmlOf('termView')).toContain('Console · UAT');
    expect(h.posted).toContainEqual({ type: 'stage-log-request', stage: 'uat' });
    expect(h.terminals().length).toBe(1);
  });

  it('creates the terminal with convertEol, disableStdin and the token theme', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('review') });
    h.click('[data-act]', { act: 'console', console: 'review' });
    const t = h.terminals()[0]!;
    expect(t.opts.convertEol).toBe(true);
    expect(t.opts.disableStdin).toBe(true);
    expect(t.opened).toBe(true);
    expect(h.fits()[0]).toBeGreaterThanOrEqual(1);
  });

  it('writes the stage-log ok content into the live terminal', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: '\x1b[32mpass\x1b[0m\n', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('\x1b[32mpass\x1b[0m\n');
  });

  it('renders the error result in the view instead of writing to the terminal', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'error', message: 'The recorded log file is no longer available.' } });
    expect(h.terminals()[0]!.written).toBe('');
    expect(h.htmlOf('termHost')).toContain('no longer available');
  });

  it('drops a stale stage-log answer for a view that closed', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    h.key('Escape');
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: 'late', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('');
    expect(h.bodyClasses).not.toContain('term-nav');
  });

  it('disposes the terminal and restores the dashboard on Escape', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    expect(h.bodyClasses).toContain('term-nav');
    h.key('Escape');
    expect(h.terminals()[0]!.disposed).toBe(true);
    expect(h.bodyClasses).not.toContain('term-nav');
    expect(h.htmlOf('termView')).toBe('');
  });

  it('renders a Console button only for stages the host flags (view.console)', () => {
    const h = bootPreviewHarness();
    const state = renderStateFor('uat');
    // The uat render fixture carries `console: true` (added in Step 3).
    expect((state.insideViews as Record<string, { console?: boolean }>).uat!.console).toBe(true);
    h.receive({ type: 'state', state });
    expect(h.htmlOf('inside')).toContain('data-act="console"');
  });

  it('sits in the GATES row description area, icon-only, never in the header (869e7n906-fu1)', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    const inside = h.htmlOf('inside');
    // The console entry renders INSIDE the gates process row's markup — the
    // row whose summary is the gate run this console shows.
    expect(inside).toMatch(/data-proc-id="uat:gates"[\s\S]*?data-act="console"/);
    // ...and specifically inside the row's DESCRIPTION area (the op-detail
    // slot), not the header's meta cell where it used to sit — the meta cell
    // now contains plain clock text and nothing else.
    expect(inside).toMatch(/<span class="op-detail pass detail-console">[\s\S]*?data-act="console"/);
    expect(inside).toMatch(/<span class="inside-meta">[^<]+<\/span>/);
    // The label is an icon now: a Tabler svg rides inside the button, and the
    // word survives only as the matching aria-label/title pair (UI-R21/R24).
    expect(inside).toMatch(/data-act="console"[^>]*aria-label="View this stage's console output in the dashboard"[\s\S]*?<svg class="k-icon"/);
    expect(inside).not.toContain('>Console</button>');
    // The click still opens the console for the stage named on data-console —
    // the button's data-act/data-console pair is the one contract unchanged.
    h.click('[data-act]', { act: 'console', console: 'uat' });
    expect(h.bodyClasses).toContain('term-nav');
  });

  it('renders no Console button for a stage the host did not flag', () => {
    const h = bootPreviewHarness();
    const state = renderStateFor('uat');
    // Flip the flag off in the fixture: availability is HOST-derived, so the
    // webview must render no button when the view does not carry it.
    const noConsole = {
      ...state,
      insideViews: { ...state.insideViews, uat: { ...state.insideViews.uat, console: false } },
    };
    h.receive({ type: 'state', state: noConsole as DashboardState });
    expect(h.htmlOf('inside')).not.toContain('data-act="console"');
  });

  /**
   * Guard on the console surface's resting visibility.
   *
   * Be honest about what this is: a text assertion CANNOT render the cascade.
   * It cannot tell you the dashboard is visible — only that the rule which
   * stops the console box from covering it is still in the file, ordered so
   * that it wins. #termView starts with BOTH classes (class="termview hidden"),
   * and the console box is position:fixed;inset:0 with an opaque background:
   * if its own display:flex ever beat .hidden{display:none}, EVERY dashboard
   * open would show a blank full-screen box with the real page behind it —
   * "the html is there, but nothing is visible". .termview and .hidden have
   * EQUAL specificity, so source order decides; the override must sit after
   * the .termview block or it loses. Written after reproducing the defect in
   * a real webview; re-verifying the pixels needs F5.
   */
  it('never covers the dashboard at load — .hidden beats .termview display:flex', () => {
    expect(HTML).toMatch(/\.termview\{[^}]*display:flex/);
    expect(HTML).toMatch(/\.termview\.hidden\{display:none\}/);
    expect(HTML.indexOf('.termview.hidden')).toBeGreaterThan(HTML.indexOf('.termview{'));
  });
});
