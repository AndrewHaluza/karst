import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
import { renderStateFor } from './renderFixtures.js';
import type { DashboardState } from './state.js';
import type { ArtifactSummary } from '../../model/artifacts.js';

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
    expect(HTML).toMatch(/\.logsview \.loghost\{[^}]*overflow-y:auto/);
    expect(HTML).toMatch(/\.logsview \.loghost::-webkit-scrollbar-thumb\{/);
    expect(HTML).toMatch(/\.termview \.xterm-viewport::-webkit-scrollbar-thumb\{/);
    // Auto-follow only from the bottom — never yank a reader mid-scroll. The
    // logs surface lives in the shared runtime now (the dashboard only owns the
    // open flag), so the guard is read from THAT file.
    expect(SERVER_LOGS_JS).toMatch(/wasAtBottom[\s\S]*?scrollTop = [A-Za-z]+\.scrollHeight/);
    // PageUp/PageDown/Home/End drive both surfaces (xterm takes no stdin here).
    expect(HTML).toMatch(/function scrollTermByKey\(e\)[\s\S]*?term\.scrollPages\(-1\)/);
    expect(HTML).toMatch(/function scrollLogsByKey\(e\)[\s\S]*?host\.scrollTop -= page/);
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
    // Literal names only. The data-act values are static strings declared below. `preview-ticket-data`
    // is the ONE local-only action: the delegated handler answers it in an explicit
    // branch BEFORE the posting path, so it never becomes a host message (same
    // carve-out as the constant CONSOLE_ACT, which reads `data-console`).
    // `toggle-base-form`/`toggle-rebase-switch` (§ per-repo base branch — live
    // change) are the same carve-out: opening the confirm form and flipping
    // its rebase switch are pure client-side draft state, answered in their
    // own branch before the posting path — only `change-base-ref` itself,
    // posted on submit, is a real host message.
    // `toggle-graph-view` flips the graph block between ledger and DAG strip
    // locally — view state only, no host round trip.
    // `artifact-findings-repo` (§ findings severity ramp) filters findings
    // cards client-side in the Artifacts panel — no host round trip.
    const emitted = [...HTML.matchAll(/data-act="([^"$]+)"/g)]
      .map((m) => m[1]!)
      .filter(
        (act) => act !== 'preview-ticket-data'
          && act !== 'toggle-base-form'
          && act !== 'toggle-rebase-switch'
          && act !== 'artifact-findings-repo'
          && act !== 'toggle-graph-view',
      );
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

  it('routes every OTHER mutating/handoff control through the pending runtime with a requestId', () => {
    // edit-ticket, create-follow-up-ticket, open-worktree-terminal,
    // open-worktree-folder, resolve-conflicts, resume-ticket, stop-server,
    // restart-server, start-server, spin-servers (panel), open-server, open-pr,
    // open-ticket-link, open-stage-log, switch-agent — all fall through the
    // generic branch of the delegated click handler, which begins pending and
    // attaches a requestId before posting.
    const generic = HTML.slice(
      HTML.indexOf('// Every other posting control settles'),
      HTML.indexOf("window.addEventListener('resize'"),
    );
    expect(generic).toMatch(/karstIsPending\(btn\)/);
    expect(generic).toMatch(/karstBeginPending\(btn, requestId\)/);
    // The message shape is chosen by the typed SEND_BY_ACT map, whose values
    // are karstSend.* senders from webviewSend.ts — never a raw post.
    expect(generic).toMatch(/SEND_BY_ACT\[act\]/);
    expect(generic).toMatch(/send\(btn, requestId\)/);
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
    expect(HTML).toMatch(/Optimistic feedback for the copy button \(UI-R15\)/);
    // Called from exactly one place, behind the copy marker — never from a mutation wired to a real terminal
    // outcome (ship, merge and refresh are React's now and flash through their own state).
    expect(HTML).toMatch(/if \(btn\.hasAttribute\('data-copy'\)\) flashCopied\(btn\);/);
    expect(HTML.match(/flashCopied\(/g)).toHaveLength(2);
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
    // The trigger button is React-owned (app/TicketIdentity.tsx); the page keeps the drawer and opens it on `karst:openTicketData`.
    expect(HTML).toContain("window.addEventListener('karst:openTicketData'");
    // The drawer follows modal-dialog semantics (DESIGN-SYSTEM.md §11.15).
    expect(HTML).toMatch(/id="ticketDataDrawer"[^>]*role="dialog"/);
    expect(HTML).toMatch(/id="ticketDataDrawer"[^>]*aria-modal="true"/);
    expect(HTML).toMatch(/id="ticketDataDrawer"[^>]*aria-labelledby="ticketDataTitle"/);
    expect(HTML).toMatch(/id="ticketDataClose"[^>]*title="Close ticket data preview"/);
    expect(HTML).toMatch(/id="ticketDataClose"[^>]*aria-label="Close ticket data preview"/);
    // The body is composed as TEXT (brief verbatim, else the ticket's own
    // heading + prompt): the renderer reads state via ticketDataText, never an
    // interpolated literal, and never innerHTML — brief/description are
    // user/provider-authored data that can never inject.
    expect(HTML).toContain('body.textContent = ticketDataText(state);');
    expect(HTML).toContain('function ticketDataText(state)');
    expect(HTML).not.toMatch(/ticketDataBody[^;]*innerHTML/);
    expect(HTML).not.toContain("el('ticketDataBody').innerHTML");
    // The old provider-mark hover carried the WHOLE brief on a tiny icon; the
    // button owns the preview now, so the giant title tooltip is gone.
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
    // The artifact origin chip's karst mark must match the approved
    // monochrome silhouette (media/karst-mark.svg, pinned by brandAssets.test.ts).
    // The old three-node graph was the exact staleness this replaces — a copy
    // that drifted from the approved asset and read as a different brand.
    expect(HTML).toMatch(/const KARST_MARK =[\s\S]*viewBox="0 0 215 215"/);
    expect(HTML).toMatch(/const KARST_MARK =[\s\S]*M 96 20[\s\S]*M 151 42[\s\S]*cx="106\.5" cy="111\.5" r="26\.5"/);
    expect(HTML).not.toMatch(/cx="6" cy="6" r="2\.4"/);
    expect(HTML).not.toMatch(/7\.6 7\.6/);
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
    expect(HTML).toContain('window.createServerLogsView(');
    expect(HTML).toContain('logsViewInstance.open()');
    expect(HTML).toContain('logsViewInstance.handleInitial(');
    expect(HTML).toContain('logsViewInstance.handleOutput(');
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
const HYDRATED = injectWebviewSend(
  injectServerLogsView(
    injectAgentIdentity(injectProviderIdentity(injectPalette(injectDesignSystem(HTML)))),
  ),
);

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
    hidden: false,
    dataset: {} as Record<string, string>,
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
    appendChild: () => {},
    removeChild: () => {},
  };
}

type PreviewElement = ReturnType<typeof previewElement>;

interface PreviewHarness {
  /** Deliver a host message through the script's `window.addEventListener('message')`. */
  receive(message: unknown): void;
  /** Click one evidence disclosure chevron, exactly like a user expanding/collapsing a process. */
  clickChevron(key: string): void;
  /** Click through the delegated document listeners at ONE selector. */
  click(sel: string, dataset: Record<string, string>, pathSelectors?: string[]): void;
  /** Deliver a window event the React islands announce (the transitional `karst:*` seam). */
  fireWindow(type: string, detail?: unknown): void;
  /** Press a key on the document keydown listener. */
  key(key: string): void;
  /**
   * Press a key on the document's delegated keydown listener through a fake
   * target at ONE selector — the keyboard twin of `click` above, for the
   * round switcher's Left/Right arrow handling (T6). `dataset` carries
   * whatever the tab itself renders (`act`, `stage`, `key`, `index`, `keys`).
   */
  keyOn(sel: string, key: string, dataset: Record<string, string>): void;
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
  /** Type into the env editor's textarea for one scope (what Save then reads). */
  typeEnv(scope: string, text: string): void;
  /** Fire the delegated `input` listener from a fake field at ONE selector. */
  input(sel: string, dataset: Record<string, string>, value: string): void;
  /** Every `<script>` the webview appended to `document.head` (lazy xterm delivery). */
  appendedScripts(): Array<{ nonce: string; textContent: string }>;
}

interface PreviewHarnessOptions {
  /**
   * Boot WITHOUT the xterm globals, as production now does: the bundle arrives
   * by `xterm` message and runs as an appended nonce'd `<script>`. Appending one
   * stands in for the browser executing it — it installs the fakes.
   */
  lazyXterm?: boolean;
}

function bootPreviewHarness(opts: PreviewHarnessOptions = {}): PreviewHarness {
  const elements: Record<string, PreviewElement> = {};
  const envTextareas: Record<string, string> = {};
  for (const id of [
    'servers',
    'inside',
    'ticketDataScrim',
    'ticketDataDrawer',
    'ticketDataTitle',
    'ticketDataClose',
    'ticketDataBody',
    'srvCount',
    'srvOps',
    'prs',
    'prCount',
    'prRefresh',
    'artView',
    'termView',
    'termHost',
    'envView',
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

  const appendedScripts: Array<{ nonce: string; textContent: string }> = [];

  const documentDouble = {
    getElementById: (id: string) => elements[id] ?? null,
    addEventListener: (type: string, handler: (event?: unknown) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(handler);
      docListeners.set(type, list);
    },
    // The env editor reads its textarea by `[data-env-scope="…"]`; the harness
    // answers with a stub carrying whatever the test typed into that scope.
    querySelector: (sel: string) => {
      if (sel === 'script[nonce]') return { nonce: 'HARNESS-NONCE' };
      const m = /^\[data-env-scope="(.*)"\]$/.exec(sel);
      if (m) return { value: envTextareas[m[1]!] ?? '' };
      return null;
    },
    querySelectorAll: () => [],
    body: { classList: bodyClassList, dataset: bodyDataset, appendChild: () => {} },
    head: {
      appendChild: (node: { nonce: string; textContent: string }) => {
        appendedScripts.push({ nonce: node.nonce, textContent: node.textContent });
        sandbox.Terminal = FakeTerminal;
        sandbox.FitAddon = { FitAddon: FakeFitAddon };
      },
    },
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

  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({
      getState: () => null,
      setState: () => {},
      postMessage: (message: unknown) => void posted.push(message),
    }),
    document: documentDouble,
    window: windowDouble,
    ...(opts.lazyXterm ? {} : { Terminal: FakeTerminal, FitAddon: { FitAddon: FakeFitAddon } }),
    setTimeout: () => 1,
    clearTimeout: () => {},
    // The env editor (like the base-change form) escapes a scope before
    // querying for its control; the VM has no DOM globals of its own.
    CSS: { escape: (v: string) => v },
    // The page announces to the React panels with window CustomEvents (the karst:pr* seam).
    CustomEvent: class {
      constructor(public type: string, init?: { detail?: unknown }) {
        this.detail = init?.detail;
      }
      detail: unknown;
    },
  };
  runInNewContext(`${previewScriptSource()}\n;globalThis.__karst = { esc };`, sandbox);

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
      // The event's target IS the toggled <details> row itself (it carries the
      // row's own data-proc-id) — the listener must match that, never a
      // `closest()` climb onto some ancestor class. The new state is the
      // OPPOSITE of what the rendered row currently has, so clicking an open
      // row collapses it (Task 3's default-open session is exactly that case)
      // and clicking a closed row expands it.
      const open = !tag.includes(' open');
      for (const handler of docListeners.get('toggle') ?? []) {
        handler({
          target: { tagName: 'DETAILS', dataset: { procId: `${stageKey}:${processId}` }, open },
        });
      }
    },
    // Click a document-level listener through a fake target whose `closest`
    // answers only the ONE selector that carries the node — every earlier
    // guard in the delegated handlers sees null, exactly as it would for a
    // target that is not inside those elements. The node carries the minimal
    // element surface the delegated action handler touches (pending state,
    // disabled, preventDefault).
    click: (sel: string, attrs: Record<string, string>, pathSelectors: string[] = []) => {
      // Real DOM semantics: `data-foo-bar` surfaces as dataset.fooBar, never
      // as a dashed key; the raw attribute is read through getAttribute.
      const dataset = Object.fromEntries(
        Object.entries(attrs).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
      );
      const node = {
        dataset,
        getAttribute: (n: string) => (n.startsWith('data-') ? (attrs[n.slice(5)] ?? null) : null),
        closest: (s: string) => (s === sel ? node : null),
        setAttribute: () => {},
        removeAttribute: () => {},
        classList: { add: () => {}, remove: () => {} },
        hasAttribute: () => false,
        disabled: false,
      };
      const pathNode = {
        matches: (s: string) => pathSelectors.includes(s),
      };
      for (const handler of docListeners.get('click') ?? []) {
        handler({
          target: node,
          preventDefault: () => {},
          composedPath: () => [node, pathNode],
        });
      }
    },
    fireWindow: (type, detail) => {
      for (const handler of winListeners.get(type) ?? []) handler({ detail });
    },
    // Press a key on the document's keydown listener (Esc mirrors Back).
    key: (key: string) => {
      for (const handler of docListeners.get('keydown') ?? []) handler({ key });
    },
    // Same fake-target shape as `click` above, delivered to the keydown
    // listeners instead of the click listeners.
    keyOn: (sel, key, dataset) => {
      const node = {
        dataset,
        closest: (s: string) => (s === sel ? node : null),
        focus: () => {},
      };
      for (const handler of docListeners.get('keydown') ?? []) {
        handler({ key, target: node, preventDefault: () => {} });
      }
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
    appendedScripts: () => appendedScripts,
    fits: () => terminalInstances.map((t) => t.addon?.fitCalls ?? 0),
    typeEnv: (scope: string, text: string) => {
      envTextareas[scope] = text;
    },
    input: (sel, dataset, value) => {
      const node = { dataset, value, closest: (s: string) => (s === sel ? node : null) };
      for (const handler of docListeners.get('input') ?? []) handler({ target: node });
    },
  };
}

describe('env overrides editor (executed in a VM)', () => {
  const stateWith = (
    envOverrides: DashboardState['envOverrides'],
  ): DashboardState => ({ ...renderStateFor('scope'), hasRunnableRepos: true, envOverrides });

  it('opens a section per scope, showing what is saved for each', () => {
    const h = bootPreviewHarness();
    h.receive({
      type: 'state',
      state: stateWith({
        services: ['api', 'web'],
        values: { '*': { SHARED: 'yes' }, api: { APP_HISTORY_FEATURE: 'true' } },
      }),
    });
    h.fireWindow('karst:openEnvOverrides');
    const html = h.htmlOf('envView');
    expect(h.bodyClasses).toContain('env-nav');
    expect(html).toContain('SHARED=yes');
    expect(html).toContain('APP_HISTORY_FEATURE=true');
    expect(html).toContain('data-env-scope="web"'); // offered even with nothing saved
    // Opening the editor asks the host for nothing: the values already ride state.
    expect(h.posted).toEqual([]);
  });

  it('posts the scope and the typed body on Save', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWith({ services: ['api'], values: {} }) });
    h.fireWindow('karst:openEnvOverrides');
    h.typeEnv('api', 'APP_HISTORY_FEATURE=true\nNEW=1');
    h.click('[data-env-save]', { envSave: 'api' });
    const posted = h.posted.at(-1) as { type: string; scope: string; text: string; requestId: string };
    expect(posted.type).toBe('env-overrides-save');
    expect(posted.scope).toBe('api');
    expect(posted.text).toBe('APP_HISTORY_FEATURE=true\nNEW=1');
    expect(posted.requestId).toBeTruthy(); // settles like every other mutating control
  });

  it('closes on Escape', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWith({ services: [], values: {} }) });
    h.fireWindow('karst:openEnvOverrides');
    expect(h.bodyClasses).toContain('env-nav');
    h.key('Escape');
    expect(h.bodyClasses).not.toContain('env-nav');
  });
});

