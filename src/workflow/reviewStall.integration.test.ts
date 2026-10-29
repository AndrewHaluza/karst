import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { transition } from './machine.js';
import { openGateRun } from './gates/evidence.js';
import { commitGateOutcome } from './gates/commit.js';
import { getTicket } from '../store/tickets.js';
import { stageBlock } from '../store/stageBlocks.js';
import { listRecoveryRounds } from '../store/recoveryRounds.js';
import { REVIEW_STALL_DETECTION_DEFAULTS } from '../manifest/qualityDefaults.js';
import { redesignHintAction, continueAnywayAction, type ReviewStallActionDeps } from '../extension/ops/reviewStallActions.js';
import { fixBriefForTicket } from '../extension/ops/fixBriefForTicket.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const D159 = 'src/workflow/usageLimitRerun.ts';

describe('review stall — park and the three answers', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    for (const k of ['scope', 'impl', 'uat'] as const) transition(store, id, k, { kind: 'passed' });
  });
  afterEach(() => store.close());

  /** One failing review run with the given blocking findings; returns after the commit. */
  function failReview(n: number, files: string[], enabled = true) {
    const runAt = `2026-07-30T10:00:0${n}.000Z`;
    const evidence = openGateRun(store, { ticketId: id, stageKey: 'review', runAt });
    commitGateOutcome(store, {
      ticketId: id, stageKey: 'review', runAt, artifactPath: '', gates: [], stageRunId: evidence.runId,
      now: () => runAt,
      findings: files.map((file, i) => ({
        severity: 'high' as const, repo: '/r', file, title: `problem ${n}-${i}`, detail: 'd', source: 'agent' as const,
      })),
      outcome: { kind: 'verdict', verdict: { kind: 'failed', reason: 'review findings' } },
      recoveryTrigger: {
        sourceProcessId: 'review', sourceStageRunId: evidence.runId, sourceProcessRunId: null,
        triggerKind: 'blocking-review-findings', triggerDetail: 'blocking review findings', maxRounds: 5,
        stall: { config: { ...REVIEW_STALL_DETECTION_DEFAULTS, enabled }, blockingSeverity: 'high' },
      },
    });
  }
  const backToReview = () => {
    transition(store, id, 'fix', { kind: 'passed' });
    transition(store, id, 'uat', { kind: 'passed' });
  };

  it("replaying D159's sequence parks at attempt 3 naming usageLimitRerun.ts", () => {
    failReview(1, [D159, 'a.ts']);
    backToReview();
    failReview(2, [D159, 'b.ts']);
    backToReview();
    expect(stageBlock(store, id, 'fix')).toBeNull();
    failReview(3, [D159]);
    const block = stageBlock(store, id, 'fix');
    expect(block?.kind).toBe('review-stalled');
    expect(block?.reason).toBe(
      `Review keeps finding new problems in ${D159} (3 rounds) — likely a design problem, not a bug.`,
    );
    expect(listRecoveryRounds(store, id)).toHaveLength(2);
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });

  it('never parks while findings move to different files', () => {
    failReview(1, ['a.ts']);
    backToReview();
    failReview(2, ['b.ts']);
    backToReview();
    failReview(3, ['c.ts']);
    expect(stageBlock(store, id, 'fix')).toBeNull();
    expect(listRecoveryRounds(store, id)).toHaveLength(3);
  });

  it('enabled:false never parks', () => {
    for (const n of [1, 2, 3]) {
      failReview(n, [D159], false);
      if (n < 3) backToReview();
    }
    expect(stageBlock(store, id, 'fix')).toBeNull();
    expect(listRecoveryRounds(store, id)).toHaveLength(3);
  });

  describe('answers', () => {
    let deps: ReviewStallActionDeps;
    beforeEach(() => {
      failReview(1, [D159]);
      backToReview();
      failReview(2, [D159]);
      backToReview();
      failReview(3, [D159]);
      deps = {
        store, ticketId: id, afterServerChange: vi.fn(), logError: vi.fn(), debug: vi.fn(), drive: vi.fn(),
        info: vi.fn(), error: vi.fn(), confirm: vi.fn(async () => true),
        promptHint: vi.fn(async () => 'extract the rerun into its own module'),
        now: () => '2026-07-30T11:00:00.000Z',
      };
    });

    it('Continue anyway resumes review with a fresh counter: two more same-file rounds do not re-park', async () => {
      continueAnywayAction(deps);
      await flush();
      expect(stageBlock(store, id, 'fix')).toBeNull();
      expect(getTicket(store, id).stageCurrent).toBe('review');
      failReview(4, [D159]);
      expect(stageBlock(store, id, 'fix')).toBeNull();
    });

    it('Redesign hint reaches the fix brief and resumes rounds', async () => {
      redesignHintAction(deps);
      await flush();
      expect(getTicket(store, id).stageCurrent).toBe('review');
      failReview(4, [D159]);
      expect(stageBlock(store, id, 'fix')).toBeNull();
      expect(fixBriefForTicket(store, id)).toContain('extract the rerun into its own module');
      expect(deps.drive).toHaveBeenCalled();
    });
  });
});
