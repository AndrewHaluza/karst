import { describe, expect, it } from 'vitest';
import { PREFIX, formatId, formatTicketRef, parseId, ticketRefOrUnknown } from './entityId.js';

describe('entityId', () => {
  it('has the pinned prefix map', () => {
    expect(PREFIX).toEqual({ ticket: 'T', draft: 'D', plan: 'P' });
  });
  it('formats', () => {
    expect(formatId('ticket', 583)).toBe('T583');
    expect(formatId('draft', 88)).toBe('D88');
    expect(formatId('plan', 17)).toBe('P17');
  });
  it('formats a ticket ref with and without key', () => {
    expect(formatTicketRef(583, 'ABC-123')).toBe('T583 · ABC-123');
    expect(formatTicketRef(583, null)).toBe('T583');
    expect(formatTicketRef(583, '  ')).toBe('T583');
  });
  it('rejects a non-positive or non-integer number when formatting', () => {
    expect(() => formatId('ticket', 0)).toThrow(/positive integer/);
    expect(() => formatId('ticket', 1.5)).toThrow(/positive integer/);
  });
  it('parses prefixed ids, either case, with or without expectedKind', () => {
    expect(parseId('T583 · ABC-123', 'ticket')).toEqual({ kind: 'ticket', n: 583 });
    expect(parseId('583 · X', 'ticket')).toEqual({ kind: 'ticket', n: 583 });
    expect(() => parseId('T5 x', 'ticket')).toThrow();
    expect(parseId('T583')).toEqual({ kind: 'ticket', n: 583 });
    expect(parseId('t583', 'ticket')).toEqual({ kind: 'ticket', n: 583 });
    expect(parseId('D88')).toEqual({ kind: 'draft', n: 88 });
    expect(parseId('p17')).toEqual({ kind: 'plan', n: 17 });
  });
  it('accepts bare and legacy # only with expectedKind', () => {
    expect(parseId('583', 'ticket')).toEqual({ kind: 'ticket', n: 583 });
    expect(parseId('#88', 'draft')).toEqual({ kind: 'draft', n: 88 });
    expect(() => parseId('583')).toThrow(/prefix/);
    expect(() => parseId('#583')).toThrow(/prefix/);
  });
  it('rejects a wrong kind naming the expected prefix', () => {
    expect(() => parseId('D88', 'ticket')).toThrow(/expected a ticket id \(T<n>\).*D88/);
  });
  it('rejects junk, zero, leading zeros, signs and whitespace-padded input', () => {
    for (const bad of ['', 'T', 'T0', 'T01', 'T-5', 'X5', 'T5x', '0', '01', '-3', '1.5', 'T 5'])
      expect(() => parseId(bad, 'ticket')).toThrow();
    expect(parseId(' T5 ', 'ticket').n).toBe(5); // trimmed
  });
  it('rejects unsafe huge numbers', () => {
    expect(() => parseId('T99999999999999999999', 'ticket')).toThrow();
  });
});

describe('ticketRefOrUnknown', () => {
  it('formats a known ticket id and names an unknown one', () => {
    expect(ticketRefOrUnknown(5)).toBe('T5');
    expect(ticketRefOrUnknown(0)).toBe('unknown ticket');
  });
});
