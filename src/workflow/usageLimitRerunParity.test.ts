import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { listOpenParks } from '../store/usageLimitParks.js';
import { parkGateStage, stageBlock } from '../store/stageBlocks.js';
import { listStageRuns, openStageRun } from '../store/stageRuns.js';
import { listProcessRuns } from '../store/processRuns.js';
import { listRecoveryRounds } from '../store/recoveryRounds.js';
import { listFindings as listAllFindings } from '../store/reviewFindings.js';
import { isCoverageRecord } from './coverageRecord.js';

/** The agent's findings only: the advisory coverage record is asserted on its own. */
const listFindings = (...args: Parameters<typeof listAllFindings>) =>
  listAllFindings(...args).filter((f) => !isCoverageRecord(f));
import { transition } from './machine.js';
import { rerunParkedStage } from './usageLimitRerun.js';
import { UsageLimitError } from '../agent/cliFailure.js';
import type { BaselineEntry } from './gates/baselineReview.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { Manifest } from '../manifest/types.js';

/**
 * Characterization of `rerunParkedStage`'s observable result per outcome. The
 * re-run's lane code is being delegated to `runReview`/`runUat`; these tests
 * pin what a caller (and the store) sees so that move changes nothing.
 */

const PARKED_AT = '2026-10-13T10:00:00.000Z';
const GREEN_GATE = {
  gateName: 'test (web)',
  exitCode: 0,
  startedAt: PARKED_AT,
  endedAt: '2026-10-13T10:00:01.000Z',
  repo: 'web',
  command: 'npm',
  args: ['test'],
};
const REVIEW_MANIFEST = {
  review: { requireIndependentSignal: false, findings: { blockingSeverity: 'high' }, maxFixAttempts: 2 },
} as unknown as Manifest;
const UAT_MANIFEST = {
  uat: { testerObservations: { blockingSeverity: 'high' }, maxFixAttempts: 2 },
} as unknown as Manifest;
const CHANGED: BaselineEntry = {
  repo: 'web',
  cwd: '/wt/web',
  path: 'tests/visual/baselines/ticket-form.png',
  status: 'modified',
  newSha256: 'sha-new',
  mergeBase: 'abc123',
  autoApproved: false,
};

function adapterOf(runHeadless: ReturnType<typeof vi.fn>): AgentAdapter {
  return {
    requiredBinary: 'fake',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => {
      throw new Error('not used');
    },
    runHeadless: runHeadless as unknown as AgentAdapter['runHeadless'],
  };
}

const answer = (items: unknown[]) => vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify(items) });
const BLOCKING = [{ severity: 'critical', title: 'Injection', file: 'src/db.ts', line: 42, detail: 'raw query' }];