describe('ticket data preview drawer (executed in a VM)', () => {

  it('opens the drawer with the fetched brief as text, posting nothing to the host', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: { ...renderStateFor('impl'), brief: '# T\n\n## Details\n- x' } });
    const before = h.posted.length;
    h.fireWindow('karst:openTicketData');
    expect(h.posted.length).toBe(before); // purely local — no host round trip
    expect(h.classesOf('ticketDataDrawer')).toContain('open');
    expect(h.classesOf('ticketDataScrim')).toContain('open');
    expect(h.element('ticketDataDrawer').getAttribute('aria-hidden')).toBe('false');
    // Rendered as TEXT — an HTML payload in the brief must not become markup.
    expect(h.element('ticketDataBody').textContent).toBe('# T\n\n## Details\n- x');
    expect(h.element('ticketDataBody').innerHTML).toBe(''); // never innerHTML
  });

  it('opens the drawer with the ticket\'s own data when no brief exists (a manual ticket bound via Create in ClickUp)', () => {
    const h = bootPreviewHarness();
    // A manual ticket has no fetched brief; its own description is what a
    // preview can show. This is the case the ticket reports as broken: after
    // manual create + "Create in ClickUp", the button used to never appear.
    h.receive({
      type: 'state',
      state: {
        ...renderStateFor('impl'),
        key: 'M-1',
        title: 'Manual ticket',
        description: 'Fix the login modal',
      },
    });
    h.fireWindow('karst:openTicketData');
    expect(h.element('ticketDataBody').textContent)
      .toBe('# M-1 — Manual ticket\n\nFix the login modal');
    expect(h.element('ticketDataBody').innerHTML).toBe(''); // never innerHTML
  });

  it('closes on the close button, the scrim, and Escape, restoring focus', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: { ...renderStateFor('impl'), brief: 'b' } });
    h.fireWindow('karst:openTicketData');
    expect(h.classesOf('ticketDataDrawer')).toContain('open');

    h.element('ticketDataClose').fire('click');
    expect(h.classesOf('ticketDataDrawer')).not.toContain('open');
    expect(h.classesOf('ticketDataScrim')).not.toContain('open');
    expect(h.element('ticketDataDrawer').getAttribute('aria-hidden')).toBe('true');

    h.fireWindow('karst:openTicketData');
    h.element('ticketDataScrim').fire('click');
    expect(h.classesOf('ticketDataDrawer')).not.toContain('open');

    h.fireWindow('karst:openTicketData');
    h.key('Escape');
    expect(h.classesOf('ticketDataDrawer')).not.toContain('open');
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
      id: 'plan',
      stage: 'impl',
      kind: 'plan',
      title: 'Plan',
      scope: null,
      summary: '3 tasks · 2 done · 1 in progress',
      status: 'info',
      freshness: 'current',
      origin: { kind: 'karst', core: 'codex' },
      versionCount: 1,
      currentVersionLabel: 'v1',
      createdAt: '2026-08-01T08:00:00.000Z',
      metrics: [
        { label: 'to-do', value: '0' },
        { label: 'in progress', value: '1' },
        { label: 'done', value: '2' },
      ],
      gates: [],
      findings: [],
      prs: [],
      commits: [],
      tasks: [
        { id: 'impl', label: 'Implement the feature', kind: 'agent', status: 'done', visits: 'visit 1' },
        { id: 'verify', label: 'Verify', kind: 'command', status: 'doing', visits: 'visit 1' },
        { id: 'note', label: 'Note', kind: 'join', status: 'todo', visits: null },
      ],
      resources: [],
      detail: null,
      agentConsole: null,
    },
    {
      id: 'uat-report',
      stage: 'uat',
      kind: 'uat-report',
      title: 'UAT report',
      scope: null,
      summary: '2 passed · 1 failed',
      status: 'passed',
      freshness: 'current',
      origin: { kind: 'karst', core: 'codex' },
      versionCount: 1,
      currentVersionLabel: 'v1',
      createdAt: '2026-08-01T10:00:00.000Z',
      metrics: [
        { label: 'passed', value: '2' },
        { label: 'failed', value: '1' },
      ],
      gates: [
        { name: 'lint', exitCode: 0 },
        { name: 'test', exitCode: 0 },
        { name: 'e2e', exitCode: 2 },
      ],
      findings: [],
      prs: [],
      commits: [],
      tasks: [],
      resources: [{ name: 'uat-ticket-1.log', path: '/data/karst/artifacts/1/uat-ticket-1.log', label: 'UAT log', taskId: null }],
      detail: null,
      agentConsole: 'tester',
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
          action: { actionId: 'snapshot-1:action-8', kind: 'open-file' },
        },
      ],
      prs: [],
      commits: [],
      tasks: [],
      resources: [],
      detail: null,
      agentConsole: 'review',
    },
    {
      id: 'ship-summary',
      stage: 'ship',
      kind: 'ship-summary',
      title: 'PR summary',
      scope: null,
      summary: '1 PR · 1 new commit',
      status: 'passed',
      freshness: 'current',
      origin: { kind: 'karst', core: 'claude' },
      versionCount: 1,
      currentVersionLabel: 'v1',
      createdAt: '2026-08-01T11:00:00.000Z',
      metrics: [
        { label: 'repos', value: '1' },
        { label: 'PRs', value: '1' },
        { label: 'new commits', value: '1' },
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
      commits: [
        {
          repo: '/wt/web',
          sha: 'abc123',
          message: 'feat: passkey login',
          origin: 'created-by-ship',
          action: { actionId: 'snapshot-1:action-9', kind: 'open-commit' },
        },
      ],
      tasks: [],
      resources: [],
      detail: null,
      agentConsole: null,
    },
  ];
}

