import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { listOpenParks } from '../store/usageLimitParks.js';
import { parkGateStage } from '../store/stageBlocks.js';
import { openStageRun } from '../store/stageRuns.js';
import { recordBaselineDecisions } from '../store/baselineDecisions.js';
import { transition } from './machine.js';
import { rerunParkedStage } from './usageLimitRerun.js';
import type { BaselineEntry } from './gates/baselineReview.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { Manifest } from '../manifest/types.js';

const CHANGED: BaselineEntry = {
  repo: 'web',
  cwd: '/wt/web',
  path: 'tests/visual/baselines/ticket-form.png',
  status: 'modified',
  newSha256: 'sha-new',
  mergeBase: 'abc123',
  autoApproved: false,
};

const MANIFEST = {
  uat: {
    testerObservations: { blockingSeverity: 'none' },
    baselineReview: { paths: ['tests/visual/baselines/**'] },
  },
} as unknown as Manifest;

describe('rerunParkedStage — UAT baseline review', () => {
  let store: Store;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-rerun-baseline-'));
  });

  afterEach(() => {
    rmSync(artifactDir, { recursive: true, force: true });
  });

  /** A UAT stage parked on a usage limit AFTER its gates passed, with a `web` worktree. */
  function parkUat() {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-BASELINE', title: 't' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(ticket.id, 'web', '/wt/web', 'karst/web', 'develop');
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat
    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [
        {
          gateName: 'test (web)',
          exitCode: 0,
          startedAt: '2026-10-13T10:00:00.000Z',
          endedAt: '2026-10-13T10:00:01.000Z',
          repo: 'web',
          command: 'npm',
          args: ['test'],
        },
      ],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: JSON.stringify({ observations: [], targets: [] }),
      },
    });
    return { ticket, park: listOpenParks(store, ticket.id)[0]! };
  }

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

  it('blocks on an unapproved changed baseline instead of committing passed, and never runs the Tester', async () => {
    const { park } = parkUat();
    const runHeadless = vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: '[]' });
    const detectBaselines = vi.fn().mockResolvedValue([CHANGED]);

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: adapterOf(runHeadless),
      manifest: MANIFEST,
      cwd: '/wt/web',
      artifactDir,
      detectBaselines,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toMatchObject({ kind: 'blocked', blocker: 'baseline-review' });
    expect(res).toMatchObject({ reason: expect.stringContaining('1 visual baseline(s) changed') });
    expect(runHeadless).not.toHaveBeenCalled();
    expect(detectBaselines).toHaveBeenCalledWith(
      store,
      MANIFEST,
      park.ticketId,
      [expect.objectContaining({ repo: 'web', path: '/wt/web' })],
      expect.anything(),
    );
  });

  it('runs the Tester once the user approved the changed baseline', async () => {
    const { ticket, park } = parkUat();
    recordBaselineDecisions(
      store,
      ticket.id,
      [{ repo: CHANGED.repo, path: CHANGED.path, sha256: CHANGED.newSha256, decision: 'approved', reason: null }],
      '2026-10-13T10:05:00.000Z',
    );
    const runHeadless = vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: '[]' });

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: adapterOf(runHeadless),
      manifest: MANIFEST,
      cwd: '/wt/web',
      artifactDir,
      detectBaselines: vi.fn().mockResolvedValue([CHANGED]),
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(runHeadless).toHaveBeenCalled();
  });

  it('blocks with the reason when git cannot answer the baseline question', async () => {
    const { park } = parkUat();
    const runHeadless = vi.fn();

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: adapterOf(runHeadless),
      manifest: MANIFEST,
      cwd: '/wt/web',
      artifactDir,
      detectBaselines: vi.fn().mockRejectedValue(new Error('git exploded')),
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing', reason: 'git exploded' });
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it('does not ask for baselines when the manifest does not opt in', async () => {
    const { park } = parkUat();
    const detectBaselines = vi.fn().mockResolvedValue([CHANGED]);

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: adapterOf(vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: '[]' })),
      manifest: { uat: { testerObservations: { blockingSeverity: 'none' } } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      detectBaselines,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(detectBaselines).not.toHaveBeenCalled();
  });
});
