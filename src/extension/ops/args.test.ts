import { describe, it, expect } from 'vitest';
import { ticketIdArg } from './args.js';

describe('ticketIdArg', () => {
  it('returns a bare number', () => {
    expect(ticketIdArg(42)).toBe(42);
  });

  it('returns ticketId from a shaped object', () => {
    expect(ticketIdArg({ ticketId: 7 })).toBe(7);
  });

  it('returns undefined for undefined', () => {
    expect(ticketIdArg(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(ticketIdArg(null)).toBeUndefined();
  });

  it('returns undefined for a string', () => {
    expect(ticketIdArg('42')).toBeUndefined();
  });

  it('returns undefined for an object without ticketId', () => {
    expect(ticketIdArg({ id: 5 })).toBeUndefined();
  });

  it('returns undefined when ticketId is not a number', () => {
    expect(ticketIdArg({ ticketId: '7' })).toBeUndefined();
  });

  it('returns undefined for a negative number', () => {
    expect(ticketIdArg(-1)).toBe(-1);
  });

  it('returns undefined for zero', () => {
    expect(ticketIdArg(0)).toBe(0);
  });
});
