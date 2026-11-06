import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { reconcilePrFeedback, adoptPrFeedbackIntoRound } from '../../store/prFeedback.js';
import { openRecoveryRound } from '../../store/recoveryRounds.js';
import type { PrReviewThread } from '../../model/prReview.js';
import { recordStallNote } from '../../store/stallNote.js';
import { fixBriefForTicket } from './fixBriefForTicket.js';

const T0 = '2026-01-01T00:00:00.000Z';

function thread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    nodeId: 'PRRT_1',
    upstreamKey: '1',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 12,
    startLine: null,
    originalLine: 10,
    originalCommitId: 'abc',
    subjectType: 'LINE',
    author: { login: 'alice', typeName: 'User', association: 'MEMBER' },
    body: 'please rename this',
    comments: [],
    updatedAt: T0,
    ...overrides,
  };
}

describe('fixBriefForTicket', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('carries the adopted reviewer comments for a ship-sourced round', () => {
    const ticket = createTicket(store, { key: 'PROJ-1', title: 't' });
    setStage(store, ticket.id, 'ship', {
      status: 'failed',
      verdict: 'the review team requested changes on 1 open item(s)',
      attempt: 1,
      endedAt: T0,
    });
    const round = openRecoveryRound(store, {
      ticketId: ticket.id,
      sourceStage: 'ship',
      sourceProcessId: 'pr-review',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'upstream-changes-requested',
      triggerDetail: '1 open PR review item(s) in frontend from alice',
      maxRounds: 3,
      startedAt: T0,
    });
    reconcilePrFeedback(store, {
      ticketId: ticket.id,
      repo: 'frontend',
      prUrl: 'https://github.com/acme/repo/pull/1',
      at: T0,
      snapshot: { decision: null, reviews: [], threads: [thread()] },
    });
    adoptPrFeedbackIntoRound(store, ticket.id, round.id);

    const brief = fixBriefForTicket(store, ticket.id);
    expect(brief).toContain('Reviewers requested changes on the pull request for ticket T1 · PROJ-1');
    expect(brief).toContain('frontend src/app.ts:10');
    expect(brief).toContain('asked by alice (MEMBER)');
    expect(brief).toContain('please rename this');
  });

  it('returns the ordinary brief when no ship round is active', () => {
    const ticket = createTicket(store, { key: 'PROJ-2', title: 't' });
    setStage(store, ticket.id, 'review', { status: 'failed', verdict: 'gates failed: lint' });
    const brief = fixBriefForTicket(store, ticket.id);
    expect(brief).toContain('review gate failed');
    expect(brief).not.toContain('The review team asked for these changes:');
  });

  it('returns null when no gate failed', () => {
    const ticket = createTicket(store, { key: 'PROJ-3', title: 't' });
    expect(fixBriefForTicket(store, ticket.id)).toBeNull();
  });

  it('puts the stall note first and says removed scope lapses', () => {
    const ticket = createTicket(store, { key: 'PROJ-2', title: 't' });
    setStage(store, ticket.id, 'review', {
      status: 'failed', verdict: 'review findings', attempt: 1, endedAt: T0,
    });
    recordStallNote(store, ticket.id, 1, T0, 'split the module');
    const brief = fixBriefForTicket(store, ticket.id) ?? '';
    expect(brief.startsWith('## Direction from the user\n\nsplit the module')).toBe(true);
    expect(brief).toContain('Findings on scope that this direction removes no longer apply.');
    expect(brief).toContain('review gate failed');
  });
  it('keeps the note when review left no brief', () => {
    const ticket = createTicket(store, { key: 'PROJ-4', title: 't' });
    recordStallNote(store, ticket.id, 1, T0, 'split the module');
    expect(fixBriefForTicket(store, ticket.id)).toContain('split the module');
  });
  it('has no note block without a note', () => {
    const ticket = createTicket(store, { key: 'PROJ-3', title: 't' });
    setStage(store, ticket.id, 'review', {
      status: 'failed', verdict: 'review findings', attempt: 1, endedAt: T0,
    });
    expect(fixBriefForTicket(store, ticket.id)).not.toContain('Direction from the user');
  });

  it('includes the per-region checklist instruction when the ticket links a prototype', () => {
    const ticket = createTicket(store, {
      key: 'PROJ-5',
      title: 'UI work',
      description: 'The prototype is docs/design/ticket-form-b-prime.html',
    });
    setStage(store, ticket.id, 'uat', { status: 'failed', verdict: 'visual diff' });
    const brief = fixBriefForTicket(store, ticket.id);
    expect(brief).toContain('@ui:UI-R39-REJECT');
  });
});
