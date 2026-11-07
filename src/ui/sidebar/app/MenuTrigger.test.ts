import { describe, it, expect } from 'vitest';
import type { TicketRow } from '../state.js';
import { ticketMenuItems } from './MenuTrigger.js';

const row = (over: Partial<TicketRow> = {}) =>
  ({ ticketId: 4, paused: false, canClose: true, canReopen: false, canDetach: false, ...over }) as unknown as TicketRow;

describe('ticketMenuItems — review stall', () => {
  it('no longer offers the old stall answers', () => {
    const acts = ticketMenuItems(row({ reviewStalled: true } as Partial<TicketRow>)).map((i) => i.spec.act);
    expect(acts.filter((a) => a?.startsWith('review-stall'))).toEqual([]);
  });
});
