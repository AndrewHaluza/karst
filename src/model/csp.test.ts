import { describe, it, expect } from 'vitest';
import { injectCsp, newNonce, CSP_MARKER } from './csp.js';

const HTML = `${CSP_MARKER}\n<style>body{color:red}</style>\n<script>\nconst x=1;\n</script>\n`;

describe('newNonce', () => {
  it('is fresh per call — a reused nonce is a reusable injection target', () => {
    const seen = new Set(Array.from({ length: 50 }, newNonce));
    expect(seen.size).toBe(50);
  });

  it('is base64 and long enough to be unguessable', () => {
    const n = newNonce();
    expect(n).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(n, 'base64').length).toBeGreaterThanOrEqual(16);
  });
});

describe('injectCsp', () => {
  it('emits a policy that denies everything by default', () => {
    expect(injectCsp(HTML, 'N0NCE')).toContain("default-src 'none'");
  });

  it('grants scripts only via the nonce', () => {
    const out = injectCsp(HTML, 'N0NCE');
    expect(out).toContain("script-src 'nonce-N0NCE'");
    // 'unsafe-inline' in script-src would defeat the entire policy: it re-permits
    // any injected <script>, nonce or not.
    expect(out).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('tags every inline script with the nonce, or the UI never runs', () => {
    const out = injectCsp(HTML, 'N0NCE');
    expect(out).toContain('<script nonce="N0NCE">');
    expect(out).not.toMatch(/<script>/);
  });

  it('tags multiple scripts', () => {
    const out = injectCsp(`${CSP_MARKER}<script>a</script><script>b</script>`, 'N');
    expect(out.match(/<script nonce="N">/g)).toHaveLength(2);
  });

  // Styles are inline blocks plus a couple of style="" attributes; there is no
  // nonce path for those, and style is not the injection surface script is.
  it('allows inline styles', () => {
    expect(injectCsp(HTML, 'N0NCE')).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it('replaces the marker rather than leaving it behind', () => {
    const out = injectCsp(HTML, 'N0NCE');
    expect(out).not.toContain(CSP_MARKER);
    expect(out).toContain('http-equiv="Content-Security-Policy"');
  });

  // Same contract as injectPalette: a marker-less document passes through, so a
  // webview that hasn't opted in isn't corrupted.
  it('is a no-op on html with no marker', () => {
    const plain = '<style>x</style>';
    expect(injectCsp(plain, 'N0NCE')).toBe(plain);
  });
});
