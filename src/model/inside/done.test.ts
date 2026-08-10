import { describe, it, expect, vi } from 'vitest';
import type { ShipCommit, ShipEvidence, ShipRepoEvidence, ShipRepoStepEvidence, ShipRun, ShipStep } from '../../store/shipRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { RecordedRoleUsage, RecordedUsageSummary } from '../../store/tokenUsage.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey, StageStatus } from '../types.js';
import type { InsideEvidenceTarget, ShipPrView } from './types.js';
import { doneReceipt, type DoneReceiptInput, type DoneReceiptView } from './done.js';
import type { EvidenceRow } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';

const shipRun: ShipRun = {
  id: 1,
  ticketId: 1,
  attempt: 1,
  status: 'passed',
  startedAt: '2026-07-20T12:00:00.000Z',
  endedAt: '2026-07-20T12:03:00.000Z',
};

let nextId = 1;
function step(stepName: ShipStep, over: Partial<ShipRepoStepEvidence> = {}): ShipRepoStepEvidence {
  return {
    id: nextId++,
    shipRunId: 1,
    repo: '/web',
    step: stepName,
    status: 'passed',
    detail: '',
    prNumber: null,
    existedBeforeShip: null,
    processRunId: null,
    operationIntentId: null,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:01:00.000Z',
    hasIntent: true,
    number: null,
    ...over,
  };
}

let nextCommit = 1;
function shipCommit(origin: 'before-ship' | 'created-by-ship', over: Partial<ShipCommit> = {}): ShipCommit {
  return {
    id: nextCommit++,
    shipRunId: 1,
    repo: '/web',
    sha: 'abc123',
    message: 'm',
    origin,
    ...over,
  };
}

function repoEvidence(repo: string, over: Partial<ShipRepoEvidence> = {}): ShipRepoEvidence {
  return { steps: {}, commits: [], intents: {}, ...over };
}

function evidence(over: Partial<ShipEvidence> = {}): ShipEvidence {
  return { run: shipRun, repos: {}, ...over };
}

function pr(repo: string, over: Partial<ShipPrView> = {}): ShipPrView {
  return { repo, number: null, status: null, headRef: null, baseRef: null, mergedAt: null, ...over };
}

let nextRun = 1;
function gateRun(over: Partial<GateRun> = {}): GateRun {
  return {
    id: nextRun++,
    ticketId: 1,
    stageKey: 'uat',
    attempt: 0,
    stageRunId: null,
    runAt: '2026-07-20T12:00:00.000Z',
    gateName: 'test (web)',
    exitCode: 0,
    startedAt: null,
    endedAt: null,
    repo: null,
    command: null,
    args: null,
    skipped: false,
    ...over,
  };
}

let nextRound = 1;
function round(over: Partial<RecoveryRound> = {}): RecoveryRound {
  return {
    id: nextRound++,
    ticketId: 1,
    sourceStage: 'uat',
    sourceProcessId: 'gates',
    sourceStageRunId: null,
    sourceProcessRunId: null,
    triggerKind: 'gate-failure',
    triggerDetail: 'exit 1',
    round: 1,
    maxRounds: 2,
    fixProcessRunId: null,
    uatRevalidationStageRunId: null,
    reviewRevalidationStageRunId: null,
    status: 'passed',
    startedAt: '2026-07-20T11:00:00.000Z',
    endedAt: '2026-07-20T11:30:00.000Z',
    ...over,
  };
}

function receiptInput(extra: Partial<DoneReceiptInput> = {}): DoneReceiptInput {
  return {
    stageCurrent: 'done',
    ship: evidence(),
    prs: [pr('/web', { number: 40, status: 'merged', mergedAt: NOW })],
    mergeChecks: [],
    gateRuns: [],
    rounds: [],
    tokens: null,
    roles: [],
    now: NOW,
    ...extra,
  };
}

function rowsOf(view: Extract<DoneReceiptView, { status: 'complete' }>): readonly EvidenceRow[] {
  const evidenceKind = view.evidence;
  if (evidenceKind?.kind === 'receipt') return evidenceKind.rows;
  throw new Error(`expected receipt evidence, got ${view.evidence?.kind ?? 'none'}`);
}