function stateWithArtifacts(): DashboardState {
  return { ...renderStateFor('uat'), artifacts: artifactFixtures() };
}

const BASELINE_ROWS: NonNullable<DashboardState['baselineReview']> = [
  { index: 0, path: 'tests/visual/__baselines__/a/settings.png', label: 'a/settings.png', status: 'modified',
    oldSrc: 'vscode-webview://x/old.png', newSrc: 'vscode-webview://x/new.png', decision: 'pending', reason: null },
  { index: 1, path: 'tests/visual/__baselines__/b.png', label: 'b.png', status: 'added',
    oldSrc: null, newSrc: 'vscode-webview://x/b.png', decision: 'approved', reason: null },
  { index: 2, path: 'tests/visual/layout-known-failures.json', label: 'layout-known-failures.json', status: 'modified',
    oldSrc: null, newSrc: null, decision: 'rejected', reason: 'ledger grew' },
];

/** A UAT ticket parked on a baseline review, as the panel overlays it. */
function stateWithBaselines(): DashboardState {
  const base = stateWithArtifacts();
  const blocked = {
    kind: 'baseline-review' as const,
    reason: '2 visual baseline(s) changed — review in the UAT report',
    at: '',
    resumable: false,
  };
  return {
    ...base,
    currentStage: { ...(base.currentStage as object), stageKey: 'uat', blocked } as never,
    baselineReview: BASELINE_ROWS,
    artifacts: base.artifacts.map((a) =>
      a.id === 'uat-report'
        ? { ...a, baselines: BASELINE_ROWS.map(({ path, status, decision, reason }) => ({ path, status, decision, reason })) }
        : a),
  };
}

