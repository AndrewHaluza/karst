import { describe, it, expect } from 'vitest';
import { slugifyTitleKey, TITLE_KEY_MAX } from './titleKey.js';

describe('slugifyTitleKey', () => {
  it('uppercases and dash-joins the words of a title', () => {
    expect(slugifyTitleKey('Fix login redirect')).toBe('FIX-LOGIN-REDIRECT');
  });

  it('collapses punctuation and whitespace runs into a single dash', () => {
    expect(slugifyTitleKey('  [FIX] on  ticket/creation — key! ')).toBe('FIX-ON-TICKET-CREATION-KEY');
  });

  it('keeps digits', () => {
    expect(slugifyTitleKey('Bump vite 5 to 6')).toBe('BUMP-VITE-5-TO-6');
  });

  it('caps the key length and never ends on a dangling dash', () => {
    const key = slugifyTitleKey(
      'On ticket creation when no fetch clicked it does not open the rest of the view',
    );
    expect(key.length).toBeLessThanOrEqual(TITLE_KEY_MAX);
    expect(key).not.toMatch(/-$/);
    // Cuts on a word boundary rather than mid-word.
    expect(key).toBe('ON-TICKET-CREATION-WHEN-NO-FETCH');
  });

  it('returns an empty string when the title carries no key-able characters', () => {
    expect(slugifyTitleKey('   ')).toBe('');
    expect(slugifyTitleKey('—— ***')).toBe('');
    expect(slugifyTitleKey('')).toBe('');
  });

  it('is total over non-string input (webview payloads are untrusted)', () => {
    expect(slugifyTitleKey(undefined as unknown as string)).toBe('');
    expect(slugifyTitleKey(null as unknown as string)).toBe('');
  });
});