describe('doneReceipt', () => {
  it('is pending before done, with no future delivery evidence', () => {
    expect(doneReceipt(receiptInput({ stageCurrent: 'ship' }))).toEqual({
      status: 'pending',
      title: 'Delivery receipt pending',
      detail: 'Available after every current pull request is merged',
    });
  });

  it('counts only MERGED current PRs as delivered', () => {
    const view = doneReceipt(
      receiptInput({
        prs: [
          pr('/web', { number: 40, status: 'merged', mergedAt: NOW }),
          pr('/api', { number: 41, status: 'open' }),
        ],
      }),
    ) as Extract<DoneReceiptView, { status: 'complete' }>;
    expect(view.delivered).toEqual({ repos: 1, prs: 1, commits: 0 });
    const rows = rowsOf(view);
    expect(rows.filter((r) => r.label === 'merged')).toHaveLength(1);
    expect(rows.find((r) => r.label === 'merged')!.detail).toContain('#40');
    expect(rows.find((r) => r.label === 'merged')!.detail).not.toContain('#41');
  });

  it('counts only ship-created commits — pre-existing ones are legacy facts, omitted', () => {
    const view = doneReceipt(
      receiptInput({
        ship: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              commits: [shipCommit('created-by-ship'), shipCommit('created-by-ship'), shipCommit('before-ship')],
            }),
          },
        }),
      }),
    ) as Extract<DoneReceiptView, { status: 'complete' }>;
    expect(view.delivered.commits).toBe(2);
    expect(rowsOf(view).find((r) => r.label === 'commits')!.detail).toContain('2 created');
  });

  it('words the final gate outcome from the last gate batches', () => {
    const view = doneReceipt(
      receiptInput({
        gateRuns: [
          gateRun({ stageKey: 'uat', gateName: 'test (web)', exitCode: 0, runAt: NOW }),
          gateRun({ stageKey: 'uat', gateName: 'e2e (web)', exitCode: 0, runAt: NOW }),
          gateRun({ stageKey: 'review', gateName: 'lint (web)', exitCode: 0, runAt: NOW }),
        ],
      }),
    ) as Extract<DoneReceiptView, { status: 'complete' }>;
    expect(view.validated).toBe('3 gates passed on the final run');
  });

  it('words a failing final gate honestly', () => {
    const view = doneReceipt(
      receiptInput({
        gateRuns: [
          gateRun({ stageKey: 'uat', gateName: 'test (web)', exitCode: 1, runAt: NOW }),
          gateRun({ stageKey: 'uat', gateName: 'e2e (web)', exitCode: 0, runAt: NOW }),
        ],
      }),
    ) as Extract<DoneReceiptView, { status: 'complete' }>;
    expect(view.validated).toBe('1 gate failed on the final run');
  });

  it('records the recovery history on the receipt', () => {
    const view = doneReceipt(
      receiptInput({ rounds: [round(), round({ id: 2, round: 2 })] }),
    ) as Extract<DoneReceiptView, { status: 'complete' }>;
    const rows = rowsOf(view);
    expect(rows.find((r) => r.label === 'recovery')!.detail).toContain('2 rounds');
  });

  it('breaks recorded tokens down by role and names the recorded total', () => {
    const roles: RecordedRoleUsage[] = [
      { role: 'implementation', input: 100, output: 20, total: 120 },
      { role: 'quality', input: 20, output: 10, total: 30 },
    ];
    const tokens: RecordedUsageSummary = { input: 120, output: 30, total: 150 };
    const view = doneReceipt(receiptInput({ roles, tokens })) as Extract<
      DoneReceiptView,
      { status: 'complete' }
    >;
    expect(view.tokens).toEqual({ label: '150 tokens recorded' });
    const rows = rowsOf(view);
    expect(rows.find((r) => r.label === 'implementation')!.detail).toBe('120');
    expect(rows.find((r) => r.label === 'quality')!.detail).toBe('30');
  });

  it('omits tokens entirely when nothing was recorded — a zero would read as measured', () => {
    const view = doneReceipt(receiptInput({ tokens: null, roles: [] })) as Extract<
      DoneReceiptView,
      { status: 'complete' }
    >;
    expect(view.tokens).toBeNull();
    // handoff §11: absence is stated, never zero — the receipt row names it.
    const row = rowsOf(view).find((r) => r.label === 'tokens');
    expect(row).toBeDefined();
    expect(row!.detail).toBe('No token usage recorded yet');
  });

  it('never treats an estimated row as recorded spend', () => {
    // The reducer consumes the RECORDED summary — the store's WHERE estimated=0
    // is the contract; the input type carries no estimate flag at all.
    const view = doneReceipt(
      receiptInput({ tokens: { input: 0, output: 0, total: 0 } }),
    ) as Extract<DoneReceiptView, { status: 'complete' }>;
    expect(view.tokens!.label).toContain('0');
  });

  describe('delivery reads only literal merged status', () => {
    it('does not count a merge-stamped open PR as delivered', () => {
      const view = doneReceipt(
        receiptInput({ prs: [pr('/web', { number: 40, status: 'open', mergedAt: NOW })] }),
      ) as Extract<DoneReceiptView, { status: 'complete' }>;
      expect(view.delivered).toEqual({ repos: 0, prs: 0, commits: 0 });
      expect(rowsOf(view).filter((r) => r.label === 'merged')).toHaveLength(0);
    });

    it('keeps the delivery pending for a merge-stamped unknown PR', () => {
      const view = doneReceipt(
        receiptInput({ prs: [pr('/web', { number: 41, status: 'unknown', mergedAt: NOW })] }),
      ) as Extract<DoneReceiptView, { status: 'complete' }>;
      expect(view.delivered).toEqual({ repos: 0, prs: 0, commits: 0 });
      expect(rowsOf(view).filter((r) => r.label === 'merged')).toHaveLength(0);
    });

    it('counts a PR with literal merged status as delivered, stamp or no stamp', () => {
      const view = doneReceipt(
        receiptInput({ prs: [pr('/web', { number: 40, status: 'merged' })] }),
      ) as Extract<DoneReceiptView, { status: 'complete' }>;
      expect(view.delivered).toEqual({ repos: 1, prs: 1, commits: 0 });
      expect(rowsOf(view).filter((r) => r.label === 'merged')).toHaveLength(1);
    });
  });

  it.each([10, 15, 20])(
    'bounds %i merged repository rows and exposes the complete receipt slice through continuation',
    (count) => {
      const targets: InsideEvidenceTarget[] = [];
      const view = doneReceipt(
        receiptInput({
          prs: Array.from({ length: count }, (_, i) =>
            pr(`/repo-${String(i + 1).padStart(2, '0')}`, {
              number: 100 + i,
              status: 'merged',
            }),
          ),
          roles: [{ role: 'implementation', input: 90, output: 10, total: 100 }],
          tokens: { input: 90, output: 10, total: 100 },
          attach: (target) => {
            targets.push(target);
            return { actionId: 'snapshot-1:action-0', kind: target.kind };
          },
        }),
      ) as Extract<DoneReceiptView, { status: 'complete' }>;
      const rows = rowsOf(view);
      const repositoryRows = rows.filter((row) => row.label === 'merged' || row.label === 'more');

      expect(view.delivered).toEqual({ repos: count, prs: count, commits: 0 });
      expect(repositoryRows).toHaveLength(7);
      expect(repositoryRows.at(-1)).toMatchObject({
        label: 'more',
        detail: `+${count - 6} more`,
        action: { kind: 'open-bounded-evidence' },
      });
      expect(rows.find((row) => row.label === 'commits')).toBeDefined();
      expect(rows.find((row) => row.label === 'validated')).toBeDefined();
      expect(rows.find((row) => row.label === 'implementation')).toBeDefined();
      expect(targets).toHaveLength(1);
      if (targets[0]?.kind === 'open-bounded-evidence') {
        expect(targets[0].rows).toHaveLength(count);
      }
    },
  );

  it('does not mint a receipt continuation for six repositories', () => {
    const attach = vi.fn();
    const view = doneReceipt(
      receiptInput({
        prs: Array.from({ length: 6 }, (_, i) =>
          pr(`/repo-${i + 1}`, { number: 100 + i, status: 'merged' }),
        ),
        attach,
      }),
    ) as Extract<DoneReceiptView, { status: 'complete' }>;

    expect(rowsOf(view).filter((row) => row.label === 'merged')).toHaveLength(6);
    expect(rowsOf(view).find((row) => row.label === 'more')).toBeUndefined();
    expect(attach).not.toHaveBeenCalled();
  });
});

