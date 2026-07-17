import { describe, it, expect } from 'vitest';
import { isHttpUrl } from './url.js';

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://app.clickup.com/t/abc')).toBe(true);
    expect(isHttpUrl('http://localhost:3000/')).toBe(true);
  });

  it('accepts a scheme in any case — RFC 3986 schemes are case-insensitive', () => {
    expect(isHttpUrl('HTTPS://app.clickup.com/t/abc')).toBe(true);
  });

  // The point of the guard: these reach vscode.env.openExternal, so a crafted
  // webview message must not be able to drive a non-web scheme through it.
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'vscode://file/etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'command:workbench.action.terminal.new',
  ])('rejects the non-web scheme %s', (url) => {
    expect(isHttpUrl(url)).toBe(false);
  });

  it('rejects a scheme that merely contains http', () => {
    expect(isHttpUrl('nothttps://evil.example')).toBe(false);
    expect(isHttpUrl('javascript:void("https://ok")')).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
    expect(isHttpUrl({ toString: () => 'https://evil.example' })).toBe(false);
  });
});