describe('rerunParkedStage — outcome parity', () => {
  let store: Store;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-rerun-parity-'));
  });
  afterEach(() => rmSync(artifactDir, { recursive: true, force: true }));

  /** A stage parked on a usage limit AFTER its gates passed, with a `web` worktree. */
  function parkAt(lane: 'review' | 'uat', keptOutcome: string | null) {
    const ticket = createTicketFlow(store, { key: `PARITY-${lane}`, title: 't' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(ticket.id, 'web', '/wt/web', 'karst/web', 'develop');
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    if (lane === 'review') transition(store, ticket.id, 'uat', { kind: 'passed' });
    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: lane,
      attempt: 0,
      runAt: PARKED_AT,
      startedAt: PARKED_AT,
    });
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: lane,
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: PARKED_AT,
      gates: [GREEN_GATE],
      stageRunId: parkedRunId,
      park: { provider: 'anthropic', model: 'claude-3-7-sonnet', lane, target: 'web', detail: 'quota', keptOutcome },
    });
    return { ticket, parkedRunId, park: listOpenParks(store, ticket.id)[0]! };
  }

  async function rerun(
    park: ReturnType<typeof parkAt>['park'],
    adapter: AgentAdapter,
    manifest: Manifest,
    extra: Partial<Parameters<typeof rerunParkedStage>[0]> = {},
  ) {
    return rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter,
      manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
      ...extra,
    });
  }

  /** What a caller and the store see after the re-run, for the stage's own rows. */
  function observed(ticketId: number, stageKey: 'review' | 'uat', parkedRunId: number) {
    const run = listStageRuns(store, ticketId).find((r) => r.stageKey === stageKey && r.id !== parkedRunId);
    return {
      stageRun: run ? { status: run.status, outcome: run.outcome } : null,
      processResults: listProcessRuns(store, ticketId).map((p) => p.resultKind),
      triggers: listRecoveryRounds(store, ticketId).map((r) => r.triggerKind),
      findings: listFindings(store, ticketId).length,
    };
  }

  it('review pass', async () => {
    const { ticket, parkedRunId, park } = parkAt('review', JSON.stringify({ findings: 0, targets: [] }));
    const res = await rerun(park, adapterOf(answer([])), REVIEW_MANIFEST);
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(observed(ticket.id, 'review', parkedRunId)).toEqual({
      stageRun: { status: 'finished', outcome: 'advanced' },
      processResults: ['validated'],
      triggers: [],
      findings: 0,
    });
  });

  it('review blocking finding fails the verdict with a blocking-review-findings round', async () => {
    const { ticket, parkedRunId, park } = parkAt('review', JSON.stringify({ findings: 0, targets: [] }));
    const res = await rerun(park, adapterOf(answer(BLOCKING)), REVIEW_MANIFEST);
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(observed(ticket.id, 'review', parkedRunId)).toEqual({
      stageRun: { status: 'finished', outcome: 'advanced' },
      processResults: ['blocking'],
      triggers: ['blocking-review-findings'],
      findings: 1,
    });
  });

  it('review re-park keeps the sibling and the fresh target in the new park', async () => {
    const prior = JSON.stringify({ findings: 2, targets: [{ repo: 'api', status: 'unreadable', findings: 2 }] });
    const { ticket, parkedRunId, park } = parkAt('review', prior);
    const quota = vi.fn().mockRejectedValue(
      new UsageLimitError('Claude usage limit reached — out of credits.', {
        tool: 'Claude',
        provider: 'claude',
        model: 'claude-3-7-sonnet',
      }),
    );
    const res = await rerun(park, adapterOf(quota), REVIEW_MANIFEST, { provider: 'claude', model: 'claude-3-7-sonnet' });
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'usage-limit' });
    expect(observed(ticket.id, 'review', parkedRunId).processResults).toEqual(['execution-failed']);
    const kept = JSON.parse(listOpenParks(store, ticket.id)[0]!.keptOutcome!);
    expect(kept.targets.map((t: { repo: string }) => t.repo).sort()).toEqual(['api', 'web']);
    expect(kept.findings).toBe(2);
  });

  it('uat pass', async () => {
    const { ticket, parkedRunId, park } = parkAt('uat', JSON.stringify({ observations: [], targets: [] }));
    const res = await rerun(park, adapterOf(answer([])), UAT_MANIFEST);
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(observed(ticket.id, 'uat', parkedRunId)).toEqual({
      stageRun: { status: 'finished', outcome: 'advanced' },
      processResults: ['observed'],
      triggers: [],
      findings: 0,
    });
  });

  it('uat blocking observation fails the verdict', async () => {
    const { ticket, parkedRunId, park } = parkAt('uat', JSON.stringify({ observations: [], targets: [] }));
    const obs = [{ severity: 'high', title: 'Button inert', file: 'src/index.html', line: 10, detail: 'no submit' }];
    const res = await rerun(park, adapterOf(answer(obs)), UAT_MANIFEST);
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(observed(ticket.id, 'uat', parkedRunId)).toEqual({
      stageRun: { status: 'finished', outcome: 'advanced' },
      processResults: ['observed'],
      triggers: ['blocking-tester-observations'],
      findings: 0,
    });
  });

  it('uat unapproved baseline blocks before the Tester', async () => {
    const { ticket, parkedRunId, park } = parkAt('uat', JSON.stringify({ observations: [], targets: [] }));
    const runHeadless = answer([]);
    const manifest = {
      uat: { testerObservations: { blockingSeverity: 'none' }, baselineReview: { paths: ['tests/visual/baselines/**'] } },
    } as unknown as Manifest;
    const res = await rerun(park, adapterOf(runHeadless), manifest, {
      detectBaselines: vi.fn().mockResolvedValue([CHANGED]),
    });
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'baseline-review' });
    expect(runHeadless).not.toHaveBeenCalled();
    expect(observed(ticket.id, 'uat', parkedRunId)).toEqual({
      stageRun: { status: 'finished', outcome: 'blocked' },
      processResults: [],
      triggers: [],
      findings: 0,
    });
  });

  it('stop reopens the park and closes the run it opened as stopped', async () => {
    const { ticket, parkedRunId, park } = parkAt('review', null);
    const res = await rerun(park, adapterOf(answer([])), REVIEW_MANIFEST, { signal: AbortSignal.abort() });
    expect(res).toEqual({ kind: 'stopped' });
    expect(observed(ticket.id, 'review', parkedRunId)).toMatchObject({
      stageRun: { status: 'finished', outcome: 'stopped' },
    });
    expect(listOpenParks(store, ticket.id).map((p) => p.id)).toEqual([park.id]);
    expect(stageBlock(store, ticket.id, 'review')).toMatchObject({ kind: 'usage-limit' });
  });
});
