import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { recordGateRun } from '../store/gateRuns.js';
import { recordFindings } from '../store/reviewFindings.js';
import { recordUatFindings } from '../store/uatFindings.js';
import { openProcessRun, finishProcessRun } from '../store/processRuns.js';
import { openShipRun, closeShipRun, recordShipCommit } from '../store/shipRuns.js';
import {
  buildTicketArtifacts,
  pickArtifactPreviews,
  artifactPriority,
  type ArtifactSummary,
} from './artifacts.js';

describe('buildTicketArtifacts', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function ticket(overrides: Record<string, unknown> = {}) {
    const t = createTicket(store, { key: 'ART-1', title: 'artifacts' });
    store.db
      .prepare(
        `UPDATE tickets SET stage_current = COALESCE(?, stage_current),
                agent_provider = COALESCE(?, agent_provider),
                session_provider = COALESCE(?, session_provider)
         WHERE id = ?`,
      )
      .run(
        (overrides.stageCurrent as string | null) ?? null,
        (overrides.agentProvider as string | null) ?? null,
        (overrides.sessionProvider as string | null) ?? null,
        t.id,
      );
    return t;
  }

  function uatGates(ticketId: number, gates: { name: string; exitCode: number | null; skipped?: boolean }[], attempt = 0, repo = '/wt/web') {
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt,
      runAt: '2026-08-01T10:00:00.000Z',
      gates: gates.map((g) => ({ gateName: g.name, exitCode: g.exitCode, repo, skipped: g.skipped })),
    });
  }

  function stage(ticketId: number, key: string, status: string, startedAt: string | null, endedAt: string | null) {
    setStage(store, ticketId, key as never, {
      status: status as never,
      startedAt,
      endedAt,
      attempt: 0,
    });
  }

  it('returns [] when no stage has recorded evidence', () => {
    const t = ticket();
    expect(buildTicketArtifacts(store, t.id)).toEqual([]);
  });

  it('derives a passed UAT report from passing gates, never from recency', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [
      { name: 'lint', exitCode: 0 },
      { name: 'typecheck', exitCode: 0 },
      { name: 'test', exitCode: 0 },
    ]);

    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a).toMatchObject({
      id: 'uat-report',
      stage: 'uat',
      kind: 'uat-report',
      title: 'UAT report',
      status: 'passed',
      freshness: 'current',
      summary: '3 passed · 0 failed',
      versionCount: 1,
      currentVersionLabel: 'v1',
    });
    expect(a.metrics.filter((m) => m.label === 'passed' || m.label === 'failed')).toEqual([
      { label: 'passed', value: '3' },
      { label: 'failed', value: '0' },
    ]);
    expect(a.metrics.some((m) => m.label === 'duration')).toBe(true);
  });

  it('a null exit code (repo defines no such script) is NOT a pass', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [{ name: 'e2e', exitCode: null }]);
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.status).toBe('info');
    expect(a.summary).toContain('no script');
  });

  it('a skipped gate never enters the verdict', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [
      { name: 'test', exitCode: 0 },
      { name: 'e2e', exitCode: 0, skipped: true },
    ]);
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.summary).toBe('1 passed · 0 failed');
  });

  it('a failed gate makes the report failed and carries the verdict reason', () => {
    const t = ticket({ stageCurrent: 'fix' });
    stage(t.id, 'uat', 'failed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [
      { name: 'lint', exitCode: 0 },
      { name: 'test', exitCode: 2 },
    ]);
    store.db
      .prepare("UPDATE stages SET verdict = 'gates failed: test' WHERE ticket_id = ? AND stage_key = 'uat'")
      .run(t.id);
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.status).toBe('failed');
    expect(a.summary).toBe('1 passed · 1 failed');
    expect(a.detail).toBe('gates failed: test');
  });

  it('marks a UAT report stale when implementation ran again after it', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'impl', 'passed', '2026-08-01T08:00:00.000Z', '2026-08-01T08:30:00.000Z');
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [{ name: 'test', exitCode: 0 }]);
    expect(buildTicketArtifacts(store, t.id)[0]!.freshness).toBe('current');

    // The fix loop re-entered implementation AFTER the verification ended.
    stage(t.id, 'fix', 'running', '2026-08-01T10:30:00.000Z', null);
    expect(buildTicketArtifacts(store, t.id)[0]!.freshness).toBe('stale');
  });

  it('derives a Review artifact with findings needing attention', () => {
    const t = ticket({ stageCurrent: 'review' });
    stage(t.id, 'review', 'running', '2026-08-01T09:00:00.000Z', null);
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T09:30:00.000Z',
      findings: [
        {
          severity: 'high',
          repo: '/wt/web',
          file: 'src/a.ts',
          title: 'Credential cache is not cleared',
          detail: 'The cache outlives the session.',
          source: 'agent',
        },
        { severity: 'low', repo: '/wt/web', title: 'Missing analytics event', detail: '', source: 'agent' },
      ],
    });

    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a).toMatchObject({
      id: 'review',
      stage: 'review',
      status: 'attention',
      summary: '2 findings · 1 needs attention',
    });
    expect(a.findings).toHaveLength(2);
    expect(a.findings[0]).toMatchObject({ severity: 'high', file: 'src/a.ts' });
    expect(a.metrics.some((m) => m.label === 'high' && m.value === '1')).toBe(true);  });

  it('a review with no findings and passing gates is passed', () => {
    const t = ticket({ stageCurrent: 'review' });
    stage(t.id, 'review', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T09:30:00.000Z');
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T09:10:00.000Z',
      gates: [{ gateName: 'lint', exitCode: 0, repo: '/wt/web' }],
    });
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.status).toBe('passed');
  });

  it('the Changes-panel evidence row is not a review gate', () => {
    const t = ticket({ stageCurrent: 'review' });
    stage(t.id, 'review', 'running', '2026-08-01T09:00:00.000Z', null);
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T09:10:00.000Z',
      gates: [{ gateName: 'changes', exitCode: null, repo: '/wt/web' }],
    });
    expect(buildTicketArtifacts(store, t.id)).toEqual([]);
  });

  it('carries UAT tester observations as findings', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [{ name: 'test', exitCode: 0 }]);
    const run = openProcessRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      processId: 'tester',
      attempt: 0,
      startedAt: '2026-08-01T09:05:00.000Z',
    });
    finishProcessRun(store, run.id, 'passed', '2026-08-01T09:55:00.000Z');
    recordUatFindings(store, {
      ticketId: t.id,
      processRunId: run.id,
      createdAt: '2026-08-01T09:50:00.000Z',
      findings: [
        {
          severity: 'info',
          repo: '/wt/web',
          title: 'Login flow renders',
          file: 'src/login.ts',
          line: 12,
        },
      ],
    });
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ severity: 'info', title: 'Login flow renders', file: 'src/login.ts', line: 12 });
  });

  it('attributes origin to the process identity snapshot, then session, then config', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [{ name: 'test', exitCode: 0 }]);

    const run = openProcessRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      processId: 'tester',
      attempt: 0,
      startedAt: '2026-08-01T09:05:00.000Z',
      provider: 'codex',
      agentName: 'uat-tester',
    });
    finishProcessRun(store, run.id, 'passed', '2026-08-01T09:55:00.000Z');
    expect(buildTicketArtifacts(store, t.id)[0]!.origin).toEqual({ kind: 'karst', core: 'codex' });
  });

  it('falls back to session_provider and then agent_provider for legacy evidence', () => {
    const t = ticket({ stageCurrent: 'uat', sessionProvider: 'claude', agentProvider: 'codex' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [{ name: 'test', exitCode: 0 }]);
    expect(buildTicketArtifacts(store, t.id)[0]!.origin).toEqual({ kind: 'karst', core: 'claude' });

    store.db.prepare('UPDATE tickets SET session_provider = NULL WHERE id = ?').run(t.id);
    expect(buildTicketArtifacts(store, t.id)[0]!.origin).toEqual({ kind: 'karst', core: 'codex' });

    store.db.prepare('UPDATE tickets SET agent_provider = NULL WHERE id = ?').run(t.id);
    expect(buildTicketArtifacts(store, t.id)[0]!.origin).toEqual({ kind: 'karst', core: null });
  });

  it('derives a ship-summary from the latest ship run with PRs and commits', () => {
    const t = ticket({ stageCurrent: 'ship' });
    const run = openShipRun(store, { ticketId: t.id, attempt: 0, startedAt: '2026-08-01T11:00:00.000Z' });
    closeShipRun(store, run.id, 'passed', '2026-08-01T11:05:00.000Z');
    recordShipCommit(store, {
      shipRunId: run.id,
      repo: 'web',
      sha: 'abc123',
      message: 'feat: add passkey login',
      origin: 'created-by-ship',
    });
    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'web', 42, 'https://github.com/o/r/pull/42', 'open')`,
      )
      .run(t.id);

    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a).toMatchObject({
      id: 'ship-summary',
      stage: 'ship',
      status: 'passed',
      freshness: 'current',
      summary: '1 PR opened · 1 commit',
    });
    expect(a.prs).toHaveLength(1);
    expect(a.prs[0]).toMatchObject({ number: 42, url: 'https://github.com/o/r/pull/42' });
    expect(a.commits[0]).toMatchObject({ sha: 'abc123' });
  });

  it('each ship run is a version; versions never inflate the artifact count', () => {
    const t = ticket({ stageCurrent: 'ship' });
    const run1 = openShipRun(store, { ticketId: t.id, attempt: 0, startedAt: '2026-08-01T10:00:00.000Z' });
    closeShipRun(store, run1.id, 'passed', '2026-08-01T10:05:00.000Z');
    const run2 = openShipRun(store, { ticketId: t.id, attempt: 0, startedAt: '2026-08-01T11:00:00.000Z' });
    closeShipRun(store, run2.id, 'passed', '2026-08-01T11:05:00.000Z');

    const all = buildTicketArtifacts(store, t.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.versionCount).toBe(2);
    expect(all[0]!.currentVersionLabel).toBe('v2');
  });

  it('retries of one gate stage are versions of one UAT report, not new artifacts', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [{ name: 'test', exitCode: 2 }], 0);
    uatGates(t.id, [{ name: 'test', exitCode: 0 }], 1);
    const all = buildTicketArtifacts(store, t.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.versionCount).toBe(2);
    expect(all[0]!.status).toBe('passed');
  });

  it('lists the stage log as the artifact resource, basename only', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    uatGates(t.id, [{ name: 'test', exitCode: 0 }]);
    store.db
      .prepare("UPDATE stages SET artifact_path = '/data/karst/artifacts/1/uat-ticket-1.log' WHERE ticket_id = ? AND stage_key = 'uat'")
      .run(t.id);
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.resources).toEqual([{ name: 'uat-ticket-1.log', path: '/data/karst/artifacts/1/uat-ticket-1.log' }]);
  });
});

describe('pickArtifactPreviews', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('shows at most 3 previews', () => {
    const t = createTicket(store, { key: 'ART-2', title: 'many' });
    setStage(store, t.id, 'uat', { status: 'passed', startedAt: '2026-08-01T09:00:00.000Z', endedAt: '2026-08-01T10:00:00.000Z' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T09:30:00.000Z',
      gates: [{ gateName: 'test', exitCode: 0, repo: '/wt' }],
    });
    const artifacts = buildTicketArtifacts(store, t.id);
    expect(artifacts.length).toBeLessThanOrEqual(3);
    expect(pickArtifactPreviews(artifacts)).toEqual(artifacts.slice(0, 3));
  });

  it('orders by semantic priority: active tickets put UAT first, done tickets put PR summary first', () => {
    const a = { kind: 'uat-report' as const };
    const r = { kind: 'review' as const };
    const s = { kind: 'ship-summary' as const };
    expect(artifactPriority(a.kind, 'uat')).toBeLessThan(artifactPriority(r.kind, 'uat'));
    expect(artifactPriority(r.kind, 'uat')).toBeLessThan(artifactPriority(s.kind, 'uat'));
    expect(artifactPriority(s.kind, 'done')).toBeLessThan(artifactPriority(a.kind, 'done'));
    expect(artifactPriority(a.kind, 'done')).toBeLessThan(artifactPriority(r.kind, 'done'));
  });
});
