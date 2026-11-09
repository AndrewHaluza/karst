import { describe, it, expect } from 'vitest';
import { effectiveTicketPriority, ticketPrioritySource, ticketProviderLabel, ticketProviderPriority } from './priority.js';

describe('effectiveTicketPriority', () => {
  it.each([
    [{ priority: null, priorityOverride: null }, null, null],
    [{ priority: 'low', priorityOverride: null }, 'low', 'provider'],
    [{ priority: null, priorityOverride: 'high' }, 'high', 'you'],
    [{ priority: 'low', priorityOverride: 'high' }, 'high', 'you'],
    [{ priority: 'Whatever', priorityOverride: null }, null, null],
    [{ priority: 'Whatever', priorityOverride: 'bogus' }, null, null],
    [{ priority: 'low', priorityOverride: 'bogus' }, 'low', 'provider'],
  ])('%j reads as %s from %s', (t, level, source) => {
    expect(effectiveTicketPriority(t)).toBe(level);
    expect(ticketPrioritySource(t)).toBe(source);
  });
});

describe('planner-written ticket priority', () => {
  const planned = { priority: 'high', priorityOverride: null, source: 'planning', sourceRef: null };
  it('reads as planner while the ticket has no provider ref', () => {
    expect(ticketPrioritySource(planned)).toBe('planner');
    expect(ticketProviderPriority(planned)).toBeNull();
  });
  it('reads as provider once a fetch bound a source ref', () => {
    const fetched = { ...planned, sourceRef: 'abc123' };
    expect(ticketPrioritySource(fetched)).toBe('provider');
    expect(ticketProviderPriority(fetched)).toBe('high');
  });
  it('keeps a user override as you', () => {
    expect(ticketPrioritySource({ ...planned, priorityOverride: 'low' })).toBe('you');
  });
});

describe('ticketProviderLabel', () => {
  it.each([
    ['clickup', 'ClickUp'],
    ['manual', 'provider'],
    [null, 'provider'],
    [undefined, 'provider'],
  ])('the project provider %s reads as %s', (provider, label) => {
    expect(ticketProviderLabel(provider)).toBe(label);
  });
});
