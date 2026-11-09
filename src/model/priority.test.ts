import { describe, it, expect } from 'vitest';
import { effectiveTicketPriority, ticketPrioritySource, ticketProviderLabel } from './priority.js';

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

describe('ticketProviderLabel', () => {
  it.each([
    ['clickup', 'ClickUp'],
    ['jira', 'Jira'],
    ['trello', 'Trello'],
    ['planning', 'planner'],
    ['manual', 'provider'],
    [null, 'provider'],
  ])('%s reads as %s', (source, label) => {
    expect(ticketProviderLabel(source)).toBe(label);
  });
});