// ── the prototype's delivery hero and three-block receipt grid ─────────────
// Both are OPTIONAL fields beside the receipt rows, and every cell is a
// recorded fact: an unrecorded completion stamp is an EMPTY time, and a
// ticket with no measured spend says so instead of showing a zero.
describe('done receipt: the hero line and the receipt grid', () => {
  it('names the delivery, its validation and its completion stamp', () => {
    const view = doneReceipt(
      receiptInput({
        completedAt: '2026-07-20T12:29:00.000Z',
        prs: [
          pr('/web', { number: 40, status: 'merged' }),
          pr('/api', { number: 41, status: 'merged' }),
        ],
      }),
    );
    if (view.status !== 'complete') throw new Error('expected a complete receipt');
    expect(view.evidence.hero).toEqual({
      title: 'Delivered',
      summary: '2 repositories · 2 pull requests merged',
      time: `completed ${new Date('2026-07-20T12:29:00.000Z').toLocaleTimeString()}`,
    });
  });

  it('leaves the hero time empty when no completion stamp was recorded', () => {
    const view = doneReceipt(receiptInput({ completedAt: null }));
    if (view.status !== 'complete') throw new Error('expected a complete receipt');
    expect(view.evidence.hero?.time).toBe('');
  });

  it('builds the three receipt blocks from recorded delivery, validation and spend', () => {
    const view = doneReceipt(
      receiptInput({
        completedAt: NOW,
        prs: [pr('/web', { number: 40, status: 'merged' })],
        ship: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              commits: [shipCommit('created-by-ship'), shipCommit('created-by-ship')],
            }),
          },
        }),
        tokens: { input: 87_700, output: 23_200, total: 110_900 } as RecordedUsageSummary,
        roles: [
          { role: 'implementation', input: 40_000, output: 18_300, total: 58_300 },
          { role: 'ship', input: 4_000, output: 1_600, total: 5_600 },
        ] as RecordedRoleUsage[],
      }),
    );
    if (view.status !== 'complete') throw new Error('expected a complete receipt');
    const blocks = view.evidence.blocks ?? [];
    expect(blocks.map((b) => b.label)).toEqual(['Delivered', 'Validated', 'AI usage']);
    expect(blocks[0]).toMatchObject({
      value: '1 pull request merged',
      details: ['1 repository', '2 commits created by ship'],
    });
    expect(blocks[2]).toMatchObject({
      value: '110.9k recorded tokens',
      details: ['87.7k input · 23.2k output'],
      breakdown: [
        { amount: '58.3k', label: 'implementation' },
        { amount: '5.6k', label: 'ship' },
      ],
    });
  });

  it('states an unrecorded spend as absence, never as a zero', () => {
    const view = doneReceipt(receiptInput({ completedAt: NOW, tokens: null, roles: [] }));
    if (view.status !== 'complete') throw new Error('expected a complete receipt');
    const usage = (view.evidence.blocks ?? []).find((b) => b.label === 'AI usage');
    expect(usage).toMatchObject({ value: 'No token usage recorded yet', details: [] });
    expect(usage?.breakdown).toBeUndefined();
  });

  it('names the recovery rounds in the validation block when any were recorded', () => {
    const view = doneReceipt(
      receiptInput({
        completedAt: NOW,
        rounds: [round(), round({ sourceStage: 'review' })],
        gateRuns: [gateRun({ gateName: 'lint' }), gateRun({ stageKey: 'review', gateName: 'test' })],
      }),
    );
    if (view.status !== 'complete') throw new Error('expected a complete receipt');
    const validated = (view.evidence.blocks ?? []).find((b) => b.label === 'Validated');
    expect(validated?.details).toContain('2 recovery rounds before delivery');
  });
});
