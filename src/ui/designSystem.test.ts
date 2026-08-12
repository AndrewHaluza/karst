import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { injectDesignSystem, DS_CSS_MARKER, DS_JS_MARKER } from '../model/designSystem.js';
import { injectCsp, newNonce } from '../model/csp.js';
import {
  injectAgentIdentity,
  AGENT_CSS_MARKER,
  AGENT_JS_MARKER,
} from '../model/agentIdentity.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * DISCOVERED, never enumerated — the same reasoning as `ui/webviewCsp.test.ts`.
 * `injectDesignSystem` no-ops on a marker-less document by design, so a webview
 * added later would ship outside the design system silently: no tokens, no
 * primitives, no async feedback, and nothing failing. Discovery is what binds
 * these tests to every webview rather than to the seven that exist today.
 *
 * Three of the seven (`usage`, `diffs`, `gettingStarted`) were in exactly that state
 * for the palette: they carried no `/*KARST_PALETTE*\/` marker and no host call,
 * so they sat outside the one shared block that already existed. That is the
 * failure mode this test makes loud.
 */
const WEBVIEWS = readdirSync(HERE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(HERE, name, 'webview.html'));
      return true;
    } catch {
      return false;
    }
  });

const read = (name: string): string => readFileSync(join(HERE, name, 'webview.html'), 'utf8');

describe('design system webview discovery', () => {
  it('finds every webview that exists today', () => {
    expect([...WEBVIEWS].sort()).toEqual([
      'dashboard',
      'diffs',
      'gettingStarted',
      'settings',
      'sidebar',
      'ticketForm',
      'usage',
    ]);
  });
});

describe.each(WEBVIEWS)('%s webview design system', (name) => {
  it('carries both design-system markers (UI-R03)', () => {
    const html = read(name);
    expect(html, 'missing the CSS marker').toContain(DS_CSS_MARKER);
    expect(html, 'missing the JS marker').toContain(DS_JS_MARKER);
  });

  it('places the CSS marker inside a style block, ahead of the file own rules', () => {
    const html = read(name);
    const styleAt = html.indexOf('<style>');
    const markerAt = html.indexOf(DS_CSS_MARKER);
    expect(styleAt).toBeGreaterThanOrEqual(0);
    expect(markerAt).toBeGreaterThan(styleAt);
    // Nothing but whitespace/comments between the opening tag and the marker:
    // a rule declared before it could not be overridden by the file itself.
    expect(html.slice(styleAt + '<style>'.length, markerAt)).not.toContain('{');
  });

  it('places the JS marker inside a script block', () => {
    const html = read(name);
    const markerAt = html.indexOf(DS_JS_MARKER);
    const scriptAt = html.lastIndexOf('<script>', markerAt);
    expect(scriptAt).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('</script>', scriptAt)).toBeGreaterThan(markerAt);
  });

  it('gets tokens, primitives and the runtime once injected', () => {
    const out = injectDesignSystem(read(name));
    expect(out).toContain('--k-space-4:8px;');
    expect(out).toContain('.k-btn{');
    expect(out).toContain('function karstAction(');
    // The Tabler icon runtime and its shared stroke treatment ride the same
    // injection — every webview gets the catalog and `karstIcon()` by
    // construction (docs/ui/ICONS.md §3).
    expect(out).toContain('function karstIcon(');
    expect(out).toContain('.k-icon{');
    expect(out).not.toContain(DS_CSS_MARKER);
    expect(out).not.toContain(DS_JS_MARKER);
  });

  it('leaves the injected runtime authorized by the CSP nonce', () => {
    // Injection order matters: run after injectCsp and the emitted runtime sits
    // in a `<script>` the nonce pass has already walked past, so the browser
    // refuses to execute it and every control silently loses its feedback.
    const out = injectCsp(injectDesignSystem(read(name)), 'TESTNONCE');
    const at = out.indexOf('function karstAction(');
    expect(at).toBeGreaterThan(0);
    const openedAt = out.lastIndexOf('<script', at);
    expect(out.slice(openedAt, at)).toContain('nonce="TESTNONCE"');
  });

  it('still carries its CSP marker', () => {
    // The design system must not have displaced an existing contract.
    expect(read(name)).toContain('<!--KARST_CSP-->');
  });
});

describe('injection is inert without markers', () => {
  it('passes a marker-less document through unchanged', () => {
    const html = '<style>body{}</style><script>const a=1;</script>';
    expect(injectDesignSystem(html)).toBe(html);
  });

  it('lands generated text verbatim even though it contains $ sequences', () => {
    // A string replacement would treat `$&` as a substitution.
    const out = injectDesignSystem(`<style>${DS_CSS_MARKER}</style>`);
    expect(out).toContain(':root{');
    expect(out).not.toContain('$&');
  });
});

describe('agent identity injection (B1)', () => {
  /**
   * `injectAgentIdentity` is a no-op on a marker-less document — exactly like
   * `injectDesignSystem` — so a webview that CALLS the injected agent API
   * (`agentIconHtml`, `agentBadgeHtml`, the label/icon constants) without
   * carrying both markers would throw `ReferenceError` in production: the
   * provider-brand tokens simply would not be present. Discovered, never
   * enumerated: a webview added later that consumes the API without the
   * markers fails here, and no screen's name is hardcoded.
   */
  it('requires both agent markers in every webview that uses the agent API', () => {
    const users = WEBVIEWS.filter((name) =>
      /agentBadgeHtml\(|agentIconHtml\(|AGENT_PROVIDER_LABELS|AGENT_ICONS/.test(read(name)),
    );
    expect(users.length, 'no webview uses the agent API — the guard would be dead').toBeGreaterThan(0);
    for (const name of users) {
      const html = read(name);
      expect(html, `${name} uses the agent API without ${AGENT_CSS_MARKER}`).toContain(AGENT_CSS_MARKER);
      expect(html, `${name} uses the agent API without ${AGENT_JS_MARKER}`).toContain(AGENT_JS_MARKER);
    }
  });

  it('substitutes both agent markers wherever a webview carries them', () => {
    // A marker the host never replaces would ship to the browser as a literal
    // comment, and the API would be missing — the same silent no-op. The
    // hydration must be complete for every webview that opted in.
    const carriers = WEBVIEWS.filter((name) => read(name).includes(AGENT_CSS_MARKER));
    expect(carriers.length).toBeGreaterThan(0);
    for (const name of carriers) {
      const out = injectAgentIdentity(read(name));
      expect(out, `${name} keeps the CSS marker after injection`).not.toContain(AGENT_CSS_MARKER);
      expect(out, `${name} keeps the JS marker after injection`).not.toContain(AGENT_JS_MARKER);
      expect(out, `${name} is missing the injected agent runtime`).toContain('function agentBadgeHtml(');
    }
  });
});
