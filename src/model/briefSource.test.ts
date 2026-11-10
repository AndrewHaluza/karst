import { describe, it, expect } from 'vitest';
import { deriveBriefSource, briefSourceLabel } from './briefSource.js';

describe('deriveBriefSource', () => {
  it('is the provider after a fetch', () => {
    expect(deriveBriefSource({ sourceFetchedAt: '2026-01-01' }, 'jira', 4)).toEqual({ kind: 'provider', provider: 'jira' });
  });
  it('is the accepted draft without a fetch', () => {
    expect(deriveBriefSource({ sourceFetchedAt: null }, 'jira', 4)).toEqual({ kind: 'draft', draftId: 4 });
  });
  it('is manual with neither', () => {
    expect(deriveBriefSource({ sourceFetchedAt: null }, null, null)).toEqual({ kind: 'manual' });
  });
  it('is manual after a fetch that has no provider', () => {
    expect(deriveBriefSource({ sourceFetchedAt: 'x' }, null, null)).toEqual({ kind: 'manual' });
  });
});

describe('briefSourceLabel', () => {
  it('labels each source', () => {
    expect(briefSourceLabel({ kind: 'provider', provider: 'jira' })).toBe('from Jira');
    expect(briefSourceLabel({ kind: 'draft', draftId: 7 })).toBe('from planning draft D7');
    expect(briefSourceLabel({ kind: 'manual' })).toBeNull();
  });
});
