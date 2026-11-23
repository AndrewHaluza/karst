import { describe, expect, it } from 'vitest';
import { diffsTicketArg, diffsTicketChoices, diffsTicketScope } from './ticketChoices.js';

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

  it('labels a keyed ticket T<id> · KEY', () => {
    expect(diffsTicketChoices([row(7, 'impl', 'ABC-1')], null)[0]!.label).toBe('T7 · ABC-1');
  });

  it('renders a keyless ticket as T<id>', () => {
    const out = diffsTicketChoices([row(7, 'impl', null)], null);
    expect(out[0]!.label).toBe('T7');
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

/**
 * Section 11 step 1: the SCM tree probe could not open a ticket, because the
 * command always waited on the quick pick. A positive integer command argument
 * now names the ticket; no argument keeps the picker.
 */
describe('diffsTicketArg', () => {
  it('takes a positive integer command argument as the ticket to show', () => {
    expect(diffsTicketArg(2)).toBe(2);
    expect(diffsTicketArg(1316)).toBe(1316);
  });

  it('returns undefined when the command had no argument, so the picker still runs', () => {
    expect(diffsTicketArg(undefined)).toBeUndefined();
  });

  it('rejects anything that is not a positive integer id', () => {
    expect(diffsTicketArg(0)).toBeUndefined();
    expect(diffsTicketArg(-3)).toBeUndefined();
    expect(diffsTicketArg(2.5)).toBeUndefined();
    expect(diffsTicketArg(Number.NaN)).toBeUndefined();
    expect(diffsTicketArg('2')).toBeUndefined();
    expect(diffsTicketArg(null)).toBeUndefined();
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
