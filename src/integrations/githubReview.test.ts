import { describe, it, expect } from 'vitest';
import {
  PR_FEEDBACK_QUERY,
  THREAD_PAGE,
  THREAD_COMMENT_PAGE,
  REVIEW_PAGE,
  fetchPrReviewState,
  parsePrRef,
  type PrRef,
} from './githubReview.js';
import type { GhRunner, GhResult } from './github.js';

const REF: PrRef = { owner: 'acme', name: 'rocket', number: 42 };
const CWD = '/tmp/repo';

function ok(stdout: unknown): GhResult {
  return { stdout: JSON.stringify(stdout), exitCode: 0 };
}

function runnerFor(result: GhResult, captured: string[][] = []): GhRunner {
  return async (args) => {
    captured.push(args);
    return result;
  };
}

function commentNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseId: 111,
    body: 'please rename this',
    createdAt: '2026-09-15T10:00:00Z',
    updatedAt: '2026-09-15T10:00:00Z',
    authorAssociation: 'MEMBER',
    author: { login: 'ada', __typename: 'User' },
    originalCommit: { oid: 'abc123' },
    ...overrides,
  };
}

function threadNode(
  overrides: Record<string, unknown> = {},
  comments: Record<string, unknown>[] = [commentNode()],
): Record<string, unknown> {
  return {
    id: 'PRRT_kwDOAAAA',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 3,
    startLine: null,
    originalLine: 3,
    subjectType: 'LINE',
    comments: { totalCount: comments.length, nodes: comments },
    ...overrides,
  };
}

function prNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewDecision: 'CHANGES_REQUESTED',
    reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    ...overrides,
  };
}

function payload(pr: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { data: { repository: { pullRequest: pr } }, ...extra };
}