describe('baseline review (executed in a VM)', () => {
  const open = (): PreviewHarness => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithBaselines() });
    return h;
  };

  it('the UAT report only LISTS the baselines — no Approve/Reject, no images (@arch:SHELF)', () => {
    const h = open();
    h.click('[data-art-open]', { artOpen: 'uat-report' });
    const detail = h.htmlOf('artView');
    expect(detail).toContain('Visual baselines');
    expect(detail).toContain('tests/visual/__baselines__/a/settings.png');
    expect(detail).toContain('○ Needs review');
    expect(detail).not.toContain('baseline-approve');
    expect(detail).not.toContain('baseline-reject');
    expect(detail).not.toContain('<img');
  });

});

describe('artifacts render round trip (executed in a VM)', () => {
  it('opens the index in-webview from View all, grouped by stage, and returns via Back', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithArtifacts() });
    h.fireWindow('karst:openArt', { kind: 'index' });
    // The dashboard body is hidden while the index surface is active.
    expect(h.bodyClasses).toContain('art-nav');
    const index = h.htmlOf('artView');
    expect(index).toContain('Artifacts · 4');
    expect(index).toContain('← Ticket');
    // Grouped by producing stage, empty groups omitted; one row per artifact.
    expect(index).toMatch(/Implement[\s\S]*data-art-open="plan"/);
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
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'uat-report' });

    const detail = h.htmlOf('artView');
    // Back label answers the ORIGIN: from the index → back to Artifacts.
    expect(detail).toContain('← Artifacts');
    // Semantic result first: title, status word, metrics, gates.
    expect(detail).toContain('UAT report');
    expect(detail).toContain('Passed');
    expect(detail).toContain('2');
    expect(detail).toContain('lint');
    // Gate outcomes are COLOURED STATES (green pass / red fail), not text
    // labels: the passing gates draw a passed dot, the failing one a failed
    // dot, each with its state word only as the dot's accessible name.
    expect(detail).toMatch(/class="ag-state pass"[\s\S]*role="img" aria-label="passed"/);
    expect(detail).toMatch(/class="ag-state fail"[\s\S]*role="img" aria-label="failed"/);
    expect(detail).toContain('exit 2');
    expect(detail).not.toMatch(/ag-code[^>]*>passed</);
    // The gate log opens in the xterm console — the uat stage's console entry
    // rides the Gate runs heading.
    expect(detail).toMatch(/data-act="console"[\s\S]*data-console="uat"/);
    // Provenance: produced-by carries the origin chip, and — when the host
    // flagged one — the AI process's own console entry beside it, so the
    // Tester's streamed output is reachable from the report too.
    expect(detail).toContain('Produced by');
    expect(detail).toContain('Karst · Codex');
    expect(detail).toMatch(/data-act="console" data-console="uat" data-console-proc="tester"/);
    // Files LAST, each with the explicit editor escape carrying id + index.
    const filesAt = detail.indexOf('Underlying files');
    const detailsAt = detail.indexOf('Details');
    expect(filesAt).toBeGreaterThan(detailsAt);
    expect(detail).toContain('uat-ticket-1.log');
    expect(detail).toContain('UAT log');
    expect(detail).toMatch(/data-act="artifact-open-resource"[\s\S]*data-artifact-id="uat-report"[\s\S]*data-index="0"/);

    // Esc mirrors Back: detail(from index) → index.
    h.key('Escape');
    expect(h.htmlOf('artView')).toContain('Artifacts · 4');
    // And Esc on the index → ticket.
    h.key('Escape');
    expect(h.bodyClasses).not.toContain('art-nav');
  });

  it('renders each plan task\'s own files inline and only taskId===null files in "Plan files"', () => {
    const h = bootPreviewHarness();
    const arts = artifactFixtures().map((a) => a.id !== 'plan' ? a : {
      ...a,
      resources: [
        { name: 'plan.md', path: '/p/plan.md', label: 'Plan', taskId: null },
        { name: 'brief.md', path: '/p/brief.md', label: 'Brief', taskId: 'impl' },
        { name: 'verify-report.md', path: '/p/vr.md', label: 'Output · verify-report', taskId: 'verify' },
      ],
    });
    h.receive({ type: 'state', state: { ...renderStateFor('uat'), artifacts: arts } });
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'plan' });
    const detail = h.htmlOf('artView');
    expect(detail).toMatch(/Implement the feature[\s\S]*?data-index="1"[\s\S]*?Brief ↗[\s\S]*?Verify[\s\S]*?data-index="2"[\s\S]*?Output · verify-report ↗/);
    expect(detail).toContain('title="Open Brief (brief.md) in the editor"');
    expect(detail).toContain('aria-label="Plan files"');
    expect(detail).toContain('>Plan files<');
    expect(detail).not.toContain('Underlying files');
    const bottom = detail.slice(detail.indexOf('aria-label="Plan files"'));
    expect(bottom).toContain('plan.md');
    expect(bottom).toContain('data-index="0"');
    expect(bottom).not.toContain('brief.md');
    expect(bottom).not.toContain('data-index="1"');
  });

  it('omits the files section when every resource belongs to a task', () => {
    const h = bootPreviewHarness();
    const arts = artifactFixtures().map((a) => a.id !== 'plan' ? a : {
      ...a,
      resources: [{ name: 'brief.md', path: '/p/brief.md', label: 'Brief', taskId: 'impl' }],
    });
    h.receive({ type: 'state', state: { ...renderStateFor('uat'), artifacts: arts } });
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'plan' });
    const detail = h.htmlOf('artView');
    expect(detail).toContain('Brief ↗');
    expect(detail).not.toContain('Plan files');
    expect(detail).not.toContain('Underlying files');
  });

  it('names the repo by basename on PR and commit rows, full path in the title', () => {
    const h = bootPreviewHarness();
    const state = stateWithArtifacts();
    const ship = state.artifacts!.find((a) => a.id === 'ship-summary')!;
    const patched = {
      ...state,
      artifacts: state.artifacts!.map((a) => (a.id === 'ship-summary'
        ? { ...ship, prs: [{ ...ship.prs[0]!, repo: '/Users/x/karst/' }],
            commits: [{ ...ship.commits[0]!, repo: '/Users/x/karst/' }] }
        : a)),
    };
    h.receive({ type: 'state', state: patched });
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'ship-summary' });
    const detail = h.htmlOf('artView');
    expect(detail).toMatch(/<span class="af-repo" title="\/Users\/x\/karst\/">karst<\/span>/);
    expect(detail).not.toContain('>/Users/x/karst/');
  });

  it('drops the separator when a commit has no message and tags pre-existing commits', () => {
    const h = bootPreviewHarness();
    const state = stateWithArtifacts();
    const ship = state.artifacts!.find((a) => a.id === 'ship-summary')!;
    const patched = {
      ...state,
      artifacts: state.artifacts!.map((a) => (a.id === 'ship-summary'
        ? { ...ship, commits: [{ ...ship.commits[0]!, message: '', origin: 'before-ship' as const }] }
        : a)),
    };
    h.receive({ type: 'state', state: patched });
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'ship-summary' });
    const detail = h.htmlOf('artView');
    expect(detail).not.toMatch(/abc123<\/a>\s*·/);
    expect(detail).toContain('<span class="af-msg af-msg--empty">No message</span>');
    expect(detail).toContain('<span class="commit-origin" title="Already on the branch before ship ran">existing</span>');
  });

  it('renders the ship detail with the PR number and commit SHA as the open controls', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithArtifacts() });
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'ship-summary' });
    const detail = h.htmlOf('artView');
    // The PR number IS the link — never inert text beside an "Open PR" button.
    expect(detail).toMatch(
      /<a class="obj-link pr-link" href="#" data-act="open-pr" data-url="https:\/\/github\.com\/o\/r\/pull\/42"[^>]*>#42<\/a>/,
    );
    expect(detail).not.toContain('Open PR ↗');
    expect(detail).not.toContain('>Open PR</button>');
    // The commit SHA IS the open-commit control (opaque action id only).
    expect(detail).toMatch(
      /<a class="obj-link commit-link" href="#" data-act="inside-action" data-action-id="snapshot-1:action-9"[^>]*>abc123<\/a>/,
    );
    // The ship summary is not a gate stage, so it offers no console entry.
    expect(detail).not.toContain('data-console="ship"');
  });

  it('renders the review detail with the finding location as the open-file control', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithArtifacts() });
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'review' });
    const detail = h.htmlOf('artView');
    expect(detail).toContain('Credential cache is not cleared');
    // The finding's file:line IS the open-file control, never inert text.
    expect(detail).toMatch(
      /<a class="obj-link file-link" href="#" data-act="inside-action" data-action-id="snapshot-1:action-8"[^>]*>src\/auth\.ts:12<\/a>/,
    );
    // The reviewer's console rides the provenance line, the same way the UAT
    // report offers the Tester's.
    expect(detail).toMatch(/data-act="console" data-console="review" data-console-proc="review"/);
  });

  it('offers no agent console on an artifact the host did not flag', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithArtifacts() });
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'ship-summary' });
    expect(h.htmlOf('artView')).not.toContain('data-console-proc');
  });

  it('renders the plan detail with the task list as the tracking surface', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: stateWithArtifacts() });
    h.fireWindow('karst:openArt', { kind: 'index' });
    h.click('[data-art-open]', { artOpen: 'plan' });
    const detail = h.htmlOf('artView');
    // The plan detail carries the tracking metrics and the Tasks section.
    expect(detail).toContain('Plan');
    expect(detail).toContain('2');
    expect(detail).toContain('Tasks');
    // Each task renders its label + kind + visit, with the state WORD only as
    // the dot's accessible name (UI-R28) — never a visible status label.
    expect(detail).toMatch(/at-state done[\s\S]*role="img" aria-label="done"/);
    expect(detail).toMatch(/at-state doing[\s\S]*role="img" aria-label="in progress"/);
    expect(detail).toMatch(/at-state todo[\s\S]*role="img" aria-label="to do"/);
    expect(detail).toContain('Implement the feature');
    expect(detail).toContain('command · visit 1');
    // The plan is not a gate stage, so it offers no console entry.
    expect(detail).not.toContain('data-console="impl"');
    // The plan is produced during impl, so the index labels it Implement.
    h.key('Escape');
    expect(h.htmlOf('artView')).toMatch(/Implement[\s\S]*data-art-open="plan"/);
  });

  describe('stored artifacts view', () => {
    const SHA1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const SHA2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const view = {
      total: 1,
      globs: ['plans/**'],
      skips: [{ path: 'app/.env', reason: 'secret-pattern' }],
      groups: [{
        kind: 'plan',
        approaches: [{
          approach: 'gsd',
          rows: [{
            path: 'app/plans/a.md', repo: 'app', relPath: 'plans/a.md', kind: 'plan', approach: 'gsd',
            source: 'watcher', revisions: 2, lastAt: '2026-01-02T00:00:00Z', latestSha: SHA2,
            history: [
              { sha: SHA2, at: '2026-01-02T00:00:00Z', source: 'watcher' },
              { sha: SHA1, at: '2026-01-01T00:00:00Z', source: 'hook' },
            ],
          }],
        }],
      }],
    };

    it('groups kind then approach, lists rows, history and skipped files', () => {
      const h = bootPreviewHarness();
      h.receive({ type: 'state', state: { ...stateWithArtifacts(), storedArtifacts: view } });
      h.fireWindow('karst:openArt', { kind: 'stored' });
      const html = h.htmlOf('artView');
      expect(html).toMatch(/artgroup-title">plan[\s\S]*gsd[\s\S]*app \/ plans\/a\.md/);
      expect(html).toContain('2 revisions');
      expect(html).toContain('Reveal folder');
      expect(html).toContain('Purge artifacts');
      expect(html).toMatch(/Skipped files[\s\S]*app\/\.env — secret-pattern/);
      // Diff pairs each revision with the previous one; the oldest has none.
      expect(html.match(/Diff vs previous/g)).toHaveLength(1);
    });

    it('names the active outputs globs in the empty state', () => {
      const h = bootPreviewHarness();
      const empty = { total: 0, groups: [], skips: [], globs: ['plans/**', 'docs/spec/*.md'] };
      h.receive({ type: 'state', state: { ...stateWithArtifacts(), storedArtifacts: empty } });
      h.fireWindow('karst:openArt', { kind: 'stored' });
      expect(h.htmlOf('artView')).toMatch(/No artifacts captured yet\. Watching: <code>plans\/\*\*<\/code>, <code>docs\/spec\/\*\.md<\/code>/);
    });

    it('posts store paths and shas only, and Back returns to the ticket', () => {
      const h = bootPreviewHarness();
      h.receive({ type: 'state', state: { ...stateWithArtifacts(), storedArtifacts: view } });
      h.fireWindow('karst:openArt', { kind: 'stored' });
      h.click('[data-act]', { act: 'stored-artifact-open', path: 'app/plans/a.md', sha: SHA2 });
      h.click('[data-act]', { act: 'stored-artifact-diff', path: 'app/plans/a.md', from: SHA1, to: SHA2 });
      h.click('[data-act]', { act: 'stored-artifact-live', path: 'app/plans/a.md' });
      h.click('[data-act]', { act: 'stored-artifact-reveal' });
      h.click('[data-act]', { act: 'stored-artifact-purge' });
      const types = h.posted.map((m) => (m as { type?: string }).type);
      expect(types).toEqual(expect.arrayContaining([
        'stored-artifact-open', 'stored-artifact-diff', 'stored-artifact-live', 'stored-artifact-reveal', 'stored-artifact-purge',
      ]));
      expect(h.posted.find((m) => (m as { type?: string }).type === 'stored-artifact-diff'))
        .toMatchObject({ path: 'app/plans/a.md', from: SHA1, to: SHA2 });
      h.click('[data-art]', { art: 'back' });
      expect(h.bodyClasses).not.toContain('art-nav');
    });
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
    // A control rebuilt by a repaint with an id but no `data-act` (the env
    // editor's textarea) keeps the keyboard and its caret; a controls-only
    // rule could not even see it.
    const focused: string[] = [];
    const after = control('envTextarea', '', focused, 0);
    repaint([control('envTextarea', '', focused, 3)], [after], 0);
    expect(focused).toEqual(['envTextarea']);
    expect(after.selectionStart).toBe(3);
  });
});

