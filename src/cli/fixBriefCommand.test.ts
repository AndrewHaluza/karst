import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { recordGateRun } from '../store/gateRuns.js';
import { reconcilePrFeedback, adoptPrFeedbackIntoRound } from '../store/prFeedback.js';
import { openRecoveryRound } from '../store/recoveryRounds.js';
import { parseFixBriefArgs, runFixBriefCommand } from './fixBriefCommand.js';

describe('parseFixBriefArgs', () => {
  it('parses a bare key', () => {
    expect(parseFixBriefArgs(['fix-brief', 'PROJ-1'])).toEqual({ key: 'PROJ-1' });
  });

  it('throws on the wrong command', () => {
    expect(() => parseFixBriefArgs(['context', 'PROJ-1'])).toThrow(/fix-brief/);
  });

  it('throws when the key is missing', () => {
    expect(() => parseFixBriefArgs(['fix-brief'])).toThrow(/key/);
  });

  it('throws on extra arguments', () => {
    expect(() => parseFixBriefArgs(['fix-brief', 'PROJ-1', 'extra'])).toThrow(/unexpected/);
  });
});

describe('runFixBriefCommand', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function seedTicket(): number {
    const t = createTicket(store, { key: 'PROJ-1', title: 'Fix me' });
    updateTicketFields(store, t.id, { description: 'A thing' });
    return t.id;
  }

  it('returns a brief with the gate name when review is failed', () => {
    const id = seedTicket();
    setStage(store, id, 'review', { status: 'failed', verdict: '3 issues found' });
    recordGateRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-09-01T00:00:00Z',
      gates: [
        {
          gateName: 'lint',
          exitCode: 1,
          summary: 'error: unused import',
        },
      ],
    });
    const out = runFixBriefCommand(store, { key: 'PROJ-1' });
    expect(out).toContain('review');
    expect(out).toContain('PROJ-1');
  });

  it('returns "nothing to fix" when no gate is failed', () => {
    seedTicket();
    const out = runFixBriefCommand(store, { key: 'PROJ-1' });
    expect(out).toBe('No failed gate is recorded for this ticket — there is nothing to fix.');
  });

  it('throws on an unknown key', () => {
    expect(() => runFixBriefCommand(store, { key: 'NOPE-1' })).toThrow(
      /no ticket found for key or id 'NOPE-1'/,
    );
  });

  it('includes the adopted PR feedback when a ship-sourced round is active', () => {
    const id = seedTicket();
    setStage(store, id, 'ship', {
      status: 'failed',
      verdict: 'the review team requested changes on 1 open item(s)',
    });
    const round = openRecoveryRound(store, {
      ticketId: id,
      sourceStage: 'ship',
      sourceProcessId: 'pr-review',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'upstream-changes-requested',
      triggerDetail: '1 open PR review item(s) in frontend from alice',
      maxRounds: 3,
      startedAt: '2026-09-01T00:00:00Z',
    });
    reconcilePrFeedback(store, {
      ticketId: id,
      repo: 'frontend',
      prUrl: 'https://github.com/acme/repo/pull/1',
      at: '2026-09-01T00:00:00Z',
      snapshot: {
        decision: null,
        reviews: [],
        threads: [
          {
            nodeId: 'PRRT_1',
            upstreamKey: '1',
            isResolved: false,
            isOutdated: false,
            path: 'src/a.ts',
            line: 12,
            startLine: null,
            originalLine: 10,
            originalCommitId: 'abc',
            subjectType: 'LINE',
            author: { login: 'alice', typeName: 'User', association: 'MEMBER' },
            body: 'please rename this',
            comments: [],
            updatedAt: '2026-09-01T00:00:00Z',
          },
        ],
      },
    });
    adoptPrFeedbackIntoRound(store, id, round.id);

    const out = runFixBriefCommand(store, { key: 'PROJ-1' });
    expect(out).toContain('Reviewers requested changes on the pull request for ticket PROJ-1');
    expect(out).toContain('frontend src/a.ts:10');
    expect(out).toContain('asked by alice (MEMBER)');
    expect(out).toContain('please rename this');
  });
});
