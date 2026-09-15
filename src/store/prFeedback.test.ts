import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import type {
  PrFeedbackSnapshot,
  PrReviewAuthor,
  PrReviewSubmission,
  PrReviewThread,
} from '../model/prReview.js';
import { countOpenPrFeedback, listPrFeedback, reconcilePrFeedback } from './prFeedback.js';
import {
  adoptPrFeedbackIntoRound,
  listPrFeedbackForRound,
  listUnadoptedPrFeedback,
} from './prFeedback.js';
import { openRecoveryRound } from './recoveryRounds.js';

const AUTHOR: PrReviewAuthor = { login: 'reviewer', typeName: 'User', association: 'MEMBER' };
const PR_URL = 'https://github.com/acme/repo/pull/1';
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';

function thread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    nodeId: 'PRRT_1',
    upstreamKey: '1001',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 12,
    startLine: null,
    originalLine: 10,
    originalCommitId: 'abc',
    subjectType: 'LINE',
    author: AUTHOR,
    body: 'please fix',
    comments: [],
    updatedAt: T1,
    ...overrides,
  };
}

function review(overrides: Partial<PrReviewSubmission> = {}): PrReviewSubmission {
  return {
    upstreamKey: '2001',
    state: 'COMMENTED',
    body: 'overall looks good',
    author: AUTHOR,
    submittedAt: T1,
    updatedAt: T1,
    ...overrides,
  };
}

function snap(overrides: Partial<PrFeedbackSnapshot> = {}): PrFeedbackSnapshot {
  return { decision: null, reviews: [], threads: [], ...overrides };
}

