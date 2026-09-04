import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { recordGateRun } from '../store/gateRuns.js';
import { recordFindings } from '../store/reviewFindings.js';
import { recordUatFindings } from '../store/uatFindings.js';
import { openProcessRun, finishProcessRun } from '../store/processRuns.js';
import { openShipRun, closeShipRun, recordShipCommit } from '../store/shipRuns.js';
import { getTicket } from '../store/tickets.js';
import { listGateRuns } from '../store/gateRuns.js';
import { listFindings } from '../store/reviewFindings.js';
import { listUatFindings } from '../store/uatFindings.js';
import { listProcessRuns } from '../store/processRuns.js';
import { listShipEvidence, countShipRuns } from '../store/shipRuns.js';
import { listPrsByTicket } from '../store/dashboard.js';
import { recordPhaseMark } from '../store/phaseMarks.js';
import { listPhaseMarks } from '../store/phaseMarks.js';
import { readPlanInput } from './artifacts.js';
import {
  buildTicketArtifacts,
  buildArtifactsFrom,
  pickArtifactPreviews,
  artifactPriority,
  type ArtifactInput,
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
      runAt: `2026-08-01T1${attempt}:00:00.000Z`,
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
    // The duration is HUMANIZED — the one-hour span reads as "1h 0m", never
    // as a raw seconds count.
    expect(a.metrics.some((m) => m.label === 'duration')).toBe(true);
    expect(a.metrics.find((m) => m.label === 'duration')?.value).toBe('1h 0m');
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

  it('names the gate-lane AI process whose console the report can open', () => {
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'running', '2026-08-01T09:00:00.000Z', null);
    uatGates(t.id, [{ name: 'test', exitCode: 0 }]);
    // No tester run yet: nothing produced a console, so the report names none.
    expect(buildTicketArtifacts(store, t.id)[0]!.agentConsole).toBeNull();

    openProcessRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      processId: 'tester',
      attempt: 0,
      startedAt: '2026-08-01T09:05:00.000Z',
    });
    // A RUNNING tester already streams: the console is offered before the run
    // finishes, which is the whole point of a live preview.
    expect(buildTicketArtifacts(store, t.id)[0]!.agentConsole).toBe('tester');
  });

  it('names the review lane on the review report, and nothing on non-gate artifacts', () => {
    const t = ticket({ stageCurrent: 'review' });
    stage(t.id, 'review', 'running', '2026-08-01T09:00:00.000Z', null);
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T09:10:00.000Z',
      gates: [{ gateName: 'test', exitCode: 0, repo: '/wt/web' }],
    });
    openProcessRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      processId: 'review',
      attempt: 0,
      startedAt: '2026-08-01T09:05:00.000Z',
    });
    const all = buildTicketArtifacts(store, t.id);
    const review = all.find((a) => a.id === 'review');
    expect(review?.agentConsole).toBe('review');
    for (const a of all) {
      if (a.stage !== 'uat' && a.stage !== 'review') expect(a.agentConsole).toBeNull();
    }
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

  it('mints the open-commit capability for ship commits through the attach seam', () => {
    const t = ticket({ stageCurrent: 'ship' });
    const run = openShipRun(store, { ticketId: t.id, attempt: 0, startedAt: '2026-08-01T11:00:00.000Z' });
    closeShipRun(store, run.id, 'passed', '2026-08-01T11:05:00.000Z');
    recordShipCommit(store, {
      shipRunId: run.id,
      repo: 'web',
      sha: 'abc123',
      message: 'feat: passkey login',
      origin: 'created-by-ship',
    });

    // Without an attach callback the SHA carries no capability — plain text.
    const plain = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(plain[0].commits[0]?.action).toBeUndefined();

    // With one, the SAME host seam the inside evidence uses mints it, keyed to
    // the recorded ship commit's id.
    const targets: Array<{ kind: string; shipCommitId: number }> = [];
    let n = 0;
    const attach = (target: { kind: string; shipCommitId?: number }) => {
      n += 1;
      if (target.kind === 'open-commit' && target.shipCommitId !== undefined) {
        targets.push({ kind: 'open-commit', shipCommitId: target.shipCommitId });
      }
      return { actionId: `snapshot-1:action-${n}`, kind: target.kind } as {
        actionId: string;
        kind: 'open-commit';
      };
    };
    const input: ArtifactInput = {
      ticket: getTicket(store, t.id),
      gateRuns: listGateRuns(store, t.id),
      findings: listFindings(store, t.id),
      uatFindings: listUatFindings(store, t.id),
      processRuns: listProcessRuns(store, t.id),
      ship: listShipEvidence(store, t.id),
      shipRunCount: countShipRuns(store, t.id),
      prs: listPrsByTicket(store, t.id),
      phaseMarks: [],
      declaredPhases: [],
      attach,
    };
    const [a] = buildArtifactsFrom(input) as [ArtifactSummary];
    const commitId = (store.db.prepare('SELECT id FROM ship_commits LIMIT 1').get() as { id: number }).id;
    expect(targets).toEqual([{ kind: 'open-commit', shipCommitId: commitId }]);
    expect(a.commits[0]).toMatchObject({
      sha: 'abc123',
      action: { actionId: 'snapshot-1:action-1', kind: 'open-commit' },
    });
  });

  it('mints the open-file capability for a finding that names a location', () => {
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
          detail: '',
          source: 'agent',
        },
      ],
    });

    const targets: Array<{ kind: string; source: string; id: number }> = [];
    let n = 0;
    const attach = (target: { kind: string; evidence?: { source?: string; id?: number } }) => {
      n += 1;
      if (target.kind === 'open-file') {
        targets.push({
          kind: 'open-file',
          source: target.evidence?.source ?? '',
          id: target.evidence?.id ?? 0,
        });
      }
      return { actionId: `snapshot-1:action-${n}`, kind: target.kind } as { actionId: string; kind: 'open-file' };
    };
    const input: ArtifactInput = {
      ticket: getTicket(store, t.id),
      gateRuns: listGateRuns(store, t.id),
      findings: listFindings(store, t.id),
      uatFindings: listUatFindings(store, t.id),
      processRuns: listProcessRuns(store, t.id),
      ship: listShipEvidence(store, t.id),
      shipRunCount: countShipRuns(store, t.id),
      prs: listPrsByTicket(store, t.id),
      phaseMarks: [],
      declaredPhases: [],
      attach,
    };
    const [a] = buildArtifactsFrom(input) as [ArtifactSummary];
    const findingId = (store.db.prepare('SELECT id FROM review_findings LIMIT 1').get() as { id: number }).id;
    expect(targets).toEqual([{ kind: 'open-file', source: 'review-finding', id: findingId }]);
    expect(a.findings[0]).toMatchObject({
      file: 'src/a.ts',
      action: { actionId: 'snapshot-1:action-1', kind: 'open-file' },
    });
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

  it('a gate run and its process run sharing stageRunId count as ONE version, not two', () => {
    // One UAT invocation produces both a gate-run batch and a tester process
    // run — different timestamps (runAt vs startedAt), same stageRunId. The
    // version count must be 1, not 2 (the overcount the review caught).
    const t = ticket({ stageCurrent: 'uat' });
    stage(t.id, 'uat', 'passed', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z');
    const stageRunId = store.db
      .prepare(
        `INSERT INTO stage_runs (ticket_id, stage_key, attempt, run_at, status, started_at)
         VALUES (?, 'uat', 0, ?, 'finished', ?)`,
      )
      .run(t.id, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z').lastInsertRowid as number;
    store.db
      .prepare(
        `INSERT INTO gate_runs
           (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, started_at, ended_at, repo, command, stage_run_id)
         VALUES (?, 'uat', 0, ?, 'test', 0, ?, ?, 'api', 'npm test', ?)`,
      )
      .run(t.id, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z', '2026-08-01T10:05:00.000Z', stageRunId);
    const procRun = openProcessRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      processId: 'tester',
      attempt: 0,
      startedAt: '2026-08-01T10:02:00.000Z',
      stageRunId,
    });
    finishProcessRun(store, procRun.id, 'passed', '2026-08-01T10:04:00.000Z');
    const all = buildTicketArtifacts(store, t.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.versionCount).toBe(1);
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

/** A minimal VALID canonical graph document — nodes carry the plan's labels. */
const CANONICAL_GRAPH = JSON.stringify({
  version: 1,
  title: 'Plan',
  rationaleArtifact: 'task',
  entries: ['impl'],
  artifacts: [
    { id: 'task', path: 'artifacts/plan/task.md', producer: '$planner', consumers: ['impl'], mediaType: 'text/markdown', maxBytes: 1024, required: true },
  ],
  nodes: [
    { id: 'impl', kind: 'agent', label: 'Implement the feature', profile: 'worker', instructionsArtifact: 'task', inputs: ['task'], outputs: [], resources: { reads: [], writes: [] }, outcomes: ['complete', 'blocked', 'replan'], budget: { maxVisits: 1 } },
    { id: 'verify', kind: 'command', label: 'Verify', command: 'test', repositories: ['api'], outcomes: ['passed', 'failed'], budget: { maxVisits: 2 } },
  ],
  edges: [
    { id: 'e1', from: 'impl', on: 'complete', to: 'verify' },
    { id: 'e2', from: 'verify', on: 'passed', to: 'END' },
  ],
  budgets: { maxNodeRuns: 4, maxExpertRuns: 1, maxReplans: 0 },
});

function seedGraphPlan(
  store: Store,
  ticketId: number,
  over: { status?: string; nodeStatuses?: { nodeId: string; status: string; visit?: number }[] } = {},
): void {
  store.db
    .prepare(
      `INSERT INTO approach_graph_runs
         (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (?, 'impl', 0, 'karst-graph-engineering', ?, '2026-08-01T08:00:00.000Z')`,
    )
    .run(ticketId, over.status ?? 'running');
  const graphRunId = (store.db.prepare('SELECT id FROM approach_graph_runs WHERE ticket_id = ?').get(ticketId) as { id: number }).id;
  store.db
    .prepare(
      `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status)
       VALUES (?, 1, 'bootstrap', 'submitted')`,
    )
    .run(graphRunId);
  store.db
    .prepare(
      `INSERT INTO approach_graph_revisions
         (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
       VALUES (?, 1, ?, 'fp', 'active', '2026-08-01T08:05:00.000Z')`,
    )
    .run(graphRunId, CANONICAL_GRAPH);
  const revisionId = (store.db
    .prepare('SELECT id FROM approach_graph_revisions WHERE graph_run_id = ?')
    .get(graphRunId) as { id: number }).id;
  for (const node of over.nodeStatuses ?? []) {
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, '2026-08-01T08:10:00.000Z')`,
      )
      .run(graphRunId, revisionId, node.nodeId, 'agent', node.visit ?? 1, node.status);
  }
}

describe('plan artifact (graph evidence)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function ticket(stageCurrent: string) {
    const t = createTicket(store, { key: 'PL-1', title: 'plan' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stageCurrent, t.id);
    return t;
  }

  it('derives no plan artifact when the graph approach never drove the ticket', () => {
    const t = ticket('impl');
    expect(buildTicketArtifacts(store, t.id)).toEqual([]);
  });

  it('tracks each node with its latest status: done, doing, todo, blocked', () => {
    const t = ticket('impl');
    seedGraphPlan(store, t.id, {
      nodeStatuses: [
        { nodeId: 'impl', status: 'completed' },
        { nodeId: 'verify', status: 'running' },
      ],
    });

    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a).toMatchObject({
      id: 'plan',
      stage: 'impl',
      kind: 'plan',
      title: 'Plan',
      status: 'info',
      freshness: 'current',
      summary: '2 tasks · 1 done · 1 in progress',
      versionCount: 1,
      currentVersionLabel: 'v1',
    });
    expect(a.metrics).toEqual([
      { label: 'to-do', value: '0' },
      { label: 'in progress', value: '1' },
      { label: 'done', value: '1' },
    ]);
    // Labels come from the canonical graph; a node that never ran reads todo.
    expect(a.tasks).toEqual([
      { id: 'impl', label: 'Implement the feature', kind: 'agent', status: 'done', visits: 'visit 1' },
      { id: 'verify', label: 'Verify', kind: 'command', status: 'doing', visits: 'visit 1' },
    ]);
  });

  it('reads an unclaimed node as to-do and a blocked one as blocked', () => {
    const t = ticket('impl');
    seedGraphPlan(store, t.id, {
      nodeStatuses: [{ nodeId: 'verify', status: 'blocked' }],
    });
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.summary).toBe('2 tasks · 0 done');
    expect(a.status).toBe('attention');
    expect(a.metrics).toEqual([
      { label: 'to-do', value: '1' },
      { label: 'in progress', value: '0' },
      { label: 'done', value: '0' },
      { label: 'blocked', value: '1' },
    ]);
  });

  it('a closed run with every task done reads passed', () => {
    const t = ticket('done');
    seedGraphPlan(store, t.id, {
      status: 'closed',
      nodeStatuses: [
        { nodeId: 'impl', status: 'completed' },
        { nodeId: 'verify', status: 'completed' },
      ],
    });
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.status).toBe('passed');
  });

  it('a replanned revision is a new VERSION of the same plan, not a new artifact', () => {
    const t = ticket('impl');
    seedGraphPlan(store, t.id);
    const graphRunId = (store.db.prepare('SELECT id FROM approach_graph_runs WHERE ticket_id = ?').get(t.id) as { id: number }).id;
    // A replan supersedes the ACTIVE revision before the next one is created.
    store.db
      .prepare("UPDATE approach_graph_revisions SET status = 'superseded' WHERE graph_run_id = ? AND status = 'active'")
      .run(graphRunId);
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 2, ?, 'fp2', 'active', '2026-08-01T09:00:00.000Z')`,
      )
      .run(graphRunId, CANONICAL_GRAPH);
    const all = buildTicketArtifacts(store, t.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.versionCount).toBe(2);
    expect(all[0]!.currentVersionLabel).toBe('v2');
  });

  it('a node that ran but left the latest plan still reads as a task', () => {
    const t = ticket('impl');
    // Revision 2 drops the verify node; the earlier run remains evidence.
    const dropped = JSON.stringify({
      version: 1,
      title: 'Plan',
      rationaleArtifact: 'task',
      entries: ['impl'],
      artifacts: [
        { id: 'task', path: 'artifacts/plan/task.md', producer: '$planner', consumers: ['impl'], mediaType: 'text/markdown', maxBytes: 1024, required: true },
      ],
      nodes: [
        { id: 'impl', kind: 'agent', label: 'Implement the feature', profile: 'worker', instructionsArtifact: 'task', inputs: ['task'], outputs: [], resources: { reads: [], writes: [] }, outcomes: ['complete', 'blocked', 'replan'], budget: { maxVisits: 1 } },
      ],
      edges: [{ id: 'e1', from: 'impl', on: 'complete', to: 'END' }],
      budgets: { maxNodeRuns: 4, maxExpertRuns: 1, maxReplans: 0 },
    });
    seedGraphPlan(store, t.id);
    const graphRunId = (store.db.prepare('SELECT id FROM approach_graph_runs WHERE ticket_id = ?').get(t.id) as { id: number }).id;
    const oldRevision = (store.db
      .prepare('SELECT id FROM approach_graph_revisions WHERE graph_run_id = ? ORDER BY revision_number DESC LIMIT 1')
      .get(graphRunId) as { id: number }).id;
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, started_at)
         VALUES (?, ?, 'verify', 'command', 1, 'completed', '2026-08-01T08:10:00.000Z')`,
      )
      .run(graphRunId, oldRevision);
    store.db
      .prepare("UPDATE approach_graph_revisions SET status = 'superseded' WHERE graph_run_id = ? AND status = 'active'")
      .run(graphRunId);
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 2, ?, 'fp2', 'active', '2026-08-01T09:00:00.000Z')`,
      )
      .run(graphRunId, dropped);

    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.tasks.map((task) => task.id)).toEqual(['impl', 'verify']);
    expect(a.tasks.find((task) => task.id === 'verify')).toMatchObject({ status: 'done' });
  });

  it('carries the planner-produced artifacts as the underlying files', () => {
    const t = ticket('impl');
    seedGraphPlan(store, t.id);
    const graphRunId = (store.db.prepare('SELECT id FROM approach_graph_runs WHERE ticket_id = ?').get(t.id) as { id: number }).id;
    const plannerRunId = (store.db
      .prepare('SELECT id FROM approach_planner_runs WHERE graph_run_id = ?')
      .get(graphRunId) as { id: number }).id;
    store.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, NULL, 'task', ?, '/data/karst/graph/1/plan.md', 'sha', 'text/markdown', 512, '2026-08-01T08:06:00.000Z')`,
      )
      .run(graphRunId, plannerRunId);
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.resources).toEqual([{ name: 'plan.md', path: '/data/karst/graph/1/plan.md' }]);
  });

  it('the plan artifact is FIRST in semantic priority for an active ticket', () => {
    const t = ticket('impl');
    seedGraphPlan(store, t.id);
    setStage(store, t.id, 'uat', { status: 'passed', startedAt: '2026-08-01T09:00:00.000Z', endedAt: '2026-08-01T10:00:00.000Z' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T09:30:00.000Z',
      gates: [{ gateName: 'test', exitCode: 0, repo: '/wt/web' }],
    });
    const all = buildTicketArtifacts(store, t.id);
    expect(all[0]!.id).toBe('plan');
    expect(all[1]!.id).toBe('uat-report');
  });

  it('for a done ticket the PR summary outranks the plan', () => {
    const t = ticket('done');
    seedGraphPlan(store, t.id, { status: 'closed' });
    const run = openShipRun(store, { ticketId: t.id, attempt: 0, startedAt: '2026-08-01T11:00:00.000Z' });
    closeShipRun(store, run.id, 'passed', '2026-08-01T11:05:00.000Z');
    const all = buildTicketArtifacts(store, t.id);
    expect(all[0]!.id).toBe('ship-summary');
    expect(all.map((a) => a.id)).toContain('plan');
  });
});

describe('plan artifact (session phases, non-graph)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function ticket(
    stageCurrent: string,
    impl: {
      status: string;
      startedAt: string | null;
      endedAt: string | null;
    } = { status: 'running', startedAt: '2026-08-01T08:00:00.000Z', endedAt: null },
  ) {
    const t = createTicket(store, { key: 'PH-1', title: 'phases' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stageCurrent, t.id);
    setStage(store, t.id, 'impl', {
      status: impl.status as never,
      startedAt: impl.startedAt,
      endedAt: impl.endedAt,
      attempt: 0,
    });
    return t;
  }

  function phase(ticketId: number, name: string, at: string): void {
    recordPhaseMark(store, {
      ticketId,
      stageKey: 'impl',
      attempt: 0,
      phaseName: name,
      markedAt: at,
    });
  }

  it('derives no plan when the session declared no workflow and reported no phases', () => {
    const t = ticket('impl');
    expect(buildTicketArtifacts(store, t.id)).toEqual([]);
  });

  it('derives no plan before any impl evidence exists', () => {
    const t = ticket('scope', { status: 'pending', startedAt: null, endedAt: null });
    expect(buildTicketArtifacts(store, t.id, ['research', 'plan', 'implement'])).toEqual([]);
  });

  it('declares the workflow as tasks before any phase is reported', () => {
    const t = ticket('impl');
    const [a] = buildTicketArtifacts(store, t.id, ['research', 'plan', 'implement']) as [ArtifactSummary];
    expect(a).toMatchObject({
      id: 'plan',
      stage: 'impl',
      kind: 'plan',
      title: 'Plan',
      status: 'info',
      freshness: 'current',
      summary: '3 tasks · 0 done',
      versionCount: 1,
      currentVersionLabel: 'v1',
    });
    expect(a.tasks).toEqual([
      { id: 'research', label: 'research', kind: 'phase', status: 'todo', visits: null },
      { id: 'plan', label: 'plan', kind: 'phase', status: 'todo', visits: null },
      { id: 'implement', label: 'implement', kind: 'phase', status: 'todo', visits: null },
    ]);
    expect(a.metrics).toEqual([
      { label: 'to-do', value: '3' },
      { label: 'in progress', value: '0' },
      { label: 'done', value: '0' },
    ]);
  });

  it('marks reported phases done and the latest in progress while the session runs', () => {
    const t = ticket('impl');
    phase(t.id, 'research', '2026-08-01T08:10:00.000Z');
    phase(t.id, 'plan', '2026-08-01T08:20:00.000Z');
    const [a] = buildTicketArtifacts(store, t.id, ['research', 'plan', 'implement']) as [ArtifactSummary];
    expect(a.summary).toBe('3 tasks · 1 done · 1 in progress');
    expect(a.tasks).toEqual([
      { id: 'research', label: 'research', kind: 'phase', status: 'done', visits: null },
      { id: 'plan', label: 'plan', kind: 'phase', status: 'doing', visits: null },
      { id: 'implement', label: 'implement', kind: 'phase', status: 'todo', visits: null },
    ]);
  });

  it('a phase the approach never declared still reads as a task', () => {
    const t = ticket('impl');
    phase(t.id, 'plan', '2026-08-01T08:20:00.000Z');
    phase(t.id, 'spike', '2026-08-01T08:30:00.000Z');
    const [a] = buildTicketArtifacts(store, t.id, ['plan', 'implement']) as [ArtifactSummary];
    expect(a.tasks.map((task) => task.label)).toEqual(['plan', 'implement', 'spike']);
    expect(a.tasks.find((task) => task.label === 'plan')).toMatchObject({ status: 'done' });
    expect(a.tasks.find((task) => task.label === 'spike')).toMatchObject({ status: 'doing' });
  });

  it('reported phases alone form the plan when no workflow is declared', () => {
    const t = ticket('impl');
    phase(t.id, 'research', '2026-08-01T08:10:00.000Z');
    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a).toMatchObject({ id: 'plan', summary: '1 task · 0 done · 1 in progress' });
    expect(a.tasks).toEqual([
      { id: 'research', label: 'research', kind: 'phase', status: 'doing', visits: null },
    ]);
  });

  it('a completed impl reads every reported phase done and the plan passed', () => {
    const t = ticket('impl', {
      status: 'passed',
      startedAt: '2026-08-01T08:00:00.000Z',
      endedAt: '2026-08-01T09:00:00.000Z',
    });
    phase(t.id, 'research', '2026-08-01T08:10:00.000Z');
    phase(t.id, 'implement', '2026-08-01T08:40:00.000Z');
    const [a] = buildTicketArtifacts(store, t.id, ['research', 'plan', 'implement']) as [ArtifactSummary];
    expect(a.status).toBe('passed');
    expect(a.tasks.find((task) => task.label === 'research')).toMatchObject({ status: 'done' });
    expect(a.tasks.find((task) => task.label === 'implement')).toMatchObject({ status: 'done' });
    expect(a.tasks.find((task) => task.label === 'plan')).toMatchObject({ status: 'todo' });
  });

  it('the graph plan wins when the graph approach drove the ticket', () => {
    const t = ticket('impl');
    seedGraphPlan(store, t.id, { nodeStatuses: [{ nodeId: 'verify', status: 'running' }] });
    phase(t.id, 'research', '2026-08-01T08:10:00.000Z');
    const [a] = buildTicketArtifacts(store, t.id, ['research', 'plan', 'implement']) as [ArtifactSummary];
    expect(a.tasks[0]).toMatchObject({ id: 'impl', label: 'Implement the feature', kind: 'agent' });
    expect(a.tasks.some((task) => task.kind === 'phase')).toBe(false);
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
