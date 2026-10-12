import { describe, it, expect } from 'vitest';
import { slugifyTitleKey, TITLE_KEY_MAX, isPlaceholderTitle } from './titleKey.js';

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

  // The placeholder is the draft title `ensureTicket` seeds every unbound form
  // with — never something the user typed. Deriving UNTITLED-TICKET from it keyed
  // every older, since-archived draft identically and let their pushed branches
  // collide on re-use (T640). No key at all, so the caller falls back to MANUAL-…
  it('returns an empty string for the default placeholder title', () => {
    expect(slugifyTitleKey('Untitled ticket')).toBe('');
    expect(slugifyTitleKey('  Untitled Ticket  ')).toBe('');
  });
});

describe('isPlaceholderTitle', () => {
  it('matches the placeholder case-insensitively, ignoring surrounding whitespace', () => {
    expect(isPlaceholderTitle('Untitled ticket')).toBe(true);
    expect(isPlaceholderTitle('untitled TICKET')).toBe(true);
    expect(isPlaceholderTitle('  Untitled ticket  ')).toBe(true);
  });

  it('is false for a real title and for empty/non-string input', () => {
    expect(isPlaceholderTitle('Untitled ticket collision')).toBe(false);
    expect(isPlaceholderTitle('Fix login redirect')).toBe(false);
    expect(isPlaceholderTitle('')).toBe(false);
    expect(isPlaceholderTitle(undefined as unknown as string)).toBe(false);
    expect(isPlaceholderTitle(null as unknown as string)).toBe(false);
  });
});
