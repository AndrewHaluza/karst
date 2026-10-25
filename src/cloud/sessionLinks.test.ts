import { describe, expect, it } from 'vitest';
import { isOpenableCloudUrl, providerForUrl, scanCloudSessionUrls } from './sessionLinks.js';

const A = 'https://claude.ai/code/session_012yGwsNP8VuGqYEHwNKssKB';
const B = 'https://claude.ai/code/session_abc-DEF_123';

describe('scanCloudSessionUrls', () => {
  it('finds a URL anywhere in free text, not just trailers', () => {
    const r = scanCloudSessionUrls(`fix: x\n\nbody ${A}.\nmore`);
    expect(r).toEqual([{ provider: 'claude', label: 'Claude Code on the web', url: A }]);
  });
  it('dedupes and keeps first-seen order', () => {
    expect(scanCloudSessionUrls(`${B} ${A} ${B}`).map((r) => r.url)).toEqual([B, A]);
  });
  it('returns nothing for text without a session', () => {
    expect(scanCloudSessionUrls('https://claude.ai/code/ nothing')).toEqual([]);
    expect(scanCloudSessionUrls('')).toEqual([]);
  });
});

describe('isOpenableCloudUrl', () => {
  it('accepts https on a registered host', () => expect(isOpenableCloudUrl(A)).toBe(true));
  it.each([
    'http://claude.ai/code/session_x',
    'https://evil.example/code/session_x',
    'https://claude.ai.evil.example/x',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (u) => expect(isOpenableCloudUrl(u)).toBe(false));
});

describe('providerForUrl', () => {
  it('matches the whole url only', () => {
    expect(providerForUrl(A)?.provider).toBe('claude');
    expect(providerForUrl(`${A}/extra`)).toBeUndefined();
    expect(providerForUrl(`x${A}`)).toBeUndefined();
  });
});
