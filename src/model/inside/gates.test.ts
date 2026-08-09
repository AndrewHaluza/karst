import { describe, it, expect } from 'vitest';
import type { GateRun } from '../../store/gateRuns.js';
import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { Finding } from '../../store/reviewFindings.js';
import type { UatFinding } from '../../store/uatFindings.js';
import type { Severity } from '../../manifest/types.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey, StageStatus } from '../types.js';
import { reviewProcesses, uatProcesses, type QualityProcessesInput } from './gates.js';
import { formatTime, type EvidenceRow, type InsideProcessView } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';

function cell(stageKey: StageKey, status: StageStatus, extra: Partial<StepperCell> = {}): StepperCell {
  return { stageKey, status, ...extra };
}

let nextId = 1;
function run(
  stageKey: StageKey,
  gateName: string,
  exitCode: number | null,
  extra: Partial<GateRun> = {},
): GateRun {
  return {
    id: nextId++,
    ticketId: 1,
    stageKey,
    attempt: 0,
    stageRunId: null,
    runAt: '2026-07-20T12:00:00.000Z',
    gateName,
    exitCode,
    startedAt: null,
    endedAt: null,
    repo: null,
    command: null,
    args: null,
    skipped: false,
    ...extra,
  };
}

let nextFindingId = 1;
function finding(severity: Severity, extra: Partial<Finding> = {}): Finding {
  return {
    id: nextFindingId++,
    ticketId: 1,
    attempt: 0,
    runAt: '2026-07-20T12:00:00.000Z',
    processRunId: null,
    severity,
    repo: '/web',
    file: null,
    line: null,
    title: 'x',
    detail: 'y',
    source: 'agent',
    createdAt: '2026-07-20T12:00:00.000Z',
    ...extra,
  };
}

let nextRunId = 1;
function processRun(extra: Partial<ProcessRun> = {}): ProcessRun {
  return {
    id: nextRunId++,
    ticketId: 1,
    stageKey: 'uat',
    processId: 'tester',
    attempt: 0,
    stageRunId: null,
    agentName: 'UAT Agent',
    provider: 'codex',
    model: 'sol',
    pid: null,
    status: 'passed',
    resultKind: 'observed',
    artifactPath: null,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:01:00.000Z',
    ...extra,
  };
}

let nextRoundId = 1;
function round(extra: Partial<RecoveryRound> = {}): RecoveryRound {
  return {
    id: nextRoundId++,
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
    status: 'pending',
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: null,
    ...extra,
  };
}

let nextUatFindingId = 1;
function uatFinding(severity: Severity, extra: Partial<UatFinding> = {}): UatFinding {
  return {
    id: nextUatFindingId++,
    ticketId: 1,
    processRunId: 1,
    repo: '/web',
    severity,
    title: 'x',
    filePath: null,
    line: null,
    createdAt: '2026-07-20T12:00:00.000Z',
    ...extra,
  };
}

function qualityInput(extra: Partial<QualityProcessesInput> = {}): QualityProcessesInput {
  return {
    cell: cell('uat', 'passed', {
      startedAt: '2026-07-20T12:00:00.000Z',
      endedAt: '2026-07-20T12:02:00.000Z',
    }),
    gateRuns: [],
    findings: [],
    uatFindings: [],
    processRuns: [],
    rounds: [],
    services: ['web', 'api'],
    now: NOW,
    ...extra,
  };
}

function rowsOf(process: InsideProcessView): readonly EvidenceRow[] {
  const evidence = process.evidence;
  if (evidence?.kind === 'rows') return evidence.rows;
  if (evidence?.kind === 'gates') return evidence.rows;
  if (evidence?.kind === 'findings') return evidence.rows;
  if (evidence?.kind === 'recovery') return evidence.rows;
  throw new Error(`expected rows-bearing evidence, got ${process.evidence?.kind ?? 'none'}`);
}


