import { describe, expect, it } from 'vitest';
import { nextSort } from './SortableTable.js';

describe('nextSort', () => {
  it('starts a text column ascending', () => {
    expect(nextSort({ key: null, dir: null }, 'label', false)).toEqual({ key: 'label', dir: 'asc' });
  });

  it('starts a numeric column descending — the biggest number first (RS-21)', () => {
    expect(nextSort({ key: null, dir: null }, 'rss', true)).toEqual({ key: 'rss', dir: 'desc' });
  });

  it('cycles asc → desc → default', () => {
    expect(nextSort({ key: 'label', dir: 'asc' }, 'label', false)).toEqual({ key: 'label', dir: 'desc' });
    expect(nextSort({ key: 'label', dir: 'desc' }, 'label', false)).toEqual({ key: null, dir: null });
  });

  it('cycles a numeric column desc → asc → default', () => {
    expect(nextSort({ key: 'pid', dir: 'desc' }, 'pid', true)).toEqual({ key: 'pid', dir: 'asc' });
    expect(nextSort({ key: 'pid', dir: 'asc' }, 'pid', true)).toEqual({ key: null, dir: null });
  });

  it('starts a new column from its own direction', () => {
    expect(nextSort({ key: 'label', dir: 'asc' }, 'rss', true)).toEqual({ key: 'rss', dir: 'desc' });
  });

  it('recovers a direction when the same key has none', () => {
    expect(nextSort({ key: 'pid', dir: null }, 'pid', true)).toEqual({ key: 'pid', dir: 'desc' });
  });
});
