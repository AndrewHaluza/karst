import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { listStageRuns, openStageRun } from '../../store/stageRuns.js';
import { listGateRuns, recordGateRun } from '../../store/gateRuns.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { listUatFindings } from '../../store/uatFindings.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { manifest, uat as uatConfig } from '../../manifest/fixtures.js';
import type { Manifest } from '../../manifest/types.js';
import { resolveProcessAssignment } from '../../agent/processAssignment.js';
import { runUat, resolveTargetGates, type UatDeps } from './uat.js';
import { setDisabledGates } from '../../store/ticketGates.js';
import type { ScriptProbe } from '../gates/probe.js';
import type { ProcessOutcome } from '../gates/run.js';
import type { TesterGateRunner } from '../uat/testerVerifier.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import {
  listRecoveryRounds,
  recoveryDecision,
  completeFixExecution,
} from '../../store/recoveryRounds.js';

const now = () => '2026-07-30T10:00:00.000Z';

function deps(over: Partial<UatDeps> = {}): UatDeps {
  return {
    now,
    planTargets: async () => ({ kind: 'targets', targets: [{ repo: '/web', path: '/wt/web', names: ['web'] }], unmapped: [] }),
    probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } }),
    runGates: async (gates, _cwd, opts) => {
      // Mirrors the real `runGateList` contract: each result row fires
      // `onGateComplete` (with the row's timing and index) — the per-gate
      // evidence append the stage performs lives on that callback, so a fake
      // that skips it silently drops every gate row, just like a runner that
      // never reported.
      const results = gates.map((g, i) => {
        const startedAt = now();
        const endedAt = now();
        opts?.onGateComplete?.(g.name, 0, startedAt, endedAt, i);
        return { name: g.name, exitCode: 0, output: 'ok', startedAt, endedAt };
      });
      return { kind: 'ran', results };
    },
    ...over,
  };
}

function uatStage(store: Store, id: number) {
  return getTicket(store, id).stages.find((s) => s.stageKey === 'uat')!;
}

