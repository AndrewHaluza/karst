import { describe, it, expect } from 'vitest';
import {
  FOLLOW_UP_TEXT_MARKER,
  isFollowUp,
  followUpTextPrefix,
  compactTicketLabel,
} from './followUp.js';

describe('follow-up identity', () => {
  it('FOLLOW_UP_TEXT_MARKER is exactly one character', () => {
    expect(FOLLOW_UP_TEXT_MARKER).toBe('↳');
    expect([...FOLLOW_UP_TEXT_MARKER]).toHaveLength(1);
  });

  it('isFollowUp reads the parentTicketId domain fact, never the title', () => {
    expect(isFollowUp({ parentTicketId: 12 })).toBe(true);
    expect(isFollowUp({ parentTicketId: null })).toBe(false);
  });

  it('followUpTextPrefix renders the one-char marker with a trailing space, or nothing', () => {
    expect(followUpTextPrefix({ parentTicketId: 12 })).toBe('↳ ');
    expect(followUpTextPrefix({ parentTicketId: null })).toBe('');
  });

  it('compactTicketLabel prefixes a rendered label for a follow-up only', () => {
    expect(compactTicketLabel({ parentTicketId: 12 }, 'PROJ-1-fu1 — ship it')).toBe(
      '↳ PROJ-1-fu1 — ship it',
    );
    expect(compactTicketLabel({ parentTicketId: null }, 'PROJ-1 — ship it')).toBe(
      'PROJ-1 — ship it',
    );
  });
});
