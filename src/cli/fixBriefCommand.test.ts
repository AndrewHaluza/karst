import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { recordGateRun } from '../store/gateRuns.js';
import { reconcilePrFeedback, adoptPrFeedbackIntoRound } from '../store/prFeedback.js';
import { openRecoveryRound } from '../store/recoveryRounds.js';
import { currentFixDelivery, upsertFixDelivery, getFixDelivery } from '../store/fixDeliveries.js';
import { parseFixBriefArgs, runFixBriefCommand } from './fixBriefCommand.js';

describe('parseFixBriefArgs', () => {
  it('parses a bare key', () => {
    expect(parseFixBriefArgs(['fix-brief', 'PROJ-1'])).toEqual({ key: 'PROJ-1', ack: false });
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

  it('throws on an unknown flag', () => {
    expect(() => parseFixBriefArgs(['fix-brief', 'PROJ-1', '--nope'])).toThrow(/unexpected argument '--nope'/);
  });

  it('parses --ack with either grammar', () => {
    expect(parseFixBriefArgs(['fix-brief', 'PROJ-1', '--ack'])).toEqual({ key: 'PROJ-1', ack: true });
    expect(parseFixBriefArgs(['fix-brief', '--ack'], 'PROJ-1')).toEqual({ key: 'PROJ-1', ack: true });
  });

  it('takes the global --ticket as the key', () => {
    expect(parseFixBriefArgs(['fix-brief'], 'PROJ-9')).toEqual({ key: 'PROJ-9', ack: false });
  });

  it('refuses the key given twice', () => {
    expect(() => parseFixBriefArgs(['fix-brief', 'PROJ-1'], 'PROJ-1')).toThrow(/once/);
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
    const out = runFixBriefCommand(store, { key: 'PROJ-1', ack: false });
    expect(out).toContain('review');
    expect(out).toContain('PROJ-1');
  });

  it('returns "nothing to fix" when no gate is failed', () => {
    seedTicket();
    const out = runFixBriefCommand(store, { key: 'PROJ-1', ack: false });
    expect(out).toBe('No failed gate is recorded for this ticket — there is nothing to fix.');
  });

  it('throws on an unknown key', () => {
    expect(() => runFixBriefCommand(store, { key: 'NOPE-1', ack: false })).toThrow(
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

    const out = runFixBriefCommand(store, { key: 'PROJ-1', ack: false });
    expect(out).toContain('Reviewers requested changes on the pull request for ticket T1 · PROJ-1');
    expect(out).toContain('frontend src/a.ts:10');
    expect(out).toContain('asked by alice (MEMBER)');
    expect(out).toContain('please rename this');
  });
});

describe('runFixBriefCommand --ack', () => {
  let store: Store;
  let id: number;
  const NOW = '2026-09-01T00:00:00.000Z';
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'PROJ-1', title: 'a' }).id;
    createTicket(store, { key: 'PROJ-2', title: 'b' });
  });
  afterEach(() => store.close());

  const ack = (key: string, session: string | undefined) =>
    runFixBriefCommand(store, { key, ack: true }, { sessionTicketKey: session, now: () => NOW });
  const snapshot = (body = 'STORED BRIEF') =>
    upsertFixDelivery(store, { ticketId: id, recoveryRoundId: null, launchId: 'L', body, at: NOW });

  it('prints the stored snapshot and claims it read', () => {
    const row = snapshot();
    expect(ack('PROJ-1', 'PROJ-1')).toBe(`karst fix brief #${row}:\nSTORED BRIEF`);
    expect(getFixDelivery(store, row)).toMatchObject({ readAt: NOW, deliveredVia: 'pointer' });
  });

  it('prints (already read) on a repeat and does not re-claim', () => {
    const row = snapshot();
    ack('PROJ-1', 'PROJ-1');
    expect(ack('PROJ-1', 'PROJ-1')).toBe(`karst fix brief #${row} (already read):\nSTORED BRIEF`);
    expect(getFixDelivery(store, row)!.readAt).toBe(NOW);
  });

  it('accepts a row id on one side and the key on the other', () => {
    snapshot();
    expect(ack(String(id), 'PROJ-1')).toContain('STORED BRIEF');
  });

  it('refuses a session ticket that differs and marks nothing', () => {
    const row = snapshot();
    expect(() => ack('PROJ-1', 'PROJ-2')).toThrow(/refusing/);
    expect(getFixDelivery(store, row)!.readAt).toBeNull();
  });

  it('refuses without a session ticket', () => {
    const row = snapshot();
    expect(() => ack('PROJ-1', undefined)).toThrow(/KARST_TICKET/);
    expect(getFixDelivery(store, row)!.readAt).toBeNull();
  });

  it('refuses an unknown session ticket', () => {
    snapshot();
    expect(() => ack('PROJ-1', 'NOPE-9')).toThrow(/no ticket found for session/);
  });

  it('never prints a superseded row (serves the newer one)', () => {
    snapshot('OLD');
    const newer = snapshot('NEW');
    const out = ack('PROJ-1', 'PROJ-1');
    expect(out).toBe(`karst fix brief #${newer}:\nNEW`);
  });

  it('falls back to the live brief and marks nothing when there is no row', () => {
    expect(ack('PROJ-1', 'PROJ-1')).toBe(
      'No failed gate is recorded for this ticket — there is nothing to fix.',
    );
    expect(currentFixDelivery(store, id)).toBeNull();
  });

  it('the default (no --ack) never claims the receipt', () => {
    const row = snapshot();
    runFixBriefCommand(store, { key: 'PROJ-1', ack: false });
    expect(getFixDelivery(store, row)!.readAt).toBeNull();
  });
});
