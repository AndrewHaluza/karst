import { describe, it, expect } from 'vitest';
import { ticketLabel } from './sessionIdentity.js';

describe('ticketLabel', () => {
  it('prints the prefixed id with the key', () => {
    expect(ticketLabel({ id: 3, key: 'K-1' })).toBe('T3 · K-1');
  });
  it('prints the prefixed id alone when keyless', () => {
    expect(ticketLabel({ id: 3, key: null })).toBe('T3');
  });
});
