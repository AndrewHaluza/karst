import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { injectDesignSystem, DS_CSS_MARKER, DS_JS_MARKER } from '../model/designSystem.js';
import { injectCsp, newNonce } from '../model/csp.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * DISCOVERED, never enumerated — the same reasoning as `ui/webviewCsp.test.ts`.
 * `injectDesignSystem` no-ops on a marker-less document by design, so a webview
 * added later would ship outside the design system silently: no tokens, no
 * primitives, no async feedback, and nothing failing. Discovery is what binds
 * these tests to every webview rather than to the seven that exist today.
 *
 * Three of the seven (`usage`, `diffs`, `welcome`) were in exactly that state
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
      'onboarding',
      'settings',
      'sidebar',
      'usage',
      'welcome',
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