describe('runUat', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-uat-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('all gates green -> advances to review and records one row per gate', async () => {
    const res = await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    // Every row carries repository identity, or a failure names no place. With no
    // manifest the target is the bare cwd, so the label is the path.
    expect(listGateRuns(store, id).map((r) => r.gateName).sort()).toEqual([
      'e2e (/wt/web)',
      'test (/wt/web)',
    ]);
  });

  it('a failing gate -> routes to fix and files evidence under the attempt that ran', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({
            name: g.name,
            exitCode: g.name === 'e2e' ? 1 : 0,
            output: 'boom',
            startedAt: now(),
            endedAt: now(),
          })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(listGateRuns(store, id).every((r) => r.attempt === 0)).toBe(true);
    expect(uatStage(store, id).attempt).toBe(1);
  });

  it('commits a recovery round atomically with the failed verdict, snapshotting the causal evidence and cap', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({
            name: g.name,
            exitCode: g.name === 'e2e' ? 1 : 0,
            output: 'boom',
            startedAt: now(),
            endedAt: now(),
          })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    const rounds = listRecoveryRounds(store, id);
    expect(rounds).toHaveLength(1);
    // The round names the stage run the failure belongs to, the deterministic
    // gate source (no AI process run), the causal detail, and the DEFAULT cap.
    expect(rounds[0]).toMatchObject({
      ticketId: id,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'gates failed: e2e (/wt/web)',
      round: 1,
      maxRounds: 3,
      status: 'pending',
      fixProcessRunId: null,
    });
    expect(rounds[0]!.sourceStageRunId).toBe(listStageRuns(store, id)[0]!.id);
  });

  it('snapshots the manifest cap into the round — a later manifest edit cannot widen it', async () => {
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { uat: uatConfig({ maxFixAttempts: 1 }) }) },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now() })),
        }),
      }),
    );
    expect(listRecoveryRounds(store, id)[0]!.maxRounds).toBe(1);
    // The knob is raised AFTER the failure committed.
    const m = manifest({}, { uat: uatConfig({ maxFixAttempts: 5 }) });
    expect(recoveryDecision(store, id, 'uat')!.maxRounds).toBe(1);
    void m;
  });

  it('a revalidation pass completes the uat-origin round through the real runner', async () => {
    // Failure 1 commits round 1; the fix marker passes it to revalidating.
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now() })),
        }),
      }),
    );
    expect(completeFixExecution(store, id, now())).toBe(true);
    transition(store, id, 'fix', { kind: 'passed' }); // -> uat, the only legal edge

    const res = await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    const round = listRecoveryRounds(store, id)[0]!;
    expect(round.status).toBe('passed');
    expect(round.uatRevalidationStageRunId).toBe(listStageRuns(store, id)[1]!.id);
  });

  it('a revalidation failure fails round 1 and opens round 2 for the new cause', async () => {
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now() })),
        }),
      }),
    );
    completeFixExecution(store, id, now());
    transition(store, id, 'fix', { kind: 'passed' });

    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom again', startedAt: now(), endedAt: now() })),
        }),
      }),
    );
    const [round1, round2] = listRecoveryRounds(store, id);
    expect(round1).toMatchObject({ round: 1, status: 'failed' });
    expect(round1!.uatRevalidationStageRunId).toBe(listStageRuns(store, id)[1]!.id);
    expect(round2).toMatchObject({ round: 2, status: 'pending' });
  });

  it('nothing to run -> blocks, does not transition, consumes no attempt', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { build: 'tsc' } }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
    expect(stageBlock(store, id, 'uat')?.kind).toBe('nothing-to-run');
  });

  it('an unreadable repository -> blocks capability-missing', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'io-error', message: 'EACCES' }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
  });

  // `planTargets` (`planUatTargets`) can itself report `unavailable` — a git
  // probe failure means karst could not even determine which repositories are
  // affected, before any gate ever ran. This is a different seam than
  // `resolveTargetGates`'s `unavailable` above: that one fires per-target,
  // after targets are already known; this one fires before targets exist at
  // all, so it must be asserted at the `runUat` level and not inferred from
  // `planUatTargets`'s own propagation test in a different file.
  it('an unavailable target selection blocks with the propagated blocker and reason, before any gate runs', async () => {
    const reason = 'cannot determine review changes in /wt/web: baseline unavailable';
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({ kind: 'unavailable', blocker: 'capability-missing', reason }),
      }),
    );
    // The real observable outcome: the exact StageRunResult returned...
    expect(res).toEqual({ kind: 'blocked', blocker: 'capability-missing', reason });
    // ...the stage actually parked in the store, carrying the same blocker and
    // reason...
    expect(stageBlock(store, id, 'uat')).toEqual({
      kind: 'capability-missing',
      reason,
      at: now(),
    });
    // ...no verdict was written (still sitting at uat, never advanced)...
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    // ...and no attempt was consumed — a park is not a failed attempt.
    expect(uatStage(store, id).attempt).toBe(0);
    // Nothing ran before the park landed.
    expect(listGateRuns(store, id)).toEqual([]);
  });

  // An `unavailable` selection (karst could not even ask which repositories are
  // affected) and a genuine `{kind:'targets', targets: []}` (karst asked and the
  // answer is "nothing is affected") must stay distinguishable at this seam —
  // collapsing them is exactly the vacuous-green bug this task closes: an
  // environmental failure must never read as "nothing to test". The empty
  // list's own fate is a pass with a note (every worktree mapped, none
  // changed), asserted separately below.
  it('keeps an unavailable selection and a genuine empty target list apart', async () => {
    const unavailable = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'unavailable',
          blocker: 'capability-missing',
          reason: 'cannot determine review changes in /wt/web: baseline unavailable',
        }),
      }),
    );
    expect(unavailable).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });

    const id2 = createTicketFlow(store, { key: 'T-2', title: 't2' }).id;
    transition(store, id2, 'scope', { kind: 'passed' });
    transition(store, id2, 'impl', { kind: 'passed' });
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/web', '/wt/web', 'b', 'develop', 'inherited')",
      )
      .run(id2);
    const empty = await runUat(
      store,
      { ticketId: id2, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: [] }) }),
    );
    expect(empty).not.toMatchObject({ kind: 'blocked' });
    expect(empty).toMatchObject({ kind: 'advanced', next: 'review' });
    expect(empty).not.toMatchObject({ blocker: 'capability-missing' });
  });

  it('a stopped run yields no verdict and no attempt', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ runGates: async () => ({ kind: 'stopped', results: [] }) }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
  });

  it('writes the overlap warning into the artifact when nothing is independent', async () => {
    // The overlap check now compares against review's RECORDED batch (Task
    // 10), not a hard-coded gate list — `review.gates` is configurable since
    // Task 9, so only what review actually ran can prove the overlap. An
    // explicit `uat.gates: [lint]` is what makes UAT run the same identity a
    // prior review run recorded.
    recordGateRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-07-30T09:00:00.000Z',
      gates: [
        { gateName: 'lint (/wt/web)', exitCode: 0, repo: '/web', command: 'npm', args: ['run', 'lint'] },
      ],
    });
    await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { uat: uatConfig({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] }) }),
      },
      deps({
        probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }),
      }),
    );
    const path = uatStage(store, id).artifactPath!;
    expect(readFileSync(path, 'utf8')).toContain('asked no question review does not');
  });

  // A prior review run against a DIFFERENT command is not the same question —
  // proves the comparison is genuinely reading the recorded identity, not just
  // "review ran at all for this ticket".
  it('does not warn when the recorded review batch asked a different question', async () => {
    recordGateRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-07-30T09:00:00.000Z',
      gates: [
        { gateName: 'build (/wt/web)', exitCode: 0, repo: '/web', command: 'npm', args: ['run', 'build'] },
      ],
    });
    await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { uat: uatConfig({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] }) }),
      },
      deps({
        probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }),
      }),
    );
    const path = uatStage(store, id).artifactPath!;
    expect(readFileSync(path, 'utf8')).not.toContain('asked no question review does not');
  });

  it('clears a previous block when a fresh run reaches a verdict', async () => {
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { build: 'tsc' } }) }),
    );
    expect(stageBlock(store, id, 'uat')).not.toBeNull();
    await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(stageBlock(store, id, 'uat')).toBeNull();
  });

  // `planTargets` is consulted ONLY when a manifest is supplied — without one
  // there is nothing to resolve repository names against, so runUat falls back to
  // the single cwd. Passing a manifest here is what puts the planner in the path.
  it('runs every target and aggregates only after all of them complete', async () => {
    const ran: string[] = [];
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        unmapped: [],
        }),
        runGates: async (gates, cwd) => {
          ran.push(cwd);
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(ran.sort()).toEqual(['/wt/api', '/wt/web']);
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  // A malformed package.json is a repository defect an agent CAN fix, so it must
  // reach a verdict rather than park — `resolveGates` returns zero gates for it
  // and only the stage can turn that into a named failure.
  it('a malformed package.json -> a failing verdict naming the file, not a block', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'malformed', message: 'Unexpected token }' }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(stageBlock(store, id, 'uat')).toBeNull();
    const rows = listGateRuns(store, id);
    expect(rows.map((r) => r.gateName)).toEqual(['package.json (/wt/web)']);
    expect(rows[0]!.exitCode).toBe(1);
    expect(readFileSync(uatStage(store, id).artifactPath!, 'utf8')).toContain('Unexpected token }');
  });

  // `gate_runs` is the only append-only evidence table. A Stop that discarded the
  // gates that already finished would make work that really happened unrecoverable.
  it('persists the gates that finished before a Stop landed', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (_gates, _cwd, opts) => {
          // The one gate completed before the stop landed — real
          // `runGateList` fires the callback for it, and the row must
          // survive the stop.
          opts?.onGateComplete?.('test', 0, now(), now(), 0);
          return {
            kind: 'stopped',
            results: [{ name: 'test', exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() }],
          };
        },
      }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    const rows = listGateRuns(store, id);
    expect(rows.map((r) => r.gateName)).toEqual(['test (/wt/web)']);
    expect(rows[0]!.attempt).toBe(0);
    expect(uatStage(store, id).attempt).toBe(0);
    expect(readFileSync(uatStage(store, id).artifactPath!, 'utf8')).toContain('ok');
  });

  it('keeps the evidence of completed targets when a later one cannot be asked', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        unmapped: [],
        }),
        probe: (cwd) =>
          cwd === '/wt/web'
            ? { kind: 'ok', scripts: { test: 'vitest' } }
            : { kind: 'io-error', message: 'EACCES' },
      }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    expect(listGateRuns(store, id).map((r) => r.gateName)).toEqual(['test (web)']);
    expect(listGateRuns(store, id)[0]!.attempt).toBe(0);
  });

  it('records the gate rows of a run that resolved to a block', async () => {
    // Every gate reported null: karst asked, and nothing answered. That is a park,
    // and the rows proving each gate said nothing must survive it.
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates, _cwd, opts) => {
          const results = gates.map((g, i) => {
            opts?.onGateComplete?.(g.name, null, null, null, i);
            return { name: g.name, exitCode: null, output: 'nothing to run' };
          });
          return { kind: 'ran', results };
        },
      }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(listGateRuns(store, id).map((r) => r.gateName).sort()).toEqual([
      'e2e (/wt/web)',
      'test (/wt/web)',
    ]);
    expect(listGateRuns(store, id).every((r) => r.exitCode === null)).toBe(true);
    expect(uatStage(store, id).artifactPath).not.toBeNull();
  });

  // A worktree whose repoPath is absent from the manifest cannot be asked
  // anything, and a retry cannot change that — the block names the worktrees
  // and the user must edit karst.yml or re-scope the ticket. Distinct from the
  // mapped-but-unchanged case below: that one PASSES.
  it('blocks and names the unmapped worktrees when a repository is missing from the manifest', async () => {
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/unmapped', '/wt/unmapped', 'b', 'develop', 'inherited')",
      )
      .run(id);
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: ['/unmapped'] }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'unmapped-repository' });
    expect(res).toMatchObject({ reason: expect.stringContaining('/unmapped') });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
  });

  it('passes with a note when every repository mapped and none has changes', async () => {
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/web', '/wt/web', 'b', 'develop', 'inherited')",
      )
      .run(id);
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: [] }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(stageBlock(store, id, 'uat')).toBeNull();
    expect(readFileSync(uatStage(store, id).artifactPath!, 'utf8')).toContain(
      'no repository has changes from its base, so UAT had nothing to check',
    );
  });

  // Zero worktrees is a third case, and it is neither of the two above: the
  // question was never asked of any repository, so it can only park.
  it('parks when the ticket has no registered worktree at all', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: [] }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(res).toMatchObject({
      reason: 'no worktree is registered for this ticket, so there is no repository to run UAT against',
    });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
    expect(stageBlock(store, id, 'uat')?.kind).toBe('nothing-to-run');
  });

  // Two `repositories:` entries sharing a repoPath collapse to ONE target, so a
  // per-repository override on the second entry has no other chance to be honoured.
  it('honours the gate override of every manifest entry sharing one worktree', async () => {
    const ran: string[] = [];
    await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/mono',
        artifactDir,
        manifest: manifest(
          {},
          {
            uat: uatConfig({
              repositories: {
                web: { gates: [{ name: 'e2e-web', kind: 'command', command: 'npx', args: ['pw', 'web'] }] },
                admin: { gates: [{ name: 'e2e-admin', kind: 'command', command: 'npx', args: ['pw', 'admin'] }] },
              },
            }),
          },
        ),
      },
      deps({
        planTargets: async () => ({ kind: 'targets', targets: [{ repo: '/mono', path: '/wt/mono', names: ['web', 'admin'] }], unmapped: [] }),
        runGates: async (gates) => {
          ran.push(...gates.map((g) => g.name));
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(ran.sort()).toEqual(['e2e-admin', 'e2e-web']);
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  it('asks one shared worktree the same question once, however many entries declare it', async () => {
    const ran: string[] = [];
    await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/mono',
        artifactDir,
        manifest: manifest(
          {},
          {
            uat: uatConfig({
              repositories: {
                web: { gates: [{ name: 'e2e', kind: 'script', script: 'e2e' }] },
                admin: { gates: [{ name: 'e2e', kind: 'script', script: 'e2e' }] },
              },
            }),
          },
        ),
      },
      deps({
        planTargets: async () => ({ kind: 'targets', targets: [{ repo: '/mono', path: '/wt/mono', names: ['web', 'admin'] }], unmapped: [] }),
        runGates: async (gates) => {
          ran.push(...gates.map((g) => g.name));
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(ran).toEqual(['e2e']);
  });

  // Two entries in one worktree may declare the same gate NAME for different
  // commands, so a result must be attributed by position. Matching by name gives
  // both rows the first gate's identity, and the independent one disappears into
  // review's set — a spurious "asked no question review does not" warning.
  it('attributes each result to the gate that produced it, not to the first of that name', async () => {
    await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/mono',
        artifactDir,
        manifest: manifest(
          {},
          {
            uat: uatConfig({
              repositories: {
                web: { gates: [{ name: 'g', kind: 'script', script: 'test' }] },
                admin: { gates: [{ name: 'g', kind: 'command', command: 'npx', args: ['pw'] }] },
              },
            }),
          },
        ),
      },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [{ repo: '/mono', path: '/wt/mono', names: ['web', 'admin'] }],
        unmapped: [],
        }),
      }),
    );
    // `npm test` duplicates review; `npx pw` does not, so the run asked something new.
    expect(readFileSync(uatStage(store, id).artifactPath!, 'utf8')).not.toContain(
      'asked no question review does not',
    );
  });

  it('threads one abort signal into every gate invocation, so Stop reaches a running gate', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, signal: controller.signal, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        unmapped: [],
        }),
        runGates: async (gates, _cwd, opts) => {
          seen.push(opts?.signal);
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it('tells the gate runner which scripts the repository actually defines', async () => {
    let available: ((script: string) => boolean) | undefined;
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } }),
        runGates: async (gates, _cwd, opts) => {
          available = opts?.scriptsAvailable;
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(available?.('test')).toBe(true);
    expect(available?.('lint')).toBe(false);
  });

  it('keeps the gate rows of a run whose transition throws', async () => {
    // Evidence is written as each gate FINISHES, not when the run ends, so a
    // run destroyed after its gates ran — by a throw here, by process death in
    // production — leaves exactly what it learned readable. Discarding it was
    // the defect: an extension-host restart fires no abort signal, so the
    // `stopped` path never runs and every result was silently thrown away.
    store.db.prepare('DELETE FROM stages WHERE ticket_id = ? AND stage_key = ?').run(id, 'uat');
    await expect(
      runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps()),
    ).rejects.toThrow(/has no stage 'uat'/);
    expect(listGateRuns(store, id).map((r) => r.gateName)).toEqual([
      'test (/wt/web)',
      'e2e (/wt/web)',
    ]);
    // The verdict itself never committed, so the run is still open — which is
    // what the next run (or the activation sweep) reads as a destroyed run.
    expect(listStageRuns(store, id).map((r) => r.status)).toEqual(['running']);
    // An execution crash opens NO recovery round: only a COMMITTED failed
    // verdict may trigger recovery, and none committed here.
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });

  // The durability property at its finest grain: the row is written when the
  // GATE finishes, inside the runner's loop — never batched to the end of the
  // target. A runner that dies mid-list (a throw here, process death in
  // production) leaves every gate that already finished readable.
  it('persists each gate the moment it finishes, before the target list completes', async () => {
    await expect(
      runUat(
        store,
        { ticketId: id, cwd: '/wt/web', artifactDir },
        deps({
          runGates: async (gates, _cwd, opts) => {
            // Gate 1 finishes; its row lands inside the loop...
            opts?.onGateComplete?.(gates[0]!.name, 0, now(), now(), 0);
            // ...then the host dies before gate 2 even starts.
            throw new Error('host died mid-list');
          },
        }),
      ),
    ).rejects.toThrow('host died mid-list');
    const rows = listGateRuns(store, id);
    expect(rows.map((r) => r.gateName)).toEqual(['test (/wt/web)']);
    expect(rows[0]!.exitCode).toBe(0);
    // The run itself is still open — the next run (or the activation sweep)
    // reads it as destroyed, never as never-started or in flight.
    expect(listStageRuns(store, id).map((r) => r.status)).toEqual(['running']);
  });

  it('does not run a gate the ticket disabled', async () => {
    setDisabledGates(store, id, 'uat', ['e2e']);
    const invoked: string[] = [];
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => {
          invoked.push(...gates.map((g) => g.name));
          return {
            kind: 'ran',
            results: gates.map((g) => ({
              name: g.name,
              exitCode: 0,
              output: '',
              startedAt: now(),
              endedAt: now(),
            })),
          };
        },
      }),
    );
    expect(invoked).toEqual(['test']);
  });

  it('records the disabled gate as a skipped row beside the gates that ran', async () => {
    setDisabledGates(store, id, 'uat', ['e2e']);
    await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    const rows = listGateRuns(store, id);
    const skipped = rows.filter((r) => r.skipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.gateName).toContain('e2e');
    expect(skipped[0]!.exitCode).toBeNull();
    expect(skipped[0]!.startedAt).toBeNull();
    expect(skipped[0]!.endedAt).toBeNull();
    expect(rows.filter((r) => !r.skipped).map((r) => r.exitCode)).toEqual([0]);
  });

  it('a disabled gate never fails the stage', async () => {
    setDisabledGates(store, id, 'uat', ['e2e']);
    const result = await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(result).toEqual({ kind: 'advanced', next: 'review' });
  });

  it('advances when every uat gate is disabled — the user chose to skip all checks', async () => {
    setDisabledGates(store, id, 'uat', ['test', 'e2e']);
    const result = await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(result).toEqual({ kind: 'advanced', next: 'review' });
  });

  // v25: the run existing at all, and what it ended as, is what resolves
  // "zero gate_runs on a running stage" from three-way ambiguous to a fact —
  // never started / in flight / destroyed. A pass must close it truthfully.
  it('opens a stage run before the first gate and closes it finished/advanced on a pass', async () => {
    const res = await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    const runs = listStageRuns(store, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stageKey: 'uat', status: 'finished', outcome: 'advanced' });
    expect(runs[0]!.endedAt).not.toBeNull();
  });

  it('closes the run blocked when the stage parks', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { build: 'tsc' } }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked' });
    expect(listStageRuns(store, id)).toMatchObject([{ status: 'finished', outcome: 'blocked' }]);
  });

  it('closes the run stopped when a Stop lands mid-flight', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ runGates: async () => ({ kind: 'stopped', results: [] }) }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    expect(listStageRuns(store, id)).toMatchObject([{ status: 'finished', outcome: 'stopped' }]);
  });

  // Load-bearing: a reader (the activation sweep, another window's `karst
  // context`) polling WHILE the gate is still executing must already see the
  // open run and the skipped-gate row — not just whatever survives to the end.
  // Discarding evidence until the run's very last line is the exact bug this
  // whole design replaces.
  it('makes the run and its skipped-gate row readable mid-run, before the gate that answers finishes', async () => {
    setDisabledGates(store, id, 'uat', ['e2e']);
    let midRunGateNames: string[] | undefined;
    let midRunStatuses: string[] | undefined;
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => {
          midRunGateNames = listGateRuns(store, id).map((r) => r.gateName);
          midRunStatuses = listStageRuns(store, id).map((r) => r.status);
          return {
            kind: 'ran',
            results: gates.map((g) => ({
              name: g.name,
              exitCode: 0,
              output: '',
              startedAt: now(),
              endedAt: now(),
            })),
          };
        },
      }),
    );
    expect(midRunStatuses).toEqual(['running']);
    expect(midRunGateNames).toEqual(['e2e (/wt/web)']);
  });

  it("stamps every gate row it writes with the run's own id", async () => {
    await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    const run = listStageRuns(store, id)[0]!;
    expect(listGateRuns(store, id).length).toBeGreaterThan(0);
    expect(listGateRuns(store, id).every((r) => r.stageRunId === run.id)).toBe(true);
  });

  // A run still `running` when a second one opens is exactly the destroyed-run
  // case a host restart produces: the driver single-flights, so a second open
  // run for the same ticket+stage can only mean the first one's process died.
  it('marks a still-open run stale the moment a fresh run of the same stage opens', async () => {
    openStageRun(store, {
      ticketId: id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-07-30T09:00:00.000Z',
      startedAt: '2026-07-30T09:00:00.000Z',
    });
    await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(listStageRuns(store, id).map((r) => r.status)).toEqual(['stale', 'finished']);
  });

  it('calls onGateComplete after each gate finishes, passing gate names through', async () => {
    const completed: string[] = [];
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, onGateComplete: (name) => completed.push(name) },
      deps({
        runGates: async (gates, _cwd, opts) => {
          // Simulate each gate completing and invoke the callback.
          for (const [i, g] of gates.entries()) {
            opts?.onGateComplete?.(g.name, 0, now(), now(), i);
          }
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    // Two gates (test, e2e) for the single 'web' target.
    expect(completed).toEqual(['test', 'e2e']);
  });
});

