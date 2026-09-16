import { describe, expect, it } from 'vitest';
import { diffsTicketChoices, diffsTicketScope } from './ticketChoices.js';

function row(id: number, stageCurrent: string | null, key: string | null = `K-${id}`, title: string | null = `Ticket ${id}`) {
  return { id, key, title, stageCurrent };
}

describe('diffsTicketChoices', () => {
  it('excludes a ticket that has reached done', () => {
    const out = diffsTicketChoices([row(1, 'done'), row(2, 'impl')], null);
    expect(out.map((c) => c.ticketId)).toEqual([2]);
  });

  it('keeps a ticket whose stage is null (a null stage is not done)', () => {
    const out = diffsTicketChoices([row(1, null)], null);
    expect(out.map((c) => c.ticketId)).toEqual([1]);
  });

  it('renders a keyless ticket as #<id>', () => {
    const out = diffsTicketChoices([row(7, 'impl', null)], null);
    expect(out[0]!.label).toBe('#7');
  });

  it('maps title to description and falls back to an empty string when null', () => {
    const out = diffsTicketChoices([row(1, 'impl', 'K-1', null)], null);
    expect(out[0]!.description).toBe('');
  });

  it('marks the current ticket and floats it to index 0', () => {
    const out = diffsTicketChoices([row(1, 'impl'), row(2, 'impl'), row(3, 'impl')], 3);
    expect(out.map((c) => c.ticketId)).toEqual([3, 1, 2]);
    expect(out.map((c) => c.current)).toEqual([true, false, false]);
  });

  it('preserves order exactly when there is no current ticket', () => {
    const out = diffsTicketChoices([row(1, 'impl'), row(2, 'impl'), row(3, 'impl')], null);
    expect(out.map((c) => c.ticketId)).toEqual([1, 2, 3]);
    expect(out.some((c) => c.current)).toBe(false);
  });

  it('does not reorder or mark anything when the current id is absent', () => {
    const out = diffsTicketChoices([row(1, 'impl'), row(2, 'impl')], 99);
    expect(out.map((c) => c.ticketId)).toEqual([1, 2]);
    expect(out.some((c) => c.current)).toBe(false);
  });

  it('returns an empty array for empty input', () => {
    expect(diffsTicketChoices([], null)).toEqual([]);
  });
});

describe('diffsTicketScope', () => {
  it('refuses (null) when no project is bound, so no unscoped query runs', () => {
    expect(diffsTicketScope(undefined)).toBeNull();
  });

  it('scopes a resolved project id', () => {
    expect(diffsTicketScope(7)).toEqual({ projectId: 7 });
  });

  it('treats project id 0 as a real scope, not an absent one', () => {
    expect(diffsTicketScope(0)).toEqual({ projectId: 0 });
  });
});
