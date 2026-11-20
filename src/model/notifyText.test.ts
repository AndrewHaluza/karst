import { describe, expect, it } from 'vitest';
import { markerAdvancedText, plural, reasonText, ticketLabel } from './notifyText.js';

describe('ticketLabel', () => {
  it('joins the ref and the quoted title', () => {
    expect(ticketLabel(12, 'KAR-12', 'Fix login')).toBe('T12 · KAR-12 "Fix login"');
  });
  it('omits a missing or blank key', () => {
    expect(ticketLabel(12, null, 'Fix login')).toBe('T12 "Fix login"');
    expect(ticketLabel(12, '  ', 'Fix login')).toBe('T12 "Fix login"');
  });
  it('omits a missing or blank title', () => {
    expect(ticketLabel(12, 'KAR-12', undefined)).toBe('T12 · KAR-12');
    expect(ticketLabel(12, 'KAR-12', '   ')).toBe('T12 · KAR-12');
  });
  it('keeps a title of exactly 40 characters', () => {
    const t = 'a'.repeat(40);
    expect(ticketLabel(1, null, t)).toBe(`T1 "${t}"`);
  });
  it('cuts a longer title to 40 characters with an ellipsis', () => {
    const out = ticketLabel(1, null, 'a'.repeat(41));
    expect(out).toBe(`T1 "${'a'.repeat(39)}…"`);
  });
  it('collapses line breaks in the title', () => {
    expect(ticketLabel(1, null, 'one\ntwo')).toBe('T1 "one two"');
  });
});

describe('reasonText', () => {
  it('takes the first non-empty line of an Error message', () => {
    expect(reasonText(new Error('\n  boom happened \nsecond'))).toBe('boom happened');
  });
  it('accepts a string', () => {
    expect(reasonText('plain')).toBe('plain');
  });
  it('returns unknown error when there is no message', () => {
    expect(reasonText(new Error(''))).toBe('unknown error');
    expect(reasonText(undefined)).toBe('unknown error');
    expect(reasonText({ code: 1 })).toBe('unknown error');
  });
  it('refuses JSON', () => {
    expect(reasonText(new Error('{"error":"x"}'))).toBe('unknown error');
    expect(reasonText(new Error('[1,2]'))).toBe('unknown error');
  });
  it('cuts at 200 characters', () => {
    expect(reasonText(new Error('x'.repeat(200)))).toBe('x'.repeat(200));
    const out = reasonText(new Error('x'.repeat(201)));
    expect(out).toHaveLength(200);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('plural', () => {
  it('uses the one form for 1 only', () => {
    expect(plural(1, 'repo', 'repos')).toBe('1 repo');
    expect(plural(0, 'repo', 'repos')).toBe('0 repos');
    expect(plural(2, 'repo', 'repos')).toBe('2 repos');
  });
});

describe('markerAdvancedText', () => {
  it('names the ticket and no internal word', () => {
    const t = markerAdvancedText('T1 "x"');
    expect(t).toBe('T1 "x": the implementation is done. The ticket moves to UAT.');
    expect(t).not.toMatch(/marker|graph run|Ticket T/u);
  });
});
