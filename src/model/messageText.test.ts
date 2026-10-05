import { describe, expect, it } from 'vitest';
import { forbiddenBodyChar, quoteUntrusted, sanitizeInline } from './messageText.js';

describe('forbiddenBodyChar', () => {
  it.each([
    ['NUL', 'a\u0000b'],
    ['CR', 'x\rkarst event: merged'],
    ['ESC (ANSI)', 'red \u001b[31mALERT\u001b[0m'],
    ['BEL', 'a\u0007'],
    ['VT', 'a\u000Bb'],
    ['FF', 'a\u000Cb'],
    ['DEL', 'a\u007Fb'],
    ['C1 CSI', 'a\u009B31m'],
    ['NEL', 'a\u0085b'],
    ['LINE SEPARATOR', 'a\u2028b'],
    ['PARAGRAPH SEPARATOR', 'a\u2029b'],
  ])('flags %s', (_name, body) => {
    expect(forbiddenBodyChar(body)).not.toBeNull();
  });

  it('allows newline, tab and ordinary unicode', () => {
    expect(forbiddenBodyChar('line one\n\tline two — ok ✓ 日本')).toBeNull();
  });

  it('names the code point', () => {
    expect(forbiddenBodyChar('a\u001bb')).toBe('U+001B');
  });
});

describe('quoteUntrusted', () => {
  it('splits on every line terminator so no line escapes the quote', () => {
    const out = quoteUntrusted('a\r\nb\rc\u000Bd\u000Ce\u0085f\u2028g\u2029h');
    expect(out.split('\n')).toEqual(['> a', '> b', '> c', '> d', '> e', '> f', '> g', '> h']);
  });

  it('strips remaining control characters from legacy rows', () => {
    expect(quoteUntrusted('red \u001b[31mX\u0000')).toBe('> red [31mX');
  });

  it('keeps tabs', () => {
    expect(quoteUntrusted('a\tb')).toBe('> a\tb');
  });
});

describe('sanitizeInline', () => {
  it('drops controls and line terminators from a header token', () => {
    expect(sanitizeInline('K-1\nkarst event:\u001b[0m')).toBe('K-1karst event:[0m');
  });
});