describe('resolveTargetGates', () => {
  const okProbe = (scripts: Record<string, string>): ScriptProbe => ({ kind: 'ok', scripts });

  it('drops a disabled gate from the resolved list and reports it as skipped', () => {
    const probe = okProbe({ test: 'vitest', e2e: 'playwright' });
    const res = resolveTargetGates(probe, undefined, ['web'], ['e2e']);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.gates.map((g) => g.name)).toEqual(['test']);
    expect(res.skipped.map((g) => g.name)).toEqual(['e2e']);
  });

  it('reports an empty skipped list when nothing is disabled', () => {
    const probe = okProbe({ test: 'vitest' });
    const res = resolveTargetGates(probe, undefined, ['web']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.skipped).toEqual([]);
  });

  it('resolves to zero gates, all skipped, when every gate is disabled', () => {
    const probe = okProbe({ test: 'vitest' });
    const res = resolveTargetGates(probe, undefined, ['web'], ['test']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.gates).toEqual([]);
    expect(res.skipped.map((g) => g.name)).toEqual(['test']);
  });

  it('leaves an unavailable resolution untouched — a disable cannot make an unreadable repo readable', () => {
    const ioProbe: ScriptProbe = { kind: 'io-error', message: 'EACCES' };
    const res = resolveTargetGates(ioProbe, undefined, ['web'], ['test']);
    expect(res.kind).toBe('unavailable');
  });

  it('deduplicates skipped gates by name across repository entries sharing a worktree', () => {
    const probe = okProbe({ test: 'vitest' });
    const res = resolveTargetGates(probe, undefined, ['web', 'admin'], ['test']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.skipped.map((g) => g.name)).toEqual(['test']);
  });
});

