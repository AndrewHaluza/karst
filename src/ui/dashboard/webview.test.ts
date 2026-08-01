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

  it('renders fix as the optional branch, never on the main line', () => {
    // The regression net for the flattening bug: fix must stay off the forward
    // path. The main-line nodes are built by mapping rail.main with an
    // interpolated data-stage; fix carries its own literal data-stage="fix" and
    // is gated behind `showFix`, so it can only be the branch, never a step.
    expect(HTML).toContain('data-stage="fix"');
    const showFixAt = HTML.search(/showFix\s*=/);
    const fixAt = HTML.indexOf('data-stage="fix"');
    expect(showFixAt).toBeGreaterThan(-1);
    expect(fixAt).toBeGreaterThan(showFixAt);
  });

  it('renders the fix branch status and paints a successful fix green', () => {
    expect(HTML).toContain('const fixClass = STEP_CLASS[rail.branch.status]');
    expect(HTML).toContain('fixnode ${fixClass}');
    expect(HTML).toContain("rail.branch.status === 'passed'");
    expect(HTML).toMatch(/\.loop \.fixnode\.done \.node\{[^}]*--stg-color:var\(--k-passed\)/);
  });

  it('hides the fix branch by default, behind an expand/collapse toggle', () => {
    // fix is a RETURN CHANNEL reached only on a failed gate, so it must not eat
    // graph space on a ticket that never looped. It rides behind a toggle and a
    // `collapsed` loop state instead of rendering unconditionally.
    expect(HTML).toContain('data-fixtoggle');
    expect(HTML).toContain('fixExpanded');
    expect(HTML).toMatch(/showFix\s*=/);
    // The collapse is CSS-driven, so a `.loop.collapsed` rule must exist to hide
    // the branch and reclaim the band's height.
    expect(HTML).toMatch(/\.loop\.collapsed\{/);
  });

  it('forces the fix branch open while the loop is armed', () => {
    // Armed = fix is running or a gate has failed. Hiding a live loop would hide
    // the very state the user needs, so `showFix` must key off `armed`.
    expect(HTML).toMatch(/showFix\s*=[^;]*\brail\.armed\b/);
  });

  it('persists the fix toggle beside the host state, like the selection', () => {
    // Same reasoning as `sel`: it is a webview concern, so it rides alongside the
    // host snapshot in setState and is restored on reload.
    expect(HTML).toMatch(/setState\(\{ state:[^}]*fixExpanded/);
    expect(HTML).toMatch(/fixExpanded\s*=\s*[^;]*restored/);
  });

  it('makes every stage node a real button, so the rail is keyboard-reachable', () => {
    expect(HTML).toMatch(/<button type="button" class="node"/);
    expect(HTML).toContain('aria-pressed');
  });

  it('names every rail/fix node for a screen reader, not just a hover title', () => {
    // Icon-only (a glyph or a spinner character, never text) — aria-label and
    // title must carry the SAME string (UI-R21/R24).
    expect(HTML).toMatch(/aria-label="\$\{nodeName\}" title="\$\{nodeName\}"/);
    expect(HTML).toMatch(/aria-label="\$\{fixNodeName\}" title="\$\{fixNodeName\}"/);
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
  it('keeps the rail scroll container padded, so the ring is not sliced off', () => {
    // overflow-x:auto forces overflow-y to compute to auto, so .railwrap clips
    // vertically too — and the nodes sit flush against its content top. Without
    // padding-top the selection ring (4px out) and focus outline (5px out) were
    // cut off flat and the selected node rendered as an open arc.
    // --k-space-3 is 6px (DESIGN-SYSTEM.md §2.2), which clears the 5px reach —
    // padding-top is now the token, not a raw literal (UI-R04).
    expect(HTML).toMatch(/\.railwrap\{[^}]*overflow-x:auto[^}]*padding-top:var\(--k-space-3\)/);
  });

  it('keeps the rail mask opaque, because it is a mask and not just a tint', () => {
    // The nodes fill with the surface token to mask the connector running
    // under them, and the selection ring's inner gap is painted in it. A
    // `transparent` fallback made both masks stop masking on any theme without
    // editorWidget.background: the rail drew straight through the node.
    // --k-surface (designTokens.ts) IS that value — no local --panel-bg
    // re-declaration remains to drift from it (UI-R05).
    expect(HTML).not.toMatch(/--panel-bg:/);
    expect(HTML).toContain('.st .node{width:var(--k-control-h-lg);height:var(--k-control-h-lg);border-radius:var(--k-radius-circle);');
    expect(HTML).toMatch(/\.st \.node\{[\s\S]*?background:var\(--k-surface\)/);
  });

  it('separates the focus outline from the selection ring by colour', () => {
    // Both were --st-sel at overlapping radii (ring 0–4px, outline 3–5px), so
    // they fused into one slab and focus was invisible on the selected node.
    // Now token-built (UI-R04): outline width/offset are calc() combos of the
    // base --k-focus-w/--k-focus-offset tokens, doubled off the standard
    // 1px/1px every other focusable in this file uses.
    expect(HTML).toMatch(/\.st \.node:focus-visible\{outline:calc\(var\(--k-focus-w\) \* 2\) solid var\(--k-focus\)/);
    expect(HTML).toMatch(/\.fixnode \.node:focus-visible\{outline:calc\(var\(--k-focus-w\) \* 2\) solid var\(--k-focus\)/);
    expect(HTML, 'the selection ring is what keeps --k-series-2').toContain('var(--k-series-2)');
    expect(HTML).not.toMatch(/--st-sel/);
  });

  it('pulses the armed fix node by scale only, never opacity', () => {
    // That node sits ON the bracket's bottom edge and its fill is what masks it;
    // fading it let the dashed bracket show through the fill and the ring.
    const kf = HTML.match(/@keyframes node-pulse\{[^}]*\}[^}]*\}/)?.[0] ?? '';
    expect(kf).toContain('scale(1.09)');
    expect(kf, 'opacity in node-pulse unmasks the bracket underneath').not.toContain('opacity');
  });

  it('never lifts a rail column into its own stacking context', () => {
    // .st is position:relative with z-index:auto ON PURPOSE: that keeps every
    // .seg (z-index:0) and every .node (z-index:1) in the one root stacking
    // context, so each node — ring and outline included — paints above every
    // connector. Giving .st a z-index makes it a stacking context, which drags
    // its own .seg up with it and stabs the PREVIOUS node in the rail.
    expect(HTML).not.toMatch(/\.st\.sel[^{]*\{[^}]*z-index/);
    expect(HTML).not.toMatch(/\.st:focus-within[^{]*\{[^}]*z-index/);
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
    const ALLOWED = ['560px', '72px', '640px', '82px', '74px', '4px', '180px', '288px', '6px', '400px'];
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
      /aria-label="\$\{nodeName\}" title="\$\{nodeName\}"/, // rail node
      /aria-label="\$\{fixNodeName\}" title="\$\{fixNodeName\}"/, // fix node
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
    // keypill, fixtoggle, approach .aid / .none, and the PR status pill all
    // build on one shared shape instead of four divergent bespoke radii.
    expect(HTML).toMatch(/class="k-chip keypill/);
    expect(HTML).toMatch(/class="k-chip fixtoggle/);
    expect(HTML).toMatch(/class="k-chip aid"/);
    expect(HTML).toMatch(/class="k-chip none"/);
    expect(HTML).toMatch(/class="k-chip pst pst-/);
  });

  it('resolves the three purples (selection ring, merged badge, merged timestamp) to one token', () => {
    expect(HTML).not.toMatch(/#8957e5|#a371f7|#8a63d2|#c297ff/);
    expect(HTML).toMatch(/\.st\.sel \.node\{box-shadow:[^}]*var\(--k-series-2\)/);
    expect(HTML).toMatch(/\.pr \.pst-merged\{background:var\(--k-series-2\)/);
    expect(HTML).toMatch(/\.pmeta \.pmerged\{color:var\(--k-series-2\)/);
  });

  it('gives every native <summary> disclosure its own focus-visible ring', () => {
    // <summary> is neither a <button> nor an <a>/<input>, so the primitives'
    // generic :focus-visible rule never reaches it.
    expect(HTML).toMatch(/\.approach > summary:focus-visible \.aid\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/);
    expect(HTML).toMatch(/\.mgd summary:focus-visible\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/);
    expect(HTML).toMatch(/\.pcms summary:focus-visible\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/);
  });

  it('makes the inert local key pill visibly non-interactive, never a real control', () => {
    expect(HTML).toMatch(/class="k-chip keypill local"/);
    expect(HTML).toMatch(/\.dhead \.keypill\.local\{border-style:dashed;color:var\(--k-text-dim\);\s*\n\s*background:transparent;cursor:default\}/);
  });

  it('leaves stop-driver unreachable from the rendered UI (tracked, not silently wired)', () => {
    // No control in this file posts stop-driver — confirmed here so a future
    // edit does not accidentally wire it up without updating the host/tests
    // that assume it stays unreachable. See the remediation report for why
    // this is left as-is rather than invented a control for it.
    expect(HTML).not.toMatch(/data-act="stop-driver"/);
  });

});