describe('pr feedback reconcile', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const reconcile = (
    ticketId: number,
    snapshot: PrFeedbackSnapshot,
    at: string,
    repo = 'frontend',
    prUrl = PR_URL,
  ) => reconcilePrFeedback(store, { ticketId, repo, prUrl, snapshot, at });

  it('inserts one row per incoming thread with equal stamps and no absent_at', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const result = reconcile(
      t.id,
      snap({ threads: [thread({ upstreamKey: '1' }), thread({ upstreamKey: '2' })] }),
      T1,
    );
    expect(result).toEqual({ inserted: 2, updated: 0, markedAbsent: 0, reappeared: 0, unchanged: 0 });
    const rows = listPrFeedback(store, t.id);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.firstSeenAt === T1 && r.lastSeenAt === T1 && r.absentAt === null),
    ).toBe(true);
  });

  it('reports unchanged and does not move first_seen_at on an identical re-reconcile', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const snapshot = snap({
      threads: [thread({ upstreamKey: '1' }), thread({ upstreamKey: '2', nodeId: 'PRRT_2' })],
    });
    reconcile(t.id, snapshot, T1);
    const before = listPrFeedback(store, t.id).map((r) => r.firstSeenAt);
    const result = reconcile(t.id, snapshot, T2);
    expect(result).toEqual({ inserted: 0, updated: 0, markedAbsent: 0, reappeared: 0, unchanged: 2 });
    expect(listPrFeedback(store, t.id).map((r) => r.firstSeenAt)).toEqual(before);
  });

  it('updates a thread whose upstream_updated_at advanced and stores the new body', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1', body: 'first' })] }), T1);
    const result = reconcile(
      t.id,
      snap({ threads: [thread({ upstreamKey: '1', body: 'second', updatedAt: T2 })] }),
      T2,
    );
    expect(result).toEqual({ inserted: 0, updated: 1, markedAbsent: 0, reappeared: 0, unchanged: 0 });
    expect(listPrFeedback(store, t.id)[0]!.body).toBe('second');
  });

  it('marks a vanished thread absent, excluded by default and included on request', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(
      t.id,
      snap({ threads: [thread({ upstreamKey: '1' }), thread({ upstreamKey: '2', nodeId: 'PRRT_2' })] }),
      T1,
    );
    const result = reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T2);
    expect(result).toEqual({ inserted: 0, updated: 0, markedAbsent: 1, reappeared: 0, unchanged: 1 });
    expect(listPrFeedback(store, t.id).map((r) => r.upstreamKey)).toEqual(['1']);
    const all = listPrFeedback(store, t.id, { includeAbsent: true });
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.upstreamKey === '2')!.absentAt).toBe(T2);
  });

  it('clears absent_at and preserves first_seen_at when a thread reappears', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T1);
    reconcile(t.id, snap(), T2);
    const result = reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T3);
    expect(result).toEqual({ inserted: 0, updated: 0, markedAbsent: 0, reappeared: 1, unchanged: 0 });
    const row = listPrFeedback(store, t.id)[0]!;
    expect(row.absentAt).toBeNull();
    expect(row.firstSeenAt).toBe(T1);
    expect(row.lastSeenAt).toBe(T3);
  });

  it('un-hides an absent thread that reappears with a change', () => {
    // The change branch used to UPDATE without clearing absent_at, so a thread
    // that came back AND was edited stayed hidden from every reader.
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1', body: 'first', updatedAt: T1 })] }), T1);
    reconcile(t.id, snap(), T2);
    const result = reconcile(
      t.id,
      snap({ threads: [thread({ upstreamKey: '1', body: 'second', updatedAt: T3 })] }),
      T3,
    );
    expect(result.updated).toBe(1);
    expect(result.reappeared).toBe(1);
    const rows = listPrFeedback(store, t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.absentAt).toBeNull();
    expect(rows[0]!.body).toBe('second');
  });

  it('does not stamp absent_at when markAbsent is false', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(
      t.id,
      snap({ threads: [thread({ upstreamKey: '1' }), thread({ upstreamKey: '2', nodeId: 'PRRT_2' })] }),
      T1,
    );
    const result = reconcilePrFeedback(store, {
      ticketId: t.id,
      repo: 'frontend',
      prUrl: PR_URL,
      snapshot: snap({ threads: [thread({ upstreamKey: '1' })] }),
      at: T2,
      markAbsent: false,
    });
    expect(result.markedAbsent).toBe(0);
    expect(listPrFeedback(store, t.id)).toHaveLength(2);
  });

  it('marks every live row absent on a successful empty snapshot', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(
      t.id,
      snap({ threads: [thread({ upstreamKey: '1' }), thread({ upstreamKey: '2', nodeId: 'PRRT_2' })] }),
      T1,
    );
    const result = reconcile(t.id, snap(), T2);
    expect(result).toEqual({ inserted: 0, updated: 0, markedAbsent: 2, reappeared: 0, unchanged: 0 });
    expect(listPrFeedback(store, t.id)).toEqual([]);
  });

  it('reports updated on every reconcile when upstream_updated_at is null', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1', updatedAt: null })] }), T1);
    const result = reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1', updatedAt: null })] }), T2);
    expect(result).toEqual({ inserted: 0, updated: 1, markedAbsent: 0, reappeared: 0, unchanged: 0 });
  });

  it('stores a review with a body and skips an empty-bodied review', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const result = reconcile(
      t.id,
      snap({ reviews: [review({ upstreamKey: '2', body: '' }), review({ upstreamKey: '3', body: 'adjust please' })] }),
      T1,
    );
    expect(result.inserted).toBe(1);
    const rows = listPrFeedback(store, t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('review');
    expect(rows[0]!.upstreamKey).toBe('3');
  });

  it('coexists the same upstream_key under two pr_urls for one ticket and repo', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    expect(() => {
      reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T1, 'frontend', PR_URL);
      reconcile(
        t.id,
        snap({ threads: [thread({ upstreamKey: '1' })] }),
        T2,
        'frontend',
        'https://github.com/acme/repo/pull/2',
      );
    }).not.toThrow();
    expect(listPrFeedback(store, t.id)).toHaveLength(2);
  });

  it('keeps independent rows across repos', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T1, 'frontend');
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T1, 'backend');
    expect(listPrFeedback(store, t.id)).toHaveLength(2);
  });

  it('counts only open, non-absent feedback', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(
      t.id,
      snap({
        threads: [
          thread({ upstreamKey: '1' }),
          thread({ upstreamKey: '2', nodeId: 'PRRT_2', isResolved: true }),
        ],
      }),
      T1,
    );
    expect(countOpenPrFeedback(store, t.id)).toBe(1);
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T2);
    expect(countOpenPrFeedback(store, t.id)).toBe(1);
    reconcile(t.id, snap(), T3);
    expect(countOpenPrFeedback(store, t.id)).toBe(0);
  });
});

