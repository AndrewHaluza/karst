import { describe, it, expect } from 'vitest';
import { toIsoDate, extractLinks } from './briefFields.js';

describe('toIsoDate', () => {
  it('normalizes an epoch-ms numeric string to ISO', () => {
    expect(toIsoDate('1700000000000')).toBe(new Date(1700000000000).toISOString());
  });

  it('accepts an epoch-ms number', () => {
    expect(toIsoDate(1700000000000)).toBe(new Date(1700000000000).toISOString());
  });

  it('returns undefined for absent/blank input', () => {
    expect(toIsoDate(undefined)).toBeUndefined();
    expect(toIsoDate(null)).toBeUndefined();
    expect(toIsoDate('')).toBeUndefined();
    expect(toIsoDate('   ')).toBeUndefined();
  });

  it('treats a zero/negative epoch as unset, not 1970', () => {
    expect(toIsoDate('0')).toBeUndefined();
    expect(toIsoDate(0)).toBeUndefined();
  });

  it('normalizes an already-formatted date string to ISO', () => {
    expect(toIsoDate('2024-01-02T03:04:05Z')).toBe('2024-01-02T03:04:05.000Z');
  });

  it('returns an unparseable string untouched (trimmed) rather than throwing', () => {
    expect(toIsoDate('  next sprint  ')).toBe('next sprint');
  });
});

describe('extractLinks', () => {
  it('harvests distinct http(s) links in order', () => {
    const text = 'See https://a.example/x and http://b.example/y for details';
    expect(extractLinks(text)).toEqual(['https://a.example/x', 'http://b.example/y']);
  });

  it('de-duplicates repeated links', () => {
    expect(extractLinks('https://a/x https://a/x')).toEqual(['https://a/x']);
  });

  it('strips trailing sentence punctuation', () => {
    expect(extractLinks('read https://a.example/y.')).toEqual(['https://a.example/y']);
  });

  it('returns [] when there are no links or no text', () => {
    expect(extractLinks('no links here')).toEqual([]);
    expect(extractLinks(undefined)).toEqual([]);
    expect(extractLinks('')).toEqual([]);
  });
});