/**
 * The UAT Tester process + optional deterministic verifier (Task 8). Gates
 * keep deterministic exit-code semantics; the AI Tester runs ONLY after the
 * required gates pass and records advisory observations; the configured
 * `uat.testerVerifier` is the sole Tester-specific verdict, and its completed
 * nonzero exit is the only Tester shape that may open a recovery round.
 */
describe('runUat — Tester and verifier (Task 8)', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  function testerAgent(raw: string): AgentAdapter {
    return {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used by the tester');
      },
      runHeadless: async () => ({ sessionId: '', verdict: null, raw }),
    };
  }

  const verifierRun = (outcome: ProcessOutcome) =>
    (async () => outcome) as TesterGateRunner;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-uat-tester-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  const testerDeps = (over: Partial<UatDeps> = {}): UatDeps =>
    deps({
      tester: {
        assignment: { agentName: 'UAT Agent', provider: 'claude' },
        adapter: testerAgent('[]'),
      },
      ...over,
    });

  it('runs the Tester after the gates pass; its findings stay advisory and never spend a round', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      testerDeps({
        tester: {
          assignment: { agentName: 'UAT Agent', provider: 'claude' },
          adapter: testerAgent(
            JSON.stringify([{ severity: 'critical', title: 'data loss', detail: '' }]),
          ),
        },
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    // The blocking-severity observation is EVIDENCE, never a verdict: UAT
    // passed on its gates, and no recovery round opened for it.
    expect(listUatFindings(store, id)).toHaveLength(1);
    expect(listUatFindings(store, id)[0]!.severity).toBe('critical');
    expect(listRecoveryRounds(store, id)).toEqual([]);
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(listProcessRuns(store, id)[0]).toMatchObject({ processId: 'tester', resultKind: 'observed' });
  });

  it('does not reuse review AI-result reduction as authority: no blocking-review-findings round ever opens from uat', async () => {
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      testerDeps({
        tester: {
          assignment: { agentName: 'UAT Agent', provider: 'claude' },
          adapter: testerAgent(
            JSON.stringify([{ severity: 'critical', title: 'data loss', detail: '' }]),
          ),
        },
      }),
    );
    expect(listRecoveryRounds(store, id)).toEqual([]);
    // The Tester's observations are recorded under the UAT process, never
    // funneled through review's findings lane.
    expect(listUatFindings(store, id)).toHaveLength(1);
  });

  it('does not run the Tester when the gates failed — no AI spend on a failed run', async () => {
    const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      testerDeps({
        tester: { assignment: { provider: 'claude' }, adapter: { ...testerAgent('[]'), runHeadless } },
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now() })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(runHeadless).not.toHaveBeenCalled();
    expect(listProcessRuns(store, id)).toEqual([]);
  });

  // Finding 2: a disabled `processes.uatTester` resolves to NULL — configured
  // absence. The stage then has no Tester at all: no adapter call, no process
  // run, and UAT's ordinary deterministic gates decide alone (a real pass,
  // never a fabricated one).
  it('a disabled Tester assignment reads as configured absence — no AI call, no process run, gates decide alone', async () => {
    const disabled: Manifest = { ...manifest({}), processes: { uatTester: { enabled: false } } };
    const assignment = resolveProcessAssignment(disabled, 'uat-tester');
    expect(assignment).toBeNull();
    // The disabled resolution injects ABSENCE — exactly what the host seam
    // collapses a null resolution into: no process bundle reaches the stage.
    const tester = assignment === null ? undefined : { assignment, adapter: testerAgent('[]') };
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ tester }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(listProcessRuns(store, id)).toEqual([]);
    expect(listUatFindings(store, id)).toEqual([]);
    expect(listGateRuns(store, id).length).toBeGreaterThan(0);
  });

  it('a Stop during the Tester stops the whole run without a verdict', async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, signal: controller.signal },
      testerDeps(),
    );
    expect(res).toEqual({ kind: 'stopped' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });

  it('a verifier exit 0 completes the Tester and the run passes on its gates', async () => {
    const res = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { uat: uatConfig({ testerVerifier: { name: 'verify', kind: 'command', command: 'verify.sh' } }) }),
      },
      testerDeps({ runVerifier: verifierRun({ kind: 'completed', exitCode: 0, output: '' }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(listRecoveryRounds(store, id)).toEqual([]);
    expect(listProcessRuns(store, id)[0]).toMatchObject({ resultKind: 'observed', status: 'passed' });
  });

  it('a completed nonzero verifier exit fails UAT and opens a Tester-attributed recovery round', async () => {
    const res = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { uat: uatConfig({ testerVerifier: { name: 'verify', kind: 'command', command: 'verify.sh' } }) }),
      },
      testerDeps({ runVerifier: verifierRun({ kind: 'completed', exitCode: 1, output: 'nope' }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    // The deterministic failure is attributed to the Tester PROCESS, carrying
    // its process run id — never to a gate that did not fail.
    const rounds = listRecoveryRounds(store, id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      sourceStage: 'uat',
      sourceProcessId: 'tester',
      triggerKind: 'tester-verifier-failure',
      triggerDetail: 'uat tester verifier failed: exit code 1',
      round: 1,
      maxRounds: 3,
      status: 'pending',
    });
    expect(rounds[0]!.sourceProcessRunId).toBe(listProcessRuns(store, id)[0]!.id);
    // The Tester run records the disproven observation.
    expect(listProcessRuns(store, id)[0]).toMatchObject({ resultKind: 'verification-failed' });
    // The deterministic failure is the stage's verdict, named on the stage row.
    expect(uatStage(store, id).verdict).toContain('uat tester verifier failed: exit code 1');
  });

  it('verifier execution failure parks without a verdict, an attempt, or a recovery round', async () => {
    const res = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { uat: uatConfig({ testerVerifier: { name: 'verify', kind: 'command', command: 'verify.sh' } }) }),
      },
      testerDeps({ runVerifier: verifierRun({ kind: 'spawnFailed', message: 'ENOENT', output: '' }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    if (res.kind !== 'blocked') throw new Error('unreachable');
    // The park names the verifier gate AND the reason it could not run.
    expect(res.reason).toContain('verify');
    expect(res.reason).toContain('ENOENT');
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage(store, id).attempt).toBe(0);
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });

  it('verifier interruption stops the run, never a verdict', async () => {
    const res = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { uat: uatConfig({ testerVerifier: { name: 'verify', kind: 'command', command: 'verify.sh' } }) }),
      },
      testerDeps({ runVerifier: verifierRun({ kind: 'aborted', output: '' }) }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });

  it('parks when a verifier is configured but no host gate runner is wired', async () => {
    const res = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { uat: uatConfig({ testerVerifier: { name: 'verify', kind: 'command', command: 'verify.sh' } }) }),
      },
      testerDeps(),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });

  it('threads the stage debug callback into the Tester and the verifier, so their lines land in the same stream', async () => {
    const lines: string[] = [];
    const res = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        debug: (m) => lines.push(m),
        manifest: manifest({}, { uat: uatConfig({ testerVerifier: { name: 'verify', kind: 'command', command: 'verify.sh' } }) }),
      },
      testerDeps({ runVerifier: verifierRun({ kind: 'completed', exitCode: 0, output: '' }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    // The Tester's own decision points reached the stage's debug stream…
    expect(lines.some((l) => l.includes('uat tester ticket') && l.includes('asking target /web'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('recorded 0 finding(s)'))).toBe(true);
    // …and so did the verifier's.
    expect(lines.some((l) => l.includes('uat tester verifier') && l.includes('passed (exit 0)'))).toBe(
      true,
    );
  });

  it('threads the opened Tester process id into token attribution at the stage seam', async () => {
    const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    const seen: (unknown)[] = [];
    const spied = async (headlessOpts: { tracking?: unknown }) => {
      seen.push(headlessOpts.tracking);
      return { sessionId: '', verdict: null, raw: '[]' };
    };
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      testerDeps({
        tester: { assignment: { provider: 'claude' }, adapter: { ...testerAgent('[]'), runHeadless: spied } },
      }),
    );
    const run = listProcessRuns(store, id)[0]!;
    expect(seen).toEqual([{ callSite: 'uat-tester', ticketId: id, processRunId: run.id }]);
  });

  it('threads onTesterOutput and onTesterTargetProgress into the Tester', async () => {
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    const progress: { repo: string; status: string; detail?: string }[] = [];
    const captured: Array<{ onOutput?: (c: { stream: 'stdout' | 'stderr'; text: string }) => void }> = [];
    const adapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used by the tester');
      },
      runHeadless: async (headlessOpts) => {
        captured.push(headlessOpts);
        return { sessionId: '', verdict: null, raw: '[]' };
      },
    };
    const res = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        onTesterOutput: (c) => chunks.push(c),
        onTesterTargetProgress: (e) => progress.push(e),
      },
      testerDeps({ tester: { assignment: { provider: 'claude' }, adapter } }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    // The Tester received the live-output hook on the call it made.
    expect(captured[0]!.onOutput).toBeDefined();
    captured[0]!.onOutput?.({ stream: 'stderr', text: 'thinking' });
    expect(chunks).toEqual([{ stream: 'stderr', text: 'thinking' }]);
    // The Tester emitted per-target progress, and the stage passed it through.
    expect(progress).toEqual([
      { repo: '/wt/web', status: 'active' },
      { repo: '/wt/web', status: 'completed', detail: '0 observations' },
    ]);
  });

  // Finding 13 follow-up: the execution-wide cap must never skip a repository.
  // Repo A fills the budget with 100 lows; repo B's later `critical` still gets
  // its adapter call and survives the single severity-ranked slice.
  it('asks EVERY repository Tester before capping: a later critical survives a full cap of lows', async () => {
    const adapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used by the tester');
      },
      runHeadless: async (headlessOpts) => ({
        sessionId: '',
        verdict: null,
        raw:
          headlessOpts.cwd === '/wt/web'
            ? JSON.stringify(
                Array.from({ length: 100 }, (_, i) => ({ severity: 'low' as const, title: `low${i}`, detail: '' })),
              )
            : JSON.stringify([{ severity: 'critical' as const, title: 'data loss', detail: '' }]),
      }),
    };
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      testerDeps({
        tester: { assignment: { agentName: 'UAT Agent', provider: 'claude' }, adapter },
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        unmapped: [],
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    const rows = listUatFindings(store, id);
    expect(rows).toHaveLength(100);
    expect(rows[0]).toMatchObject({ severity: 'critical', repo: '/api' });
  });
});