describe('uatProcesses', () => {
  it('emits gates, services, tester in registry order when nothing triggered recovery', () => {
    const views = uatProcesses(qualityInput());
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'tester']);
  });

  it('inserts the fix process immediately after gates for a gate-triggered round', () => {
    const views = uatProcesses(qualityInput({ rounds: [round()] }));
    expect(views.map((p) => p.id)).toEqual(['gates', 'fix', 'services', 'tester']);
  });

  it('inserts the fix process after the tester process for a verifier-triggered round', () => {
    const views = uatProcesses(
      qualityInput({
        rounds: [round({ sourceProcessId: 'tester', triggerKind: 'tester-verifier-failure' })],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'tester', 'fix']);
  });

  it('creates no fix process without recovery evidence, whatever the gate verdict', () => {
    const views = uatProcesses(
      qualityInput({ gateRuns: [run('uat', 'test (web)', 1, { runAt: NOW })] }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'tester']);
  });

  it('ships the gate counts as the gates process-row aggregate (B5)', () => {
    // handoff §6: "Gates  4 passed · 1 failed" — the whole batch is counted,
    // never the bounded subset; a disabled gate is stated, not folded in.
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'failed'),
        gateRuns: [
          run('uat', 'test (web)', 0, { runAt: NOW }),
          run('uat', 'e2e (web)', 3, { runAt: NOW }),
          run('uat', 'lint (web)', null, { runAt: NOW, skipped: true }),
        ],
      }),
    );
    expect(views[0]!.aggregate).toBe('2/3 · 1 passed · 1 failed · 1 skipped');
  });

  it('leads a recorded-but-unanswered batch as n/m, never absence', () => {
    // An all-note batch ("nothing to run") was RECORDED and answered nothing:
    // "0/1" states that. Absence is reserved for no recorded row at all.
    const views = uatProcesses(
      qualityInput({
        gateRuns: [run('uat', 'lint (web)', null, { runAt: NOW })],
      }),
    );
    expect(views[0]!.aggregate).toBe('0/1');
  });

  it('lists the resolved gate names as pending rows before the stage runs', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'pending'),
        resolvedGates: [{ name: 'lint', disabled: false }],
      }),
    );
    const gates = views[0]!;
    expect(rowsOf(gates)).toEqual([
      { status: 'pending', label: 'lint', detail: 'will run when the stage runs' },
    ]);
    expect(gates.detail).toBe('not run yet — these gates would run');
  });

  it('reads a blocked stage as waiting, never running, with no first-gate promise', () => {
    // `parkGateStage` leaves the runner's `running` status in place; an
    // empty-batch blocked stage must not draw a spinner or promise the first
    // gate's row — it waits on the block, and the banner above says why.
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'running', {
          blocked: { kind: 'nothing-to-run', reason: 'no target resolved', at: NOW, resumable: true },
        }),
      }),
    );
    const gates = views[0]!;
    expect(gates.status).toBe('wait');
    expect(gates.detail).toBe('blocked — the gates did not run');
  });

  it('keeps a passed stage with a block reading its recorded batch', () => {
    // A passed stage with a block (e.g. ship's awaiting-merge) stays passed —
    // `displayStatus` only reads `blocked` while the stored status is running.
    // With a recorded batch, the row states the batch's verdict, never `wait`.
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'passed', {
          blocked: { kind: 'awaiting-merge', reason: 'PRs open', at: NOW, resumable: false },
        }),
        gateRuns: [run('uat', 'test (web)', 0, { runAt: NOW })],
      }),
    );
    expect(views[0]!.status).toBe('pass');
  });

  it('marks a user-disabled gate as skipped, never as pending', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'pending'),
        resolvedGates: [{ name: 'typecheck', disabled: true }],
      }),
    );
    expect(rowsOf(views[0]!)).toEqual([
      { status: 'skip', label: 'typecheck', detail: 'disabled for this ticket' },
    ]);
  });

  it('never lets a forecast outrank a recorded run', () => {
    // A recorded row is a fact; a resolved name is a prediction. Both supplied
    // → the recorded batch wins and the forecast appears nowhere.
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'pending'),
        gateRuns: [run('uat', 'test (web)', 0, { runAt: NOW })],
        resolvedGates: [
          { name: 'lint', disabled: false },
          { name: 'test', disabled: false },
        ],
      }),
    );
    const gates = views[0]!;
    expect(rowsOf(gates).map((r) => r.label)).toEqual(['test (web)']);
    expect(rowsOf(gates).map((r) => r.status)).toEqual(['pass']);
  });

  it('counts no outcome for a gate that has not run', () => {
    // A gate that has not run has no verdict: counting a forecast would make
    // the aggregate lie.
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'pending'),
        resolvedGates: [
          { name: 'lint', disabled: false },
          { name: 'test', disabled: false },
          { name: 'e2e', disabled: false },
        ],
      }),
    );
    const gates = views[0]!;
    const evidence = gates.evidence as {
      kind: 'gates';
      rows: readonly EvidenceRow[];
      passed: number;
      failed: number;
      skipped: number;
    };
    expect(evidence.passed).toBe(0);
    expect(evidence.failed).toBe(0);
    expect(evidence.skipped).toBe(0);
    expect(gates.aggregate).toBeUndefined();
  });

  it('measures the gates process duration across the whole batch (B5)', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'passed', { startedAt: '2026-07-20T12:00:00.000Z', endedAt: NOW }),
        gateRuns: [
          run('uat', 'test (web)', 0, {
            runAt: NOW,
            startedAt: '2026-07-20T12:00:00.000Z',
            endedAt: '2026-07-20T12:00:10.000Z',
          }),
          run('uat', 'e2e (web)', 0, {
            runAt: NOW,
            startedAt: '2026-07-20T12:00:05.000Z',
            endedAt: '2026-07-20T12:00:40.000Z',
          }),
        ],
      }),
    );
    // Earliest start → latest end: 12:00:00 → 12:00:40.
    expect(views[0]!.duration).toBe('40.0s');
  });

  it('leads the gates aggregate with the verdict count over the batch size', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'failed'),
        gateRuns: [
          run('uat', 'test (web)', 0, { runAt: NOW }),
          run('uat', 'e2e (web)', 0, { runAt: NOW }),
          run('uat', 'lint (web)', 2, { runAt: NOW }),
        ],
      }),
    );
    expect(views[0]!.aggregate).toBe('3/3 · 2 passed · 1 failed');
  });

  it('counts a skipped gate in the batch total but not in the verdict count', () => {
    const views = uatProcesses(
      qualityInput({
        gateRuns: [
          run('uat', 'test (web)', 0, { runAt: NOW }),
          run('uat', 'lint (web)', null, { runAt: NOW, skipped: true }),
        ],
      }),
    );
    expect(views[0]!.aggregate).toBe('1/2 · 1 passed · 1 skipped');
  });

  it('omits the aggregate entirely when the batch recorded no row', () => {
    const views = uatProcesses(qualityInput({ cell: cell('uat', 'pending') }));
    expect(views[0]!.aggregate).toBeUndefined();
  });

  it('carries each gate row the repository it was recorded against', () => {
    const views = uatProcesses(
      qualityInput({
        gateRuns: [
          run('uat', 'test (web)', 0, { runAt: NOW, repo: '/web' }),
          run('uat', 'e2e (api)', 0, { runAt: NOW, repo: '/api' }),
        ],
      }),
    );
    expect(rowsOf(views[0]!).map((r) => r.repo)).toEqual(['/web', '/api']);
  });

  it('omits repo on a gate row recorded before the repo column existed', () => {
    const views = uatProcesses(
      qualityInput({
        gateRuns: [run('uat', 'test (web)', 0, { runAt: NOW, repo: null })],
      }),
    );
    const rows = rowsOf(views[0]!);
    expect(rows[0]!.repo).toBeUndefined();
  });

  it('states when the gates process started and its exact span', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'passed', { startedAt: '2026-07-20T12:00:00.000Z', endedAt: NOW }),
        gateRuns: [
          run('uat', 'test (web)', 0, {
            runAt: NOW,
            startedAt: '2026-07-20T12:00:00.000Z',
            endedAt: '2026-07-20T12:00:10.000Z',
          }),
          run('uat', 'e2e (web)', 0, {
            runAt: NOW,
            startedAt: '2026-07-20T12:00:05.000Z',
            endedAt: '2026-07-20T12:00:40.000Z',
          }),
        ],
      }),
    );
    const gates = views[0]!;
    expect(gates.duration).toBe('40.0s');
    expect(gates.durationExact).toBe('40.000s');
    expect(gates.time).toBe(formatTime('2026-07-20T12:00:00.000Z'));
  });

  it('counts gate outcomes and keeps skip and note distinct from pass and fail', () => {
    const views = uatProcesses(
      qualityInput({
        gateRuns: [
          run('uat', 'test (web)', 0, { runAt: NOW }),
          run('uat', 'e2e (web)', 3, { runAt: NOW }),
          run('uat', 'lint (web)', null, { runAt: NOW, skipped: true }),
          run('uat', 'typecheck (web)', null, { runAt: NOW }),
        ],
      }),
    );
    const gates = views[0]!;
    expect(gates.status).toBe('fail');
    const evidence = gates.evidence as { kind: 'gates'; rows: readonly EvidenceRow[]; passed: number; failed: number; skipped: number };
    expect(evidence.passed).toBe(1);
    expect(evidence.failed).toBe(1);
    expect(evidence.skipped).toBe(1);
    expect(evidence.rows.map((r) => r.status)).toEqual(['pass', 'fail', 'skip', 'note']);
  });

  it('shows only the latest gate batch by its stamp, not array position', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'passed', { startedAt: '2026-07-20T12:00:00.000Z', endedAt: NOW }),
        gateRuns: [
          run('uat', 'test (web)', 0, { runAt: NOW }),
          run('uat', 'test (web)', 1, { runAt: '2026-07-20T11:00:00.000Z' }),
        ],
      }),
    );
    const evidence = views[0]!.evidence as { kind: 'gates'; rows: readonly EvidenceRow[] };
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]!.status).toBe('pass');
  });

  it('bounds gate rows at 8 and names the remainder', () => {
    const gates = Array.from({ length: 10 }, (_, i) => run('uat', `test (${i})`, 0, { runAt: NOW }));
    const views = uatProcesses(qualityInput({ gateRuns: gates }));
    const evidence = views[0]!.evidence as { kind: 'gates'; rows: readonly EvidenceRow[]; passed: number };
    expect(evidence.rows).toHaveLength(9);
    expect(evidence.passed).toBe(10);
    expect(evidence.rows.at(-1)).toMatchObject({ status: 'note', label: 'more' });
    expect(evidence.rows.at(-1)!.detail).toContain('2');
  });

  it('renders advisory tester observations as note rows and never a fix', () => {
    const tester = processRun({ id: 5, status: 'passed', resultKind: 'observed' });
    const views = uatProcesses(
      qualityInput({
        processRuns: [tester],
        uatFindings: [uatFinding('high', { processRunId: 5, title: 'slow query' })],
      }),
    );
    const row = views.find((p) => p.id === 'tester')!;
    expect(row.status).toBe('pass');
    expect(rowsOf(row)).toMatchObject([{ status: 'note', label: 'high' }]);
    expect(rowsOf(row)[0]!.detail).toContain('slow query');
    expect(views.map((p) => p.id)).not.toContain('fix');
  });

  it('scopes observations to the LATEST tester run by invocation id', () => {
    const tester = processRun({ id: 9, status: 'passed', resultKind: 'observed' });
    const views = uatProcesses(
      qualityInput({
        processRuns: [processRun({ id: 1, status: 'passed', resultKind: 'observed' }), tester],
        uatFindings: [uatFinding('high', { processRunId: 1, title: 'from the older run' })],
      }),
    );
    expect(rowsOf(views.find((p) => p.id === 'tester')!)).toEqual([]);
  });

  it('reads a verifier failure as a failed tester process', () => {
    const views = uatProcesses(
      qualityInput({
        processRuns: [processRun({ status: 'passed', resultKind: 'verification-failed' })],
      }),
    );
    const tester = views.find((p) => p.id === 'tester')!;
    expect(tester.status).toBe('fail');
    expect(tester.detail).toContain('verifier failed');
  });

  it('reads an execution crash as failed and interrupts as note', () => {
    const crashed = uatProcesses(
      qualityInput({
        processRuns: [processRun({ status: 'failed', resultKind: 'execution-failed' })],
      }),
    ).find((p) => p.id === 'tester')!;
    expect(crashed.status).toBe('fail');
    expect(crashed.detail).toContain('execution failed');

    const interrupted = uatProcesses(
      qualityInput({
        processRuns: [processRun({ status: 'interrupted', resultKind: 'interrupted' })],
      }),
    ).find((p) => p.id === 'tester')!;
    expect(interrupted.status).toBe('note');
  });

  it('reads a stale tester run as note, never as pass or fail', () => {
    const views = uatProcesses(
      qualityInput({
        processRuns: [processRun({ status: 'stale', endedAt: null, resultKind: null })],
      }),
    );
    const tester = views.find((p) => p.id === 'tester')!;
    expect(tester.status).toBe('note');
    expect(tester.status).not.toBe('pass');
    expect(tester.status).not.toBe('fail');
  });

  it('shows the configured assignment only before anything ran; recorded identity wins after', () => {
    const configured = { provider: 'claude', model: 'opus' };
    const before = uatProcesses(
      qualityInput({
        cell: cell('uat', 'pending'),
        configured,
        processRuns: [],
      }),
    ).find((p) => p.id === 'tester')!;
    expect(before.status).toBe('pending');
    expect(before.configuredExecution).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(before.execution).toBeUndefined();

    const after = uatProcesses(
      qualityInput({
        configured,
        processRuns: [processRun({ id: 4, provider: 'codex', model: 'sol' })],
      }),
    ).find((p) => p.id === 'tester')!;
    expect(after.execution).toMatchObject({ provider: 'codex', model: 'sol' });
    expect(after.configuredExecution).toBeUndefined();
  });

  it('omits tokens unless measured, then renders the recorded view', () => {
    const bare = uatProcesses(qualityInput()).find((p) => p.id === 'tester')!;
    expect(bare.tokens).toBeUndefined();

    const measured = uatProcesses(
      qualityInput({ tokens: { total: 150, estimatedCalls: 0 } }),
    ).find((p) => p.id === 'tester')!;
    expect(measured.tokens).toEqual({ state: 'measured', total: '150', exact: '150' });
  });

  it('keeps services as pending config before the stage runs, naming the configured services after', () => {
    const before = uatProcesses(
      qualityInput({ cell: cell('uat', 'pending'), services: ['web', 'api'] }),
    ).find((p) => p.id === 'services')!;
    expect(before.status).toBe('pending');
    expect(before.detail).toBe('web · api');

    const after = uatProcesses(
      qualityInput({ services: ['web'] }),
    ).find((p) => p.id === 'services')!;
    expect(after.status).toBe('note');
    expect(after.detail).toBe('web');
  });

  it('reports the empty services list as not checked, never a manifest fact (B6)', () => {
    // The empty list is host-resolved (manifest × scope × runnable), so its
    // cause is not knowable here. The old "no service blocks in the manifest"
    // claimed a manifest fact the reducer never read — false for a project
    // whose karst.yml DOES declare services that merely fell outside the
    // ticket's scope. Absence is not a claim: it is "not checked".
    const views = uatProcesses(qualityInput({ services: [] }));
    const services = views.find((p) => p.id === 'services')!;
    expect(services.status).toBe('note');
    expect(services.detail).toContain('not checked');
    expect(services.detail).not.toContain('manifest');
  });

  it('names the configured services without claiming they ran (B6)', () => {
    // The names are host-known config; nothing here verifies they are up, so
    // the row stays `note` — a service list is context, never a pass.
    const views = uatProcesses(qualityInput({ services: ['api', 'web'] }));
    const services = views.find((p) => p.id === 'services')!;
    expect(services.status).toBe('note');
    expect(services.detail).toBe('api · web');
  });

  it('renders one fix row for an exhausted series, with every round in its evidence', () => {
    const views = uatProcesses(
      qualityInput({
        rounds: [
          round({ id: 1, round: 1, status: 'failed' }),
          round({ id: 2, round: 2, status: 'exhausted' }),
        ],
      }),
    );
    const fix = views.filter((p) => p.id === 'fix');
    expect(fix).toHaveLength(1);
    expect(rowsOf(fix[0]!).map((r) => r.label)).toEqual(['round 1', 'round 2']);
    expect(fix[0]!.status).toBe('fail');
    expect(fix[0]!.detail).toBe(
      'Recovery exhausted after 2 rounds. Resolve the remaining failure manually.',
    );
  });

  it('renders the round budget from the STORED max_rounds, never the live manifest', () => {
    const views = uatProcesses(
      qualityInput({ rounds: [round({ maxRounds: 3 })] }),
    );
    const fix = views.find((p) => p.id === 'fix')!;
    expect(rowsOf(fix)[0]!.detail).toBe('Fix started after UAT test failure · round 1 of 3');
  });

  it('renders a crash without a round as no fix and a failed process row', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'running'),
        processRuns: [processRun({ status: 'failed', resultKind: 'execution-failed' })],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'tester']);
    expect(views.find((p) => p.id === 'tester')!.status).toBe('fail');
  });

  it('has no tester execution to claim before the stage ran', () => {
    const tester = uatProcesses(qualityInput({ cell: cell('uat', 'pending') })).find(
      (p) => p.id === 'tester',
    )!;
    expect(tester.status).toBe('pending');
    expect(tester.execution).toBeUndefined();
  });
});

