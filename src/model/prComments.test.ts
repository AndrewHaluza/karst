import { describe, it, expect } from 'vitest';
import {
  MAX_STORED_COMMENTS,
  MAX_COMMENT_BODY,
  normalizeComments,
  serializeComments,
  parseComments,
} from './prComments.js';

describe('normalizeComments', () => {
  it('keeps author, stamp and body from gh comment objects', () => {
    expect(
      normalizeComments([
        { author: { login: 'ada' }, createdAt: '2026-07-24T10:00:00Z', body: 'looks good' },
      ]),
    ).toEqual([{ author: 'ada', at: '2026-07-24T10:00:00Z', body: 'looks good' }]);
  });

  it('degrades a comment with missing fields instead of dropping it', () => {
    // A comment karst cannot fully describe is still a comment: the count must
    // stay true, so the unknown parts render as absent rather than the row vanishing.
    expect(normalizeComments([{ body: 'anon note' }])).toEqual([
      { author: '', at: null, body: 'anon note' },
    ]);
  });

  it('returns null for anything that is not an array — never an empty list', () => {
    // [] is a real answer ("no comments"); null is "gh did not tell us". Collapsing
    // the second into the first would render "no comments" for an unprobed PR.
    expect(normalizeComments(undefined)).toBeNull();
    expect(normalizeComments(null)).toBeNull();
    expect(normalizeComments('3')).toBeNull();
    expect(normalizeComments([])).toEqual([]);
  });

  it('skips entries that are not objects', () => {
    expect(normalizeComments(['nope', 7, { body: 'real' }])).toEqual([
      { author: '', at: null, body: 'real' },
    ]);
  });

  it('keeps the NEWEST comments when a PR has more than the cap', () => {
    // gh returns oldest-first, and the recent end of a long thread is the part a
    // reader needs before merging.
    const many = Array.from({ length: MAX_STORED_COMMENTS + 5 }, (_, i) => ({ body: `c${i}` }));
    const kept = normalizeComments(many);
    expect(kept).toHaveLength(MAX_STORED_COMMENTS);
    expect(kept?.[kept.length - 1]?.body).toBe(`c${MAX_STORED_COMMENTS + 4}`);
  });

  it('truncates an oversized body rather than storing a whole essay', () => {
    const kept = normalizeComments([{ body: 'x'.repeat(MAX_COMMENT_BODY + 50) }]);
    expect(kept?.[0]?.body.length).toBe(MAX_COMMENT_BODY + 1); // + the ellipsis
    expect(kept?.[0]?.body.endsWith('…')).toBe(true);
  });
});

describe('serializeComments / parseComments', () => {
  it('round-trips', () => {
    const comments = [{ author: 'ada', at: '2026-07-24T10:00:00Z', body: 'ship it' }];
    expect(parseComments(serializeComments(comments))).toEqual(comments);
  });

  it('serializes null as null (never as "[]")', () => {
    expect(serializeComments(null)).toBeNull();
    expect(serializeComments([])).toBe('[]');
  });

  it('parses an absent or malformed column as an empty list, never a throw', () => {
    // The column is data karst wrote, but a hand-edited or half-written row must
    // not take the dashboard down: render no comments and move on.
    expect(parseComments(null)).toEqual([]);
    expect(parseComments('')).toEqual([]);
    expect(parseComments('{not json')).toEqual([]);
    expect(parseComments('{"a":1}')).toEqual([]);
  });
});
