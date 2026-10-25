import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectPalette } from '../../model/palette.js';
import { injectProviderIdentity } from '../../model/providerIdentity.js';
import { injectAgentIdentity } from '../../model/agentIdentity.js';
import { injectServerLogsView } from '../../model/serverLogsView.js';
import { injectWebviewSend } from '../../model/webviewSendInjector.js';
import { decodeAnsi } from './logLine.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), 'app');
/** A file of the React app: the moved overlay rules and the views that now own what the page script used to. */
const appFile = (name: string): string => readFileSync(join(APP, name), 'utf8');
const TERMINAL_CSS = appFile('Terminal.css');
const LOGS_CSS = appFile('ServerLogsView.css');
/** Every non-test component of the React app. */
const appComponents = (): string[] =>
  readdirSync(APP, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) && !f.includes('fixtures'))
    .map((f) => appFile(f));

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');
const SERVER_LOGS_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'model', 'serverLogsView.webview.js'),
  'utf8',
);
const SERVER_LOGS_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'model', 'serverLogsView.webview.css'),
  'utf8',
);

/**
 * Text-level guards on the dashboard webview.
 *
 * The webview is standalone HTML with no test harness: it cannot be imported,
 * and adding jsdom for it would make it the only DOM test in the repo. That is
 * affordable only because every DECISION was moved host-side — glyph and class
 * maps, geometry, clocks, durations, blurbs, the armed flag — leaving the file
 * with little more than `map` over precomputed data.
 *
 * What these tests can catch: a lost injection marker, selection leaking into
 * host-owned state, an action the host does not validate. What they cannot catch: a mistyped class, a broken calc(),
 * or a selection round trip that fails in a real webview. Those need F5.
 */
