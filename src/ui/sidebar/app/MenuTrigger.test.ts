import { describe, it, expect } from 'vitest';
import type { TicketRow } from '../state.js';
import { ticketMenuItems } from './MenuTrigger.js';

const row = (over: Partial<TicketRow> = {}) =>
  ({ ticketId: 4, paused: false, canClose: true, canReopen: false, canDetach: false, reviewStalled: false, ...over }) as unknown as TicketRow;

describe('ticketMenuItems — review stall (T845)', () => {
  it('offers the three answers only while the ticket is parked on a stall', () => {
    expect(ticketMenuItems(row()).map((i) => i.spec.act)).not.toContain('review-stall-hint');
    const acts = ticketMenuItems(row({ reviewStalled: true })).map((i) => i.spec.act);
    expect(acts).toEqual(expect.arrayContaining(['review-stall-hint', 'review-stall-continue', 'review-stall-rescope']));
  });
});