describe('pr feedback round linking', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const reconcile = (
    ticketId: number,
    snapshot: PrFeedbackSnapshot,
    at: string,
    repo = 'frontend',
    prUrl = PR_URL,
  ) => reconcilePrFeedback(store, { ticketId, repo, prUrl, snapshot, at });

  function openRound(ticketId: number): number {
    return openRecoveryRound(store, {
      ticketId,
      sourceStage: 'ship',
      sourceProcessId: 'pr-review',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'upstream-changes-requested',
      triggerDetail: 'reviewers asked',
      maxRounds: 3,
      startedAt: T1,
    }).id;
  }

  it('adopts only live, unresolved, not-outdated, unadopted rows and returns the count', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(
      t.id,
      snap({
        threads: [
          thread({ upstreamKey: '1' }),
          thread({ upstreamKey: '2', nodeId: 'PRRT_2', isResolved: true }),
          thread({ upstreamKey: '3', nodeId: 'PRRT_3', isOutdated: true }),
          thread({ upstreamKey: '4', nodeId: 'PRRT_4' }),
        ],
      }),
      T1,
    );
    // Row 4 vanishes upstream, so the reconcile stamps it absent.
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T2);

    const roundId = openRound(t.id);
    expect(adoptPrFeedbackIntoRound(store, t.id, roundId)).toBe(1);
    // Nothing left to adopt, and re-adoption is a no-op.
    expect(adoptPrFeedbackIntoRound(store, t.id, roundId)).toBe(0);

    expect(listPrFeedbackForRound(store, t.id, roundId).map((r) => r.upstreamKey)).toEqual(['1']);
    expect(listUnadoptedPrFeedback(store, t.id)).toEqual([]);
  });

  it('never adopts a row a previous round already owns', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T1);
    const first = openRound(t.id);
    const second = openRound(t.id);
    expect(adoptPrFeedbackIntoRound(store, t.id, first)).toBe(1);
    expect(adoptPrFeedbackIntoRound(store, t.id, second)).toBe(0);
    expect(listPrFeedbackForRound(store, t.id, first)).toHaveLength(1);
    expect(listPrFeedbackForRound(store, t.id, second)).toHaveLength(0);
  });

  it('orders a round’s rows by repo, path, then line with NULL lines last', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(
      t.id,
      snap({
        threads: [
          thread({ upstreamKey: 'a', path: 'src/a.ts', originalLine: 20 }),
          thread({ upstreamKey: 'b', nodeId: 'PRRT_b', path: 'src/a.ts', originalLine: 5 }),
          thread({ upstreamKey: 'c', nodeId: 'PRRT_c', path: 'src/a.ts', originalLine: null }),
          thread({
            upstreamKey: 'd',
            nodeId: 'PRRT_d',
            path: 'src/z.ts',
            originalLine: 1,
            line: 1,
          }),
        ],
      }),
      T1,
    );
    const roundId = openRound(t.id);
    adoptPrFeedbackIntoRound(store, t.id, roundId);
    expect(listPrFeedbackForRound(store, t.id, roundId).map((r) => [r.repo, r.path, r.originalLine])).toEqual([
      ['frontend', 'src/a.ts', 5],
      ['frontend', 'src/a.ts', 20],
      ['frontend', 'src/a.ts', null],
      ['frontend', 'src/z.ts', 1],
    ]);
  });

  it('preserves recovery_round_id when the row is re-reconciled', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1', body: 'first' })] }), T1);
    const roundId = openRound(t.id);
    adoptPrFeedbackIntoRound(store, t.id, roundId);

    // A later sweep edits the thread: the reconcile UPDATE must not clear the
    // adoption link it does not list.
    const result = reconcile(
      t.id,
      snap({ threads: [thread({ upstreamKey: '1', body: 'second', updatedAt: T2 })] }),
      T2,
    );
    expect(result.updated).toBe(1);
    const row = listPrFeedback(store, t.id)[0]!;
    expect(row.body).toBe('second');
    expect(row.recoveryRoundId).toBe(roundId);
  });

  it('leaves recovery_round_id NULL for feedback nothing has adopted', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    reconcile(t.id, snap({ threads: [thread({ upstreamKey: '1' })] }), T1);
    const row = listPrFeedback(store, t.id)[0]!;
    expect(row.recoveryRoundId).toBeNull();
    expect(listUnadoptedPrFeedback(store, t.id).map((r) => r.upstreamKey)).toEqual(['1']);
  });
});
