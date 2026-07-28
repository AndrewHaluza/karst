import { describe, it, expect } from 'vitest';
import { TICKET_TYPES, DEFAULT_TICKET_TYPE, isTicketType } from './ticketTypes.js';

describe('ticket types', () => {
  it('curates the conventional-commit vocabulary', () => {
    expect(TICKET_TYPES).toEqual([
      'feat',
      'fix',
      'refactor',
      'docs',
      'test',
      'chore',
      'perf',
      'ci',
      'build',
      'style',
      'revert',
    ]);
  });

  it('defaults to feat', () => {
    expect(DEFAULT_TICKET_TYPE).toBe('feat');
    expect(TICKET_TYPES).toContain(DEFAULT_TICKET_TYPE);
  });

  it('narrows a known type and rejects anything else', () => {
    expect(isTicketType('fix')).toBe(true);
    expect(isTicketType('FIX')).toBe(false); // vocabulary is lowercase, exact
    expect(isTicketType('feature')).toBe(false);
    expect(isTicketType('')).toBe(false);
  });
});