describe('terminal console view — lazy xterm delivery (VM)', () => {
  // Over Remote-SSH the panel document crosses the network on every open, so
  // the ~490 KB xterm bundle is no longer inlined: the first console open asks
  // for it, and the host answers with the text the webview runs under its own
  // nonce (the CSP stays nonce-only — no `<script src>`).
  it('asks the host for xterm on first console open and shows a loading line', () => {
    const h = bootPreviewHarness({ lazyXterm: true });
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    expect(h.posted).toContainEqual({ type: 'xterm-request' });
    expect(h.posted).toContainEqual({ type: 'stage-log-request', stage: 'uat' });
    expect(h.terminals()).toHaveLength(0);
    expect(h.htmlOf('termHost')).not.toContain('unavailable');
  });

  it('runs the delivered bundle under the page nonce, then opens and fills the terminal', () => {
    const h = bootPreviewHarness({ lazyXterm: true });
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    // The log answer can win the race against the bundle: it must be kept.
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: 'early\n', truncated: false } });
    h.receive({ type: 'xterm', js: 'XTERM_BUNDLE' });
    expect(h.appendedScripts()).toEqual([{ nonce: 'HARNESS-NONCE', textContent: 'XTERM_BUNDLE' }]);
    expect(h.terminals()).toHaveLength(1);
    expect(h.terminals()[0]!.written).toBe('early\n');
  });

  it('requests the bundle once — a later console open reuses it', () => {
    const h = bootPreviewHarness({ lazyXterm: true });
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    h.receive({ type: 'xterm', js: 'XTERM_BUNDLE' });
    h.key('Escape');
    h.click('[data-act]', { act: 'console', console: 'uat' });
    expect(h.posted.filter((m) => (m as { type: string }).type === 'xterm-request')).toHaveLength(1);
    expect(h.appendedScripts()).toHaveLength(1);
    expect(h.terminals()).toHaveLength(2);
  });

  it('degrades to the visible refusal when the host has no bundle', () => {
    const h = bootPreviewHarness({ lazyXterm: true });
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    h.receive({ type: 'xterm', js: null });
    expect(h.appendedScripts()).toHaveLength(0);
    expect(h.htmlOf('termHost')).toContain('Console rendering is unavailable');
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

  it('opens the agent console and posts agent-log-request with the process', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat', consoleProc: 'tester' });
    expect(h.bodyClasses).toContain('term-nav');
    expect(h.htmlOf('termView')).toContain('Console · Tester');
    expect(h.posted).toContainEqual({ type: 'agent-log-request', processId: 'tester' });
    expect(h.posted).not.toContainEqual({ type: 'stage-log-request', stage: 'uat' });
  });

  it('writes the agent-log ok content into the live terminal for that process', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat', consoleProc: 'tester' });
    h.receive({ type: 'agent-log', processId: 'tester', result: { kind: 'ok', content: '\x1b[33mwarn\x1b[0m\n', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('\x1b[33mwarn\x1b[0m\n');
  });

  it('replaces the agent console refusal with a live terminal when output starts', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat', consoleProc: 'tester' });
    // Mid-run first open: nothing is persisted yet, so the host refuses.
    h.receive({
      type: 'agent-log',
      processId: 'tester',
      result: { kind: 'error', message: 'This process has no recorded console output.' },
    });
    expect(h.htmlOf('termHost')).toContain('no recorded console output');
    // The Tester then starts streaming: the blurb gives way to a terminal that
    // carries the live text — a running process is never left saying nothing
    // happened.
    h.receive({ type: 'agent-output', processId: 'tester', text: 'first line\n' });
    // A fresh Terminal replaced the refusal blurb (the harness's stub element
    // keeps the old markup, so the terminal count is the evidence of the swap
    // — the same check the stage console's recovery test makes).
    expect(h.terminals().length).toBe(2);
    expect(h.terminals().at(-1)!.written).toBe('first line\n');
  });

  it('drops an agent-log answer for a console showing a DIFFERENT process', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat', consoleProc: 'tester' });
    h.receive({ type: 'agent-log', processId: 'review', result: { kind: 'ok', content: 'other', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('');
  });

  it('streams agent-output chunks into the open process console', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat', consoleProc: 'tester' });
    // The host's guaranteed agent-log answer settles loading first.
    h.receive({ type: 'agent-log', processId: 'tester', result: { kind: 'ok', content: 'start', truncated: false } });
    h.receive({ type: 'agent-output', processId: 'tester', text: '\nstill running' });
    expect(h.terminals()[0]!.written).toBe('start\nstill running');
  });

  it('buffers agent-output that races the initial tail and flushes it after the agent-log answer', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat', consoleProc: 'tester' });
    // A live chunk lands BEFORE the guaranteed agent-log answer: it must not
    // be dropped, and it must not be written ahead of the persisted tail.
    h.receive({ type: 'agent-output', processId: 'tester', text: 'raced' });
    expect(h.terminals()[0]!.written).toBe('');
    h.receive({ type: 'agent-log', processId: 'tester', result: { kind: 'ok', content: 'tail\n', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('tail\nraced');
  });

  it('ignores agent-output for a console showing a different process or no console', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat', consoleProc: 'tester' });
    h.receive({ type: 'agent-log', processId: 'tester', result: { kind: 'ok', content: 'start', truncated: false } });
    h.receive({ type: 'agent-output', processId: 'review', text: 'wrong process' });
    expect(h.terminals()[0]!.written).toBe('start');
    // A process console is NOT a stage console: a stage-log answer for the same
    // stage is dropped while the process console is open.
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: 'stage', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('start');
  });

  it('streams stage-output chunks into the open stage console', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: 'recorded', truncated: false } });
    h.receive({ type: 'stage-output', stage: 'uat', text: '\n$ test\nrunning' });
    expect(h.terminals()[0]!.written).toBe('recorded\n$ test\nrunning');
  });

  it('buffers stage-output that races the stage-log answer and flushes it after', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    h.receive({ type: 'stage-output', stage: 'uat', text: 'raced' });
    expect(h.terminals()[0]!.written).toBe('');
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: 'tail\n', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('tail\nraced');
  });

  it('ignores stage-output for another stage, or while a PROCESS console is open', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: 'start', truncated: false } });
    h.receive({ type: 'stage-output', stage: 'review', text: 'wrong stage' });
    expect(h.terminals()[0]!.written).toBe('start');
    h.click('[data-act]', { act: 'console', console: 'uat', consoleProc: 'tester' });
    h.receive({ type: 'agent-log', processId: 'tester', result: { kind: 'ok', content: '', truncated: false } });
    h.receive({ type: 'stage-output', stage: 'uat', text: 'gate text' });
    expect(h.terminals().at(-1)!.written).toBe('');
  });

  it('recovers a refused stage console when live gate output arrives after it', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act]', { act: 'console', console: 'uat' });
    // Mid-run there is no recorded artifact yet, so the answer is a refusal —
    // but the gates ARE running, and their live output must still appear.
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'error', message: 'No console output has been recorded for this stage yet.' } });
    h.receive({ type: 'stage-output', stage: 'uat', text: '\n$ test\nrunning' });
    // A fresh Terminal replaced the refusal blurb, and it carries the live text.
    expect(h.terminals().length).toBe(2);
    expect(h.terminals().at(-1)!.written).toBe('\n$ test\nrunning');
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

describe('content width cap (UI-R48)', () => {
  it('stays uncapped', () => {
    expect(HTML).not.toContain('--k-content-max');
  });
});

describe('React island transition rule', () => {
  it('every document-level delegator skips events from inside the React-owned island', () => {
    const listeners = HTML.split('\n').flatMap((line, i, all) =>
      /^\s*document\.addEventListener\(/.test(line) ? [all[i + 1]] : [],
    );
    expect(listeners.length).toBeGreaterThan(0);
    for (const next of listeners) expect(next).toContain('if (inReactIsland(e)) return;');
  });

  it('no longer carries the dead renderSandbox or sandbox entries in SEND_BY_ACT', () => {
    expect(HTML).not.toContain('renderSandbox');
    expect(HTML).not.toMatch(/'sandbox-[a-z-]+': \(btn/);
  });
});