async function probeFor(
  pr: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof fetchPrReviewState>>> {
  return fetchPrReviewState(runnerFor(ok(payload(pr, extra))), REF, CWD);
}

describe('fetchPrReviewState', () => {
  it('returns null on a non-zero exit', async () => {
    const probe = await fetchPrReviewState(
      runnerFor({ stdout: '', exitCode: 1, stderr: 'boom' }),
      REF,
      CWD,
    );
    expect(probe).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const probe = await fetchPrReviewState(
      runnerFor({ stdout: 'not json', exitCode: 0 }),
      REF,
      CWD,
    );
    expect(probe).toBeNull();
  });

  it('returns null when errors accompany an absent pullRequest', async () => {
    const probe = await fetchPrReviewState(
      runnerFor(
        ok({
          data: { repository: { pullRequest: null } },
          errors: [{ message: 'Field does not exist' }],
        }),
      ),
      REF,
      CWD,
    );
    expect(probe).toBeNull();
  });

  it('returns null when errors accompany a PRESENT pullRequest (partial probe)', async () => {
    const probe = await fetchPrReviewState(
      runnerFor(ok(payload(prNode(), { errors: [{ message: 'partial' }] }))),
      REF,
      CWD,
    );
    expect(probe).toBeNull();
  });

  it("normalises gh's empty-string reviewDecision to null and passes a real one through", async () => {
    const empty = await probeFor(prNode({ reviewDecision: '' }));
    expect(empty?.snapshot.decision).toBeNull();

    const real = await probeFor(prNode({ reviewDecision: 'CHANGES_REQUESTED' }));
    expect(real?.snapshot.decision).toBe('CHANGES_REQUESTED');
  });

  it('returns a NON-null probe for a successful read with no threads, distinct from a failed probe', async () => {
    const succeeded = await probeFor(prNode({ reviewThreads: { totalCount: 0, nodes: [] } }));
    const failed = await fetchPrReviewState(
      runnerFor({ stdout: '', exitCode: 1 }),
      REF,
      CWD,
    );
    expect(succeeded).not.toBeNull();
    expect(succeeded?.snapshot.threads).toHaveLength(0);
    expect(failed).toBeNull();
  });

  it('maps a thread node onto every stored field', async () => {
    const node = threadNode(
      {
        isResolved: true,
        isOutdated: true,
        path: 'src/x.ts',
        line: 10,
        startLine: 8,
        originalLine: 9,
        subjectType: 'LINE',
      },
      [commentNode({ originalCommit: { oid: 'deadbeef' } })],
    );
    const probe = await probeFor(prNode({ reviewThreads: { totalCount: 1, nodes: [node] } }));
    const thread = probe?.snapshot.threads[0];
    expect(thread?.isResolved).toBe(true);
    expect(thread?.isOutdated).toBe(true);
    expect(thread?.path).toBe('src/x.ts');
    expect(thread?.line).toBe(10);
    expect(thread?.startLine).toBe(8);
    expect(thread?.originalLine).toBe(9);
    expect(thread?.originalCommitId).toBe('deadbeef');
    expect(thread?.subjectType).toBe('LINE');
  });

  it("uses the first comment's databaseId as the thread's upstreamKey, as text", async () => {
    const node = threadNode({}, [
      commentNode({ databaseId: 4242 }),
      commentNode({ databaseId: 4243 }),
    ]);
    const probe = await probeFor(prNode({ reviewThreads: { totalCount: 1, nodes: [node] } }));
    expect(probe?.snapshot.threads[0]?.upstreamKey).toBe('4242');
  });

  it("takes the GREATEST comment updatedAt for the thread's change detector", async () => {
    const node = threadNode({}, [
      commentNode({ updatedAt: '2026-01-02T00:00:00Z' }),
      commentNode({ updatedAt: '2026-01-05T00:00:00Z' }),
      commentNode({ updatedAt: '2026-01-01T00:00:00Z' }),
    ]);
    const probe = await probeFor(prNode({ reviewThreads: { totalCount: 1, nodes: [node] } }));
    expect(probe?.snapshot.threads[0]?.updatedAt).toBe('2026-01-05T00:00:00Z');
  });

  it('keeps a Bot author with its GraphQL __typename', async () => {
    const node = threadNode({}, [
      commentNode({ author: { login: 'dependabot', __typename: 'Bot' }, authorAssociation: 'NONE' }),
    ]);
    const probe = await probeFor(prNode({ reviewThreads: { totalCount: 1, nodes: [node] } }));
    expect(probe?.snapshot.threads[0]?.author.typeName).toBe('Bot');
  });

  it('reports thread truncation when totalCount exceeds the page size', async () => {
    const probe = await probeFor(
      prNode({ reviewThreads: { totalCount: THREAD_PAGE + 1, nodes: [threadNode()] } }),
    );
    expect(probe?.truncated.threads).toBe(true);
  });

  it('names the node id of a thread whose comments were cut', async () => {
    const node = threadNode({ id: 'PRRT_overflow' }, [commentNode()]);
    const probe = await probeFor(
      prNode({
        reviewThreads: {
          totalCount: 1,
          nodes: [
            {
              ...node,
              comments: { totalCount: THREAD_COMMENT_PAGE + 1, nodes: [commentNode()] },
            },
          ],
        },
      }),
    );
    expect(probe?.truncated.threadComments).toEqual(['PRRT_overflow']);
  });

  it('calls gh api graphql with -f for strings and -F for the numeric variables', async () => {
    const captured: string[][] = [];
    await fetchPrReviewState(
      runnerFor(ok(payload(prNode())), captured),
      { owner: 'acme', name: 'rocket', number: 42 },
      CWD,
    );
    const args = captured[0]!;
    expect(args[0]).toBe('api');
    expect(args[1]).toBe('graphql');
    expect(args[2]).toBe('-f');
    expect(args[3]).toBe(`query=${PR_FEEDBACK_QUERY}`);
    // `-f` (raw string) for the String! variables: `-F` type-infers, so an
    // all-digit repo name would be sent as an Int and rejected.
    for (const [key, value] of [
      ['owner', 'acme'],
      ['name', 'rocket'],
    ] as const) {
      const index = args.indexOf(`${key}=${value}`);
      expect(index).toBeGreaterThan(0);
      expect(args[index - 1]).toBe('-f');
    }
    for (const [key, value] of [
      ['number', '42'],
      ['threads', String(THREAD_PAGE)],
      ['comments', String(THREAD_COMMENT_PAGE)],
      ['reviews', String(REVIEW_PAGE)],
    ] as const) {
      const index = args.indexOf(`${key}=${value}`);
      expect(index).toBeGreaterThan(0);
      expect(args[index - 1]).toBe('-F');
    }
  });

  it('names an all-digit repository as raw strings, not type-inferred fields', async () => {
    const captured: string[][] = [];
    await fetchPrReviewState(
      runnerFor(ok(payload(prNode())), captured),
      { owner: '1234', name: '5678', number: 9 },
      CWD,
    );
    const args = captured[0]!;
    expect(args[args.indexOf('owner=1234') - 1]).toBe('-f');
    expect(args[args.indexOf('name=5678') - 1]).toBe('-f');
    expect(args[args.indexOf('number=9') - 1]).toBe('-F');
  });

  it('names the review decision in one [merge] debug line', async () => {
    const debugs: string[] = [];
    await fetchPrReviewState(
      runnerFor(ok(payload(prNode()))),
      REF,
      CWD,
      (m) => debugs.push(m),
    );
    expect(debugs).toHaveLength(1);
    expect(debugs[0]).toContain('[merge]');
    expect(debugs[0]).toContain('CHANGES_REQUESTED');
    expect(debugs[0]).toContain('acme/rocket#42');
  });

  it('names the gh output cap distinctly when the read was truncated', async () => {
    const debugs: string[] = [];
    const probe = await fetchPrReviewState(
      runnerFor({
        stdout: '',
        exitCode: 1,
        stderr: 'refusing truncated gh output because it may contain an incomplete protocol response',
      }),
      REF,
      CWD,
      (m) => debugs.push(m),
    );
    expect(probe).toBeNull();
    expect(debugs).toHaveLength(1);
    expect(debugs[0]).toContain('[merge]');
    expect(debugs[0]).toContain('output cap');
    expect(debugs[0]).toContain('acme/rocket');
  });

  it('stays silent on a generic non-zero exit', async () => {
    const debugs: string[] = [];
    await fetchPrReviewState(
      runnerFor({ stdout: '', exitCode: 1, stderr: 'boom' }),
      REF,
      CWD,
      (m) => debugs.push(m),
    );
    expect(debugs).toHaveLength(0);
  });
});

describe('parsePrRef', () => {
  it('parses a canonical GitHub PR url', () => {
    expect(parsePrRef('https://github.com/acme/rocket/pull/42')).toEqual({
      owner: 'acme',
      name: 'rocket',
      number: 42,
    });
  });

  it('tolerates a trailing slash and a query string', () => {
    expect(parsePrRef('https://github.com/acme/rocket/pull/42/')).toEqual({
      owner: 'acme',
      name: 'rocket',
      number: 42,
    });
    expect(parsePrRef('https://github.com/acme/rocket/pull/42?foo=1')).toEqual({
      owner: 'acme',
      name: 'rocket',
      number: 42,
    });
  });

  it('returns null for a non-github host, a non-string and a malformed url', () => {
    expect(parsePrRef('https://gitlab.com/acme/rocket/pull/42')).toBeNull();
    expect(parsePrRef(null)).toBeNull();
    expect(parsePrRef('not a url')).toBeNull();
  });
});