describe('reviewProcesses', () => {
  const reviewCell = {
    stageKey: 'review' as const,
    status: 'passed' as const,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:02:00.000Z',
  };

  it('emits gates, services, review in registry order when nothing triggered recovery', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        processRuns: [processRun({ stageKey: 'review', processId: 'review', status: 'passed', resultKind: 'validated' })],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'review']);
  });

  it('inserts the fix process after review for a findings-triggered round', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        rounds: [
          round({
            sourceStage: 'review',
            sourceProcessId: 'review',
            triggerKind: 'blocking-review-findings',
          }),
        ],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'services', 'review', 'fix']);
  });

  it('inserts the fix process after gates for a review gate-triggered round', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        rounds: [round({ sourceStage: 'review', sourceProcessId: 'gates' })],
      }),
    );
    expect(views.map((p) => p.id)).toEqual(['gates', 'fix', 'services', 'review']);
  });

  it('ships the blocking count as the review process-row aggregate (B4)', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: { ...reviewCell, status: 'failed' },
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'failed', resultKind: 'blocking' }),
        ],
        findings: [finding('critical', { runAt: NOW }), finding('high', { runAt: NOW }), finding('medium', { runAt: NOW })],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    // handoff §6 review: "Review · …       2 blocking" — the aggregate rides
    // the process row, host-computed (B4), never concatenated in the webview.
    expect(review.aggregate).toBe('2 blocking');
  });

  it('omits the review aggregate when nothing blocks (B4)', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'passed', resultKind: 'validated' }),
        ],
        findings: [finding('medium', { runAt: NOW })],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    expect(review.aggregate).toBeUndefined();
  });

  it('reads blocking findings as a failed review process naming the count', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: { ...reviewCell, status: 'failed' },
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'failed', resultKind: 'blocking' }),
        ],
        findings: [finding('critical', { runAt: NOW }), finding('high', { runAt: NOW })],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    expect(review.status).toBe('fail');
    expect(review.detail).toContain('2 blocking findings');
    const evidence = review.evidence as { kind: 'findings'; rows: readonly EvidenceRow[]; blocking: number };
    expect(evidence.blocking).toBe(2);
  });

  it('reads a validated review as passed, distinct from blocking', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'passed', resultKind: 'validated' }),
        ],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    expect(review.status).toBe('pass');
    expect(review.detail).toContain('no blocking findings');
  });

  it('reads an execution crash as failed with the cause named', () => {
    const views = reviewProcesses(
      qualityInput({
        cell: { ...reviewCell, status: 'failed' },
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'failed', resultKind: 'execution-failed' }),
        ],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    expect(review.status).toBe('fail');
    // handoff §11: an execution failure must never read as "no findings".
    expect(review.detail).toBe(
      'Review execution failed: the agent did not return a result. Retry review.',
    );
  });

  it('states a failed gate batch in the handoff §11 copy on the process row (B9)', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'failed'),
        gateRuns: [run('uat', 'test (web)', 1, { runAt: NOW })],
      }),
    );
    const gates = views[0]!;
    expect(gates.detail).toBe(
      'Tests failed: 1 gate returned a nonzero exit code. Review the log and resume the stage.',
    );
    // The failing ROW keeps its terse factual detail (handoff §6 row template).
    const rows = (gates.evidence as { rows: readonly EvidenceRow[] }).rows;
    expect(rows[0]!.detail).toBe('exit 1');
  });

  it('pluralizes the failed-gate sentence (B9)', () => {
    const views = uatProcesses(
      qualityInput({
        cell: cell('uat', 'failed'),
        gateRuns: [
          run('uat', 'test (web)', 1, { runAt: NOW }),
          run('uat', 'e2e (web)', 2, { runAt: NOW }),
        ],
      }),
    );
    expect(views[0]!.detail).toContain('2 gates returned');
  });

  it('states when a recorded run carries no execution identity (B9)', () => {
    const views = uatProcesses(
      qualityInput({
        processRuns: [
          processRun({ id: 9, status: 'passed', resultKind: 'observed', provider: null, model: null }),
        ],
      }),
    );
    const tester = views.find((p) => p.id === 'tester')!;
    expect(tester.identityNote).toBe('No historical execution identity recorded');
  });

  it('shows only the latest findings batch and bounds it at 6', () => {
    const stale = finding('high', { runAt: '2026-07-20T11:00:00.000Z', title: 'stale' });
    const fresh = Array.from({ length: 8 }, (_, i) =>
      finding('low', { runAt: NOW, title: `fresh ${i}` }),
    );
    const views = reviewProcesses(
      qualityInput({
        cell: reviewCell,
        processRuns: [
          processRun({ stageKey: 'review', processId: 'review', status: 'passed', resultKind: 'validated' }),
        ],
        findings: [stale, ...fresh],
      }),
    );
    const review = views.find((p) => p.id === 'review')!;
    const rows = rowsOf(review);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.detail).toContain('fresh 0');
    expect(rows.at(-1)).toMatchObject({ status: 'note', label: 'more' });
    expect(rows.at(-1)!.detail).toContain('2');
  });
});
