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
      'gettingStarted',
      'resources',
      'serverLogs',
      'settings',
      'sidebar',
      'ticketForm',
      'usage',
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

  // The policy is only this tight because nothing loads externally. The ticket form
  // is the narrow exception: its attachment renderer emits img/video elements,
  // and its panel alone receives the media-source CSP grant (the dashboard gets the
  // same grant for img only, for the UAT report's baseline images). If another webview
  // gains a <link>/<img>/<video>/url()/fetch(), default-src 'none' silently
  // breaks it — better to fail here, at the assumption, than to debug a blank
  // panel.
  it('loads nothing externally, which is what default-src none assumes', () => {
    const html = read(name);
    expect(html).not.toMatch(/<link\b/);
    if (name === 'ticketForm') {
      expect(html).toMatch(/<img\b/);
      expect(html).toMatch(/<video\b/);
    } else if (name === 'dashboard') {
      // The UAT report's baseline review shows images (@arch:BASELINE-REVIEW).
      expect(html).toMatch(/<img\b/);
      expect(html).not.toMatch(/<video\b/);
    } else {
      expect(html).not.toMatch(/<img\b/);
      expect(html).not.toMatch(/<video\b/);
    }
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

describe('media source', () => {
  const SOURCE = 'vscode-resource://karst';

  it('omits img-src and media-src when no media source is given', () => {
    const html = injectCsp(read('ticketForm'), newNonce());
    expect(html).not.toContain('img-src');
    expect(html).not.toContain('media-src');
  });

  it('grants the dashboard the media source for the baseline images, and its host wires it with a single fixed root', () => {
    const html = injectCsp(read('dashboard'), newNonce(), SOURCE);
    expect(html).toContain(`img-src ${SOURCE};`);
    expect(html).toContain("default-src 'none';");
    // host.ts needs `vscode`, so it is checked at the source: the CSP gets the
    // webview's own source, and the ONLY local resource root is the storage
    // directory the baseline images are copied into (@arch:BASELINE-REVIEW).
    const host = readFileSync(join(HERE, 'dashboard', 'host.ts'), 'utf8');
    expect(host).toContain('injectCsp(html, newNonce(), panel.webview.cspSource)');
    expect(host).toContain(
      'localResourceRoots: [vscode.Uri.file(baselineReviewRoot(context.globalStorageUri.fsPath))]',
    );
  });

  it('grants img-src and media-src to exactly the given source', () => {
    const html = injectCsp(read('ticketForm'), newNonce(), SOURCE);
    expect(html).toContain(`img-src ${SOURCE};`);
    expect(html).toContain(`media-src ${SOURCE};`);
  });

  // Widening for attachments must not weaken anything else. default-src stays
  // 'none' and script-src stays nonce-only — an img-src grant is not a reason to
  // let a script in.
  it('leaves the rest of the policy untouched when widened', () => {
    const nonce = newNonce();
    const html = injectCsp(read('ticketForm'), nonce, SOURCE);
    expect(html).toContain("default-src 'none';");
    expect(html).toContain(`script-src 'nonce-${nonce}';`);
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toContain("default-src 'self'");
  });

  it('never widens a webview that was not given a source', () => {
    for (const name of WEBVIEWS) {
      const html = injectCsp(read(name), newNonce());
      expect(html, name).not.toContain('img-src');
      expect(html, name).not.toContain('media-src');
    }
  });
});

// The nonce is added to `<script>` OPENING TAGS only. The settings app bundle
// embeds a literal "<script></script>" inside a JS string (script-element
// hydration, NDL-126 §2), and the pre-phase-4 `replaceAll('<script>', …)` would
// have rewritten that string's tag and corrupted the shipped bundle. This is the
// direct case for the lookbehind — a future "simplify this regex" fails here
// instead of in a hydrated render (NDL-143 review round 1, non-blocking ask).
describe('nonce tagging — the lookbehind', () => {
  it('tags the real opening tag but never a <script> inside a JS string', () => {
    const nonce = 'csp-lookbehind-pin';
    const html =
      '<!--KARST_CSP--><script>resource.innerHTML = "<script></script>";</script>';
    const out = injectCsp(html, nonce);
    // The document's one real opening tag carries the nonce …
    expect(out).toContain(`<script nonce="${nonce}">resource.innerHTML`);
    // … and the string literal's tag is byte-for-byte untouched.
    expect(out).toContain('innerHTML = "<script></script>"');
    expect(out.match(/<script/g) ?? []).toHaveLength(2);
    expect(out).toContain(
      `<script nonce="${nonce}">resource.innerHTML = "<script></script>";</script>`,
    );
  });
});
