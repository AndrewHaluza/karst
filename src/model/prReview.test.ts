import { describe, it, expect } from 'vitest';
import {
  MAX_THREAD_COMMENTS,
  MAX_REVIEW_BODY,
  normalizeAuthor,
  normalizeReviewDecision,
  normalizeThread,
  parseThreadComments,
} from './prReview.js';

/** A minimal GraphQL `PullRequestReviewThread` node, as the query would return it. */
function threadNode(comments: unknown[]): unknown {
  return {
    id: 'PRRT_kwDOAAAA',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 3,
    startLine: null,
    originalLine: 3,
    subjectType: 'LINE',
    comments: { nodes: comments },
  };
}

function commentNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseId: 1,
    body: 'please rename this',
    createdAt: '2026-09-15T10:00:00Z',
    updatedAt: '2026-09-15T10:00:00Z',
    authorAssociation: 'MEMBER',
    author: { login: 'ada', __typename: 'User' },
    ...overrides,
  };
}

describe('normalizeReviewDecision', () => {
  it("normalises gh's empty-string 'no decision' to null", () => {
    // gh types reviewDecision as a Go string, so an absent decision arrives as ''
    // and never as null.
    expect(normalizeReviewDecision('')).toBeNull();
  });

  it('passes a real decision through unchanged', () => {
    expect(normalizeReviewDecision('CHANGES_REQUESTED')).toBe('CHANGES_REQUESTED');
  });

  it('normalises null and unrecognised values to null', () => {
    expect(normalizeReviewDecision(null)).toBeNull();
    expect(normalizeReviewDecision('WAT')).toBeNull();
  });
});

describe('normalizeAuthor', () => {
  it('keeps a Bot author with its GraphQL __typename', () => {
    // GitHub Apps acting for a user appear as the user, so the [bot] login suffix
    // is not a reliable detector; the __typename is.
    expect(normalizeAuthor({ login: 'dependabot', __typename: 'Bot' }, 'NONE')).toEqual({
      login: 'dependabot',
      typeName: 'Bot',
      association: 'NONE',
    });
  });
});

describe('normalizeThread', () => {
  it('keeps the OLDEST comments when a thread is over the cap', () => {
    // The FIRST comment is the reviewer's actual ask; the tail is discussion.
    const nodes = Array.from({ length: MAX_THREAD_COMMENTS + 5 }, (_, i) =>
      commentNode({ databaseId: i + 1, body: `c${i}` }),
    );
    const thread = normalizeThread(threadNode(nodes));
    expect(thread?.comments).toHaveLength(MAX_THREAD_COMMENTS);
    expect(thread?.comments[0]?.body).toBe('c0');
  });

  it('truncates an oversized body with an ellipsis', () => {
    const thread = normalizeThread(
      threadNode([commentNode({ body: 'x'.repeat(MAX_REVIEW_BODY + 50) })]),
    );
    expect(thread?.body.length).toBe(MAX_REVIEW_BODY + 1);
    expect(thread?.body.endsWith('…')).toBe(true);
  });

  it('drops a thread with no comments', () => {
    // No comments means no first comment, so no upstreamKey is derivable.
    expect(normalizeThread(threadNode([]))).toBeNull();
  });

  it('drops a thread whose only comment has a null databaseId', () => {
    expect(normalizeThread(threadNode([commentNode({ databaseId: null })]))).toBeNull();
  });
});

describe('parseThreadComments', () => {
  it('parses a malformed comments column as an empty list without throwing', () => {
    expect(parseThreadComments('not json')).toEqual([]);
  });
});
