import { describe, it, expect } from 'vitest';
import { priorityTitle } from './priority.js';

describe('priorityTitle', () => {
  it('names a draft level by the planner, with or without its reason, or by you', () => {
    expect(priorityTitle('high', 'planner')).toBe('High · planner');
    expect(priorityTitle('urgent', 'planner', 'leaks')).toBe('Urgent · planner: "leaks"');
    expect(priorityTitle('low', 'you')).toBe('Low · set by you');
  });

  it('names a provider value by the provider label', () => {
    expect(priorityTitle('high', 'provider', undefined, { label: 'ClickUp', level: 'high' })).toBe('High · ClickUp');
  });

  it('a user value over no provider value, or over the same one, shows only "set by you"', () => {
    expect(priorityTitle('high', 'you', undefined, { label: 'ClickUp', level: null })).toBe('High · set by you');
    expect(priorityTitle('high', 'you', undefined, { label: 'ClickUp', level: 'high' })).toBe('High · set by you');
  });

  it('a user value that differs from the provider value names both', () => {
    expect(priorityTitle('high', 'you', undefined, { label: 'ClickUp', level: 'low' })).toBe('High · set by you (ClickUp: Low)');
  });
});
