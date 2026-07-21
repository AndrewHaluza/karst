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

  it('renders fix as the branch, below the main line', () => {
    expect(HTML).toContain('data-stage="fix"');
    const loopAt = HTML.indexOf('class="loop');
    const fixAt = HTML.indexOf('data-stage="fix"');
    expect(loopAt).toBeGreaterThan(-1);
    expect(fixAt).toBeGreaterThan(loopAt);
  });

  it('makes every stage node a real button, so the rail is keyboard-reachable', () => {
    expect(HTML).toMatch(/<button class="node"/);
    expect(HTML).toContain('aria-pressed');
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
    expect(HTML).toMatch(/\.railwrap\{[^}]*overflow-x:auto[^}]*padding-top:\s*(\d+)px/);
    const pad = Number(HTML.match(/\.railwrap\{[^}]*padding-top:\s*(\d+)px/)?.[1]);
    expect(pad, 'railwrap padding-top must clear the 5px focus outline').toBeGreaterThanOrEqual(5);
  });

  it('keeps --panel-bg opaque, because it is a mask and not just a tint', () => {
    // The nodes fill with --panel-bg to mask the connector running under them,
    // and the selection ring's inner gap is painted in it. A `transparent`
    // fallback made both masks stop masking on any theme without
    // editorWidget.background: the rail drew straight through the node.
    expect(HTML).toContain('--panel-bg:var(--vscode-editorWidget-background,var(--vscode-editor-background))');
    expect(HTML).not.toContain('--panel-bg:var(--vscode-editorWidget-background,transparent)');
  });

  it('separates the focus outline from the selection ring by colour', () => {
    // Both were --st-sel at overlapping radii (ring 0–4px, outline 3–5px), so
    // they fused into one slab and focus was invisible on the selected node.
    expect(HTML).toMatch(/\.st \.node:focus-visible\{outline:2px solid var\(--vscode-focusBorder\)/);
    expect(HTML).toMatch(/\.fixnode \.node:focus-visible\{outline:2px solid var\(--vscode-focusBorder\)/);
    expect(HTML, 'the selection ring is what keeps --st-sel').toContain('0 0 0 4px var(--st-sel)');
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

  it('no longer carries the removed impl-phase strip', () => {
    expect(HTML).not.toContain('renderSubsteps');
    expect(HTML).not.toContain('implPhases');
  });
});
