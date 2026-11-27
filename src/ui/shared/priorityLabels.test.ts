import { describe, it, expect } from 'vitest';
import type { PriorityLevel } from '../../model/priority.js';
import { levelLabel, levelShort, priorityTextTitle, priorityTitle } from './priorityLabels.js';

const LEVELS: readonly PriorityLevel[] = ['urgent', 'high', 'normal', 'low'];

describe('levelLabel / levelShort', () => {
  it('phrases every level as a word and as the short chip text', () => {
    expect(LEVELS.map((level) => levelLabel(level))).toEqual(['Urgent', 'High', 'Normal', 'Low']);
    expect(LEVELS.map((level) => levelShort(level))).toEqual(['URG', 'HIGH', 'NORM', 'LOW']);
  });
});

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

describe('priorityTextTitle', () => {
  it('is just the text when nothing says who set it', () => {
    expect(priorityTextTitle('P2')).toBe('P2');
    expect(priorityTextTitle('P2', null)).toBe('P2');
  });

  it('names the provider beside a non-level provider label', () => {
    expect(priorityTextTitle('P2', 'provider', undefined, { label: 'ClickUp', level: null })).toBe('P2 · ClickUp');
    expect(priorityTextTitle('P2', 'provider')).toBe('P2 · provider');
  });

  it('names the user or the planner, with the planner reason when it has one', () => {
    expect(priorityTextTitle('P2', 'you')).toBe('P2 · set by you');
    expect(priorityTextTitle('P2', 'planner')).toBe('P2 · planner');
    expect(priorityTextTitle('P2', 'planner', 'leaks')).toBe('P2 · planner: "leaks"');
  });
});