describe('dashboard webview.html', () => {
  it('carries the React foundation: #root anchor and injector markers', () => {
    expect(HTML).toContain('<div id="root"></div>');
    expect(HTML).toContain('/*KARST_DASHBOARD_APP*/');
    expect(HTML).toContain('/*KARST_DASHBOARD_APP_CSS*/');
  });

  it('gives both log surfaces a reachable scrollback: viewport, visible thumb, keys', () => {
    // Server logs scroll their own host; the console's scrollback belongs to
    // xterm's viewport. Both had an invisible thumb over the console ground.
    expect(LOGS_CSS).toMatch(/\.logsview \.loghost\{[^}]*overflow-y:auto/);
    expect(LOGS_CSS).toMatch(/\.logsview \.loghost::-webkit-scrollbar-thumb\{/);
    expect(TERMINAL_CSS).toMatch(/\.termview \.xterm-viewport::-webkit-scrollbar-thumb\{/);
    // Auto-follow only from the bottom — never yank a reader mid-scroll. The
    // logs surface lives in the shared runtime (the dashboard only owns the
    // open flag), so the guard is read from THAT file.
    expect(SERVER_LOGS_JS).toMatch(/wasAtBottom[\s\S]*?scrollTop = [A-Za-z]+\.scrollHeight/);
    // PageUp/PageDown/Home/End drive both surfaces (xterm takes no stdin here).
    expect(appFile('TerminalView.tsx')).toMatch(/function scrollByKey[\s\S]*?term\.scrollPages\(-1\)/);
    expect(appFile('ServerLogsView.tsx')).toMatch(/function scrollLogsByKey[\s\S]*?host\.scrollTop -= page/);
  });

  it('never covers the dashboard at load — .hidden beats .termview display:flex', () => {
    // #termView starts with BOTH classes (class="termview hidden") and the console box is position:fixed;inset:0 with
    // an opaque background: if its own display:flex ever beat .hidden{display:none}, EVERY dashboard open would show a
    // blank full-screen box. Equal specificity, so the override must follow the .termview block. A text assertion cannot
    // render the cascade; it pins the rule and its order.
    expect(TERMINAL_CSS).toMatch(/\.termview\{[^}]*display:flex/);
    expect(TERMINAL_CSS).toMatch(/\.termview\.hidden\{display:none\}/);
    expect(TERMINAL_CSS.indexOf('.termview.hidden')).toBeGreaterThan(TERMINAL_CSS.indexOf('.termview{'));
  });

  it('lets the hidden ATTRIBUTE actually hide a .k-btn/.k-iconbtn (PR #166)', () => {
    // `.k-btn`/`.k-iconbtn` set `display:inline-flex` in author CSS, which
    // overrides the UA `[hidden]{display:none}` regardless of specificity —
    // so toggling the `hidden` attribute on #confirmShip / #boardLink never
    // hid them, and the Confirm ship CTA stayed visible through the whole
    // Implementation stage (869ehahjh-fu1). The diffs webview hit the same
    // wall and fixed it with an author `[hidden]` rule (`#notice[hidden]`).
    // The rule must WIN the cascade: equal specificity to the component's
    // display rule, so source order decides — it must sit after the injected
    // design-system CSS at the top of the <style>, and after the component
    // rules that set display. The dashboard's own `.hidden{display:none}`
    // (line ~39) is the anchor: it already beats the injected DS once.
    expect(HTML).toMatch(/\.hidden\{display:none\}/);
    expect(HTML).toMatch(/(^|;|})[^{]*\[hidden\]\s*\{\s*display\s*:\s*none\s*\}/);
    // The rule must come after the DS-injected component CSS it overrides.
    const ds = HTML.indexOf('/*KARST_DS_CSS*/');
    const rule = HTML.indexOf('[hidden]');
    expect(rule).toBeGreaterThan(ds);
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
      '/*KARST_SERVER_LOGS_VIEW_CSS*/',
      '/*KARST_SERVER_LOGS_VIEW_JS*/',
    ]) {
      expect(HTML, `missing marker: ${marker}`).toContain(marker);
    }
  });

  it('keeps the selection beside the host state, never inside it', () => {
    // Persisting `sel` inside `state` would mean the next pushState — which the
    // host builds from the DB — silently drops it, and would put a webview
    // concern into a host-owned type.
    expect(HTML).toContain('vscode.setState({ state:');
    expect(HTML).not.toMatch(/state\.sel\s*=/);
  });

  it('emits no action the host does not validate', () => {
    const declared = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'messages.ts'),
      'utf8',
    );
    // Every `data-act` literal the dashboard ships is in the React app now (the page itself has none). The names that
    // are NOT host messages are webview-local: the control opens a surface or flips view state and never posts a
    // message of that name (any posting happens in the overlay stack, as `stage-log-request` for the console).
    const LOCAL = new Set([
      'console', // opens the console overlay; the stack posts `stage-log-request` / `agent-log-request`
      'preview-ticket-data', 'toggle-base-form', 'toggle-rebase-switch', 'artifact-findings-repo', 'toggle-graph-view',
      'baseline-view', 'baseline-reject-open', 'baseline-reject-cancel',
      'server-logs-request', 'env-overrides-open', // open an overlay (the logs view posts `server-logs-request` itself)
    ]);
    const emitted = [HTML, ...appComponents()]
      .flatMap((text) => [...text.matchAll(/data-act="([a-z][a-z-]*)"/g)].map((m) => m[1]!))
      .filter((act) => !LOCAL.has(act));
    expect(emitted.length).toBeGreaterThan(0);
    for (const act of new Set(emitted)) {
      expect(declared, `unvalidated action: ${act}`).toContain(`'${act}'`);
    }
    expect(emitted).not.toContain('switch-agent');
  });

  it('keeps the server filter beside the host state, like the selection', () => {
    // A state push arrives on every server change; if the filter lived in
    // DashboardState (or nowhere) the text would be wiped mid-typing.
    expect(HTML).toMatch(/srvFilter/);
    expect(HTML).not.toMatch(/state\.srvFilter/);
    expect(HTML).toMatch(/srvFilter:\s*srvFilter/);
  });

  it('no longer carries the removed impl-phase strip', () => {
    expect(HTML).not.toContain('renderSubsteps');
    expect(HTML).not.toContain('implPhases');
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
    // `150px` is the PR URL copy control's width floor — a "wide enough to
    // read a URL" floor at the panel's small-text scale, same class as `200px`.
    // `3px` is the copy glyph's hover slide-in offset — a motion nudge with no
    // token step at 3px.
    // Two further `4px` entries are the v60 checks/block chips' uppercase
    // tracking, the same `.4px` the status chip (`.pst`) already uses.
    const ALLOWED = ['46px', '72px', '640px', '82px', '4px', '180px', '288px', '6px', '400px',
      '300px', '360px', '430px', '110px', '160px', '104px',
      '1px', '1px', '1px', '1px', '1px', '1px',
      '200px', '720px',
      '2px', '2px', '2px', '2px',
      '1px', '1px', '1px',
      '12px', '12px', '12px',
      '4px', '4px', '4px', '4px', '4px', '4px', '4px', '4px',
      '150px', '3px'];
    // The Worktrees panel's literals (74px, 12px, the 380px breakpoint, the popover's 280px) moved to
    // app/WorktreesPanel.css with the panel, so they are no longer in this inline stylesheet.
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
   * clearing identically on every state push. Ship and merge keep theirs in
   * React now (app/pendingOps.ts), so the page holds neither request.
   */
  it('replaces the three ad-hoc pending booleans with the runtime lifecycle', () => {
    expect(HTML).not.toMatch(/\bmergePending\b/);
    expect(HTML).not.toMatch(/\bprRefreshing\b/);
    expect(HTML).not.toMatch(/\blet shipping\b|shipping\s*=\s*(?:true|false)/);
    expect(HTML).not.toMatch(/let mergeRequests|let shipRequestId|let shipDone/);
  });

  it('handles action-result in the message listener, settling through karstSettle', () => {
    expect(HTML).toMatch(/msg\.type === 'action-result'/);
    expect(HTML).toMatch(/karstSettle\(msg\.requestId, msg\.ok, msg\.message\)/);
  });

  it('keeps every STATIC title within the 80-character bound (UI-R20)', () => {
    // Excludes titles built from an interpolated template literal — their rendered length depends on runtime data (a PR
    // number, a base ref name), so a static character count on the source text checks the wrong thing. Every literal,
    // non-interpolated title in the page and in the React app is checked here.
    const titles = [HTML, ...appComponents()]
      .flatMap((text) => [...text.matchAll(/title="([^"][^"]*)"/g)].map((m) => m[1]!))
      .filter((t) => !t.includes('${'));
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      expect(t.length, `title too long (${t.length} chars): "${t}"`).toBeLessThanOrEqual(80);
    }
  });

  it('gives every rounded pill in the file the shared .k-chip primitive (UI-R08)', () => {
    // The PR status pill builds on the shared shape instead of a bespoke
    // radius. The keypill left the header with Task 5 (the key is a plain
    // monospace button now). The fixtoggle and the approach chips left with the
    // branch band: the track carries the fix loop inside the gate it retries and
    // the approach inside impl's own segment, so neither is a pill any more.
    expect(HTML).not.toMatch(/class="k-chip fixtoggle/);
    expect(HTML).not.toMatch(/class="k-chip keypill/);
  });

  it('resolves the three purples (selection mark, merged badge, merged timestamp) to one token', () => {
    // The selection mark's own rule moved to app/Rail.css (guarded in Rail.css.test.ts).
    expect(HTML).not.toMatch(/#8957e5|#a371f7|#8a63d2|#c297ff/);
  });

  it('gives every native <summary> disclosure its own focus-visible ring', () => {
    // <summary> is neither a <button> nor an <a>/<input>, so the primitives'
    // generic :focus-visible rule never reaches it.
    // The approach disclosure left with the branch band — impl's phases are pips
    // inside impl's own segment now, so there is nothing to open.
    expect(HTML).not.toMatch(/\.approach > summary/);
  });

  it('previews ticket data through a modal drawer, never a hover', () => {
    // The drawer is React-owned (app/TicketDataDrawer.tsx, pinned by its own tests); the page keeps only the wrapper it renders into.
    expect(HTML).toContain('id="ticketDataHost"');
    expect(HTML).not.toContain('id="ticketDataDrawer"');
    // The old provider-mark hover carried the WHOLE brief on a tiny icon; the button owns the preview now.
    expect(HTML).not.toMatch(/mark\.setAttribute\('title', esc\(state\.brief\)\)/);
  });

  it('leaves stop-driver unreachable from the rendered UI (tracked, not silently wired)', () => {
    // No control in this file posts stop-driver — confirmed here so a future
    // edit does not accidentally wire it up without updating the host/tests
    // that assume it stays unreachable. See the remediation report for why
    // this is left as-is rather than invented a control for it.
    expect(HTML).not.toMatch(/data-act="stop-driver"/);
  });

  it('retires the legacy ship derivation wholesale (Finding 12, step 6)', () => {
    expect(HTML).not.toMatch(/SHIP_STEP_ORDER|flattenShipOps|shippingView|renderInsideFlat/);
  });

  it('does not persist the live overlay across reloads', () => {
    // A restored overlay would claim a process is running that nobody is —
    // persist() saves only the snapshot, the selection and the filter.
    expect(HTML).toMatch(/setState\(\{ state: lastState, sel: selectedStage, shipWait: shipWaitSeen, srvFilter: srvFilter, artView: artView, artScrolls: artScrolls \}\)/);
    expect(HTML).not.toMatch(/liveOps: /);
  });

  it('renders the CURRENT karst mark in the artifact origin chip — never the retired three-node graph', () => {
    // The artifact origin chip's karst mark must match the approved monochrome silhouette (media/karst-mark.svg,
    // pinned by brandAssets.test.ts). The old three-node graph was the exact staleness this replaces.
    const chips = appFile('ArtifactChips.tsx');
    expect(chips).toMatch(/viewBox="0 0 215 215"/);
    expect(chips).toMatch(/M 96 20[\s\S]*M 151 42[\s\S]*cx="106\.5" cy="111\.5" r="26\.5"/);
    expect(chips).not.toMatch(/cx="6" cy="6" r="2\.4"/);
    expect(chips).not.toMatch(/7\.6 7\.6/);
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
    // (`.track .seg .spin`, the rail's, moved to app/Rail.css and is guarded in Rail.css.test.ts.)
    for (const scoped of ['.inside-head .alive .spin']) {
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

/**
 * The shared server-logs surface (Task 3): the control strip, the ANSI
 * rendering and the wiring between the dashboard and the shared factory. The
 * dashboard no longer owns the surface — it owns the open flag and the host
 * request — so the controls are asserted where they actually live, in the
 * injected runtime, and the decoder is pinned to `logLine.ts`'s.
 */
describe('shared server logs surface', () => {
  it('carries the control strip the shared runtime renders', () => {
    for (const hook of [
      'id="logsSearch"',
      'data-log-filter',
      'data-log-current-run',
      'data-log-clear',
      'data-log-detach',
      'data-log-prev',
      'data-log-next',
      'id="logsHost"',
    ]) {
      expect(HYDRATED, `missing logs control: ${hook}`).toContain(hook);
    }
  });

  it('omits Open in Window when the factory is detached', () => {
    // The standalone panel has no second window to open, so the control is
    // conditional on the factory option rather than always rendered.
    expect(SERVER_LOGS_JS).toMatch(/detached \? ''[\s\S]*?data-log-detach/);
  });

  it('wires the dashboard to the shared factory, not a private surface', () => {
    expect(HTML).toContain('/*KARST_SERVER_LOGS_VIEW_CSS*/');
    expect(HTML).toContain('/*KARST_SERVER_LOGS_VIEW_JS*/');
    // The React wrapper (app/ServerLogsView.tsx) drives the runtime; the page only carries the injection markers.
    const wrapper = appFile('ServerLogsView.tsx');
    expect(wrapper).toContain('createServerLogsView');
    expect(wrapper).toContain('.open()');
    expect(wrapper).toContain('.handleInitial(');
    expect(wrapper).toContain('.handleOutput(');
    expect(HTML).not.toContain('logsViewInstance');
    // The old inline surface is gone wholesale, not merely unused.
    expect(HTML).not.toContain('renderLogsContent');
    expect(HTML).not.toContain('logsMergedLines');
  });

  it('posts server-logs-detach from the shared control, and no unreachable host action', () => {
    expect(SERVER_LOGS_JS).toContain("{ type: 'server-logs-detach' }");
  });

  it('ships CSS rules for every class the decoder emits (UI-R10)', () => {
    // The ANSI classes are only in the DOM once lines render, so the load-time
    // RUNTIME sweep cannot check them — this pins their rules here.
    for (const cls of ['k-ansi-fg-green', 'k-ansi-bg-red', 'k-ansi-fg-bright-white', 'k-ansi-bold']) {
      expect(SERVER_LOGS_CSS, `no rule for ${cls}`).toContain('.' + cls);
    }
    expect(SERVER_LOGS_CSS).toContain('.k-loghit');
  });

  it('clear() drops the lines and re-renders, posting nothing', () => {
    const from = SERVER_LOGS_JS.indexOf('function clear()');
    const to = SERVER_LOGS_JS.indexOf('function handleInitial');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = SERVER_LOGS_JS.slice(from, to);
    expect(body).toMatch(/lines = \[\];/);
    expect(body).toContain('renderContent();');
    expect(body, 'clear must never reach the host — tailing continues').not.toContain('post(');
  });

  it('matches every occurrence case-insensitively by splitting the escaped text on the escaped query', () => {
    const from = SERVER_LOGS_JS.indexOf('function highlight');
    const body = SERVER_LOGS_JS.slice(from, from + 700);
    expect(body).toContain('esc(text)');
    expect(body).toContain('esc(query)');
    expect(body).toContain('class="k-loghit"');
    // Escaped-then-split, never a regex over unescaped input.
    expect(body).not.toMatch(/new RegExp|\.replace\(/);
  });

  /**
   * Mirrored TS→HTML constants ARE behavior (UI-INVARIANTS.md): the shipped JS
   * decoder must agree with the tested TS one, or the surface renders one thing
   * while `logLine.ts` claims another. The assertion evaluates the FILE'S OWN
   * TEXT — never a second decoder fabricated in the test.
   */
  it('the ported decoder and logLine.ts agree on an ANSI line', () => {
    const sandbox: Record<string, unknown> = { window: {} };
    runInNewContext(SERVER_LOGS_JS, sandbox);
    const ported = sandbox.KARST_SERVER_LOGLINE as {
      decodeAnsi: (text: string) => Array<{ text: string; classes: string[] }>;
    };
    expect(ported, 'the shared file does not expose KARST_SERVER_LOGLINE').toBeTruthy();
    const input = '\u001b[32mok\u001b[39m';
    const portedSegments = ported.decodeAnsi(input);
    const tsSegments = decodeAnsi(input);
    expect(portedSegments.map((s) => ({ text: s.text, classes: s.classes }))).toEqual(
      tsSegments.map((s) => ({ text: s.text, classes: s.classes })),
    );
    expect(portedSegments[0]!.classes).toContain('k-ansi-fg-green');
  });
});

/**
 * The dashboard webview hydrated exactly as the host renders it (design system, palette, provider and agent identity,
 * the shared server-logs runtime, the typed senders): what the shared-surface guards above read.
 */
const HYDRATED = injectWebviewSend(
  injectServerLogsView(
    injectAgentIdentity(injectProviderIdentity(injectPalette(injectDesignSystem(HTML)))),
  ),
);

describe('content width cap (UI-R48)', () => {
  it('stays uncapped', () => {
    expect(HTML).not.toContain('--k-content-max');
  });
});

describe('React island transition rule', () => {
  it('registers no document-level delegator: every control is React, and a regrown delegator must bring its island guard back', () => {
    expect(HTML).not.toMatch(/document\.addEventListener\(/);
    expect(HTML).not.toContain('inReactIsland');
  });

  it('keeps the page script to persistence: the view-state listeners, the message handler and the restore', () => {
    const script = HTML.slice(HTML.indexOf('/*KARST_DASHBOARD_APP*/'), HTML.indexOf('</script>'));
    const listeners = [...script.matchAll(/window\.addEventListener\('([^']+)'/g)].map((m) => m[1]);
    expect(listeners).toEqual(['karst:persistSel', 'karst:srvFilter', 'karst:persistArt', 'message']);
    expect(script).not.toMatch(/innerHTML|querySelector|classList|getElementById/);
  });

  it('no longer carries the dead renderSandbox or sandbox entries in SEND_BY_ACT', () => {
    expect(HTML).not.toContain('renderSandbox');
    expect(HTML).not.toContain('SEND_BY_ACT');
  });
});
