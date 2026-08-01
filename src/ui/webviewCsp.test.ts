import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { injectCsp, newNonce, CSP_MARKER } from '../model/csp.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * DISCOVERED, never enumerated. A hand-maintained list would let a webview added
 * later ship with no CSP and no failing test — `injectCsp` no-ops on a
 * marker-less document by design, so nothing else would say a word. Discovery is
 * what makes these tests bind to every webview rather than to the five that
 * happened to exist when they were written.
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

// Guards the discovery itself: a glob that silently matches nothing would turn
// every describe.each below into a no-op that still reports green.
describe('webview discovery', () => {
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

/**
 * `injectCsp` no-ops on a document without the marker — deliberately, so an
 * un-opted-in webview isn't served a policy that blocks its own scripts. The
 * cost is that a missing marker fails silently: the panel just ships with no
 * CSP, which is exactly the state finding #4 describes. These tests are what
 * make the marker's absence loud instead.
 */
describe.each(WEBVIEWS)('%s webview CSP', (name) => {
  it('carries the CSP marker', () => {
    expect(read(name)).toContain(CSP_MARKER);
  });

  it('gets a policy and a nonce once injected', () => {
    const out = injectCsp(read(name), 'TESTNONCE');
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain("default-src 'none'");
    expect(out).toContain("script-src 'nonce-TESTNONCE'");
  });

  it('leaves no inline script unauthorized — an untagged one would not run', () => {
    const out = injectCsp(read(name), 'TESTNONCE');
    expect(out).not.toMatch(/<script(?![^>]*\bnonce=)/);
  });

  // The policy is only this tight because nothing loads externally. If a webview
  // ever gains a <link>/<img>/url()/fetch(), default-src 'none' silently breaks
  // it — better to fail here, at the assumption, than to debug a blank panel.
  it('loads nothing externally, which is what default-src none assumes', () => {
    const html = read(name);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/\burl\(\s*['"]?(?:https?:)?\/\//);
    expect(html).not.toMatch(/@font-face/);
    expect(html).not.toMatch(/\bfetch\(/);
    expect(html).not.toMatch(/<script[^>]*\bsrc=/);
  });

  // A nonce authorizes <script> blocks only. These two constructs are NOT
  // covered by it and die silently under the policy — an `onclick=""` attribute
  // simply stops firing, with no error the user would connect to a CSP. Every
  // handler today is a `.onclick =` property assignment inside a script block,
  // which is unaffected; this keeps it that way.
  it('uses no inline event-handler attributes', () => {
    expect(read(name)).not.toMatch(/<[a-zA-Z][^>]*\son[a-z]+\s*=\s*"/);
  });

  it('uses no eval or Function constructor', () => {
    expect(read(name)).not.toMatch(/\beval\(|new Function\(/);
  });

  it('gets a distinct nonce per injection', () => {
    const html = read(name);
    const nonceOf = (s: string): string => /<script nonce="([^"]+)"/.exec(s)?.[1] ?? '';
    expect(nonceOf(injectCsp(html, newNonce()))).not.toBe(nonceOf(injectCsp(html, newNonce())));
  });
});
