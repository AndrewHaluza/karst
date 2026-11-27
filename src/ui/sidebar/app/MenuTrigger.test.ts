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

describe('ticketMenuItems — labels', () => {
  it('names each action without a trailing "…"; the tooltip keeps the explanation', () => {
    const items = ticketMenuItems(row({ canDetach: true, canReopen: true }));
    for (const i of items) expect(i.label, i.key).not.toMatch(/…$/);
    const byKey = (k: string) => items.find((i) => i.key === k);
    expect(byKey('detach')?.label).toBe('Detach from parent');
    expect(byKey('close')?.label).toBe('Close');
    expect(byKey('close')?.title).toBe('Mark closed: the work was done outside Karst. Nothing is verified');
    expect(byKey('cloud-add')?.label).toBe('Link cloud session');
  });
});
