import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { listGateRuns, recordGateRun } from '../../store/gateRuns.js';
import { listFindings } from '../../store/reviewFindings.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { latestStageRun, listStageRuns } from '../../store/stageRuns.js';
import { openGateRun } from '../gates/evidence.js';
import { commitGateOutcome } from '../gates/commit.js';
import { listRecoveryRounds } from '../../store/recoveryRounds.js';
import { manifest, uat as uatConfig, review as reviewConfig } from '../../manifest/fixtures.js';
import type { Manifest } from '../../manifest/types.js';
import { resolveProcessAssignment } from '../../agent/processAssignment.js';
import { runReview, type OpenDiff, type ReviewDeps } from './review.js';
import { runUat, type UatDeps } from './uat.js';
import { setDisabledGates } from '../../store/ticketGates.js';

const now = (): string => '2026-08-01T10:00:00.000Z';

/** A repository that answers every review gate. */
const ALL_SCRIPTS = {
  lint: 'eslint .',
  typecheck: 'tsc --noEmit',
  build: 'tsc -b',
  'format:check': 'prettier --check .',
};

/**
 * The findings lane defaults to ON (constraints.md), so a review that reaches
 * gate-clean would otherwise call the findings agent — and every test in this
 * file except the ones specifically about the lane wants that call to be a
 * silent, clean no-op, exactly as if nothing was found. `findingsAgent()`
 * below builds a fake `AgentAdapter` for tests that DO want to control what
 * comes back.
 */
function findingsAgent(raw = '[]'): AgentAdapter {
  return {
    requiredBinary: 'fake',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => {
      throw new Error('not used by the findings lane');
    },
    runHeadless: async () => ({ sessionId: '', verdict: null, raw }),
  };
}

function deps(over: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    now,
    planTargets: async () => ({
      kind: 'targets',
      targets: [{ repo: '/web', path: '/wt/web', names: ['web'] }],
    unmapped: [],
    }),
    probe: () => ({ kind: 'ok', scripts: ALL_SCRIPTS }),
    checkDeps: async () => ({ ok: true }),
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
    findingsAdapter: findingsAgent(),
    ...over,
  };
}

function reviewStage(store: Store, id: number) {
  return getTicket(store, id).stages.find((s) => s.stageKey === 'review')!;
}

function walkToReview(store: Store, id: number): void {
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
  transition(store, id, 'uat', { kind: 'passed' });
}

describe('runReview', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;
  let openDiff: Mock<OpenDiff>;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    walkToReview(store, id);
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-review-'));
    openDiff = vi.fn<OpenDiff>();
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('every gate green -> advances to ship and records one row per gate', async () => {
    const res = await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(getTicket(store, id).stageCurrent).toBe('ship');
    // No manifest supplied, so the target is the bare cwd and the label is the
    // path — every row still names a place.
    expect(listGateRuns(store, id).map((r) => r.gateName)).toEqual([
      'lint (/wt/web)',
      'typecheck (/wt/web)',
      'build (/wt/web)',
      'format:check (/wt/web)',
    ]);
    expect(listGateRuns(store, id).every((r) => r.stageKey === 'review')).toBe(true);
    expect(new Set(listGateRuns(store, id).map((r) => r.runAt)).size).toBe(1);
  });

  it('parks without a verdict when installed deps drifted from the lockfile', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        checkDeps: async () => ({
          ok: false,
          kind: 'dependency-drift',
          reason: 'missing: @arcus-team/web-contract@0.5.0',
        }),
      }),
    );
    expect(res).toEqual({
      kind: 'blocked',
      blocker: 'capability-missing',
      reason: expect.stringContaining("npm install"),
    });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(listGateRuns(store, id)).toEqual([]);
  });

  it('threads the stage debug callback into the findings lane, so the reviewer’s decision points land in the stream', async () => {
    const lines: string[] = [];
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, debug: (m) => lines.push(m) },
      deps(),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    // The lane ran (findings default to enabled) and its per-target and exit
    // decision points reached the stage's debug stream.
    expect(lines.some((l) => l.includes('review findings ticket') && l.includes('asking target /wt/web'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('ran with 0 finding(s)'))).toBe(true);
    // The lane's own stream never carries the prompt it sent.
    for (const line of lines) {
      expect(line).not.toContain('Report findings about the DIFF ONLY');
    }
  });

  it('threads onFindingsOutput and onFindingsTargetProgress into the findings lane', async () => {
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    const progress: { repo: string; status: string; detail?: string }[] = [];
    const captured: Array<{ onOutput?: (c: { stream: 'stdout' | 'stderr'; text: string }) => void }> = [];
    const agent: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used by the findings lane');
      },
      runHeadless: async (opts) => {
        captured.push(opts);
        return { sessionId: '', verdict: null, raw: '[]' };
      },
    };
    const res = await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        onFindingsOutput: (c) => chunks.push(c),
        onFindingsTargetProgress: (e) => progress.push(e),
      },
      deps({ findingsAdapter: agent }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    // The lane received the live-output hook on the call it made.
    expect(captured[0]!.onOutput).toBeDefined();
    captured[0]!.onOutput?.({ stream: 'stdout', text: 'streaming' });
    expect(chunks).toEqual([{ stream: 'stdout', text: 'streaming' }]);
    // The lane emitted per-target progress, and the stage passed it through.
    expect(progress).toEqual([
      { repo: '/wt/web', status: 'active' },
      { repo: '/wt/web', status: 'completed', detail: '0 findings' },
    ]);
  });

  // Every other test in this file either supplies no `manifest.review` at all
  // or overrides only `uat`, so none of them would notice a regression that
  // disconnected `manifest.review` from what review actually runs — the pure
  // `resolveReviewGates`/`declaredReviewGatesFor` unit tests
  // (`workflow/review/gates.test.ts`) prove the function is correct in
  // isolation, not that `runReview` calls it with the manifest it was given.
  // These two drive the real orchestration path with a POPULATED
  // `manifest.review` to prove the wiring itself.
  it('runs the gates declared in manifest.review instead of probing', async () => {
    const res = await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { review: reviewConfig({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] }) }),
      },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [{ repo: '/web', path: '/wt/web', names: ['web'] }],
        unmapped: [],
        }),
        // The repository answers every default review script. If the declared
        // config were not reaching gate resolution, all four (lint, typecheck,
        // build, format) would run instead of only the one declared here.
        probe: () => ({ kind: 'ok', scripts: ALL_SCRIPTS }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(listGateRuns(store, id).map((r) => r.gateName)).toEqual(['lint (web)']);
  });

  it('a per-repository gate override in manifest.review reaches only that repository', async () => {
    const res = await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest(
          {},
          {
            review: reviewConfig({
              gates: [{ name: 'lint', kind: 'script', script: 'lint' }],
              repositories: {
                api: {
                  gates: [{ name: 'govet', kind: 'command', command: 'go', args: ['vet', './...'] }],
                },
              },
            }),
          },
        ),
      },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        unmapped: [],
        }),
        // Nothing to probe for — every gate below must come from declared
        // config, or this run would block nothing-to-run instead of shipping.
        probe: () => ({ kind: 'ok', scripts: {} }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    // `web` has no override, so it keeps the global `lint` gate; `api`'s
    // override REPLACES the global list with `govet` — it does not also run
    // `lint`, proving the override is per-repository, not additive.
    expect(listGateRuns(store, id).map((r) => r.gateName).sort()).toEqual(
      ['govet (api)', 'lint (web)'].sort(),
    );
  });

  it('a single red gate -> routes to fix and files the evidence under the attempt that ran', async () => {
    // `transition` increments `attempt` on the failed branch. The gates belong to
    // the run that produced the failure, so they must be read before that bump.
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({
            name: g.name,
            exitCode: g.name === 'lint' ? 1 : 0,
            output: 'lint error',
            startedAt: now(),
            endedAt: now(),
          })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(listGateRuns(store, id).every((r) => r.attempt === 0)).toBe(true);
    expect(reviewStage(store, id).attempt).toBe(1);
  });

  // R1. Two situations that used to read as one: "asked nothing" (every
  // worktree mapped, none changed) must PASS — the stage delivered everything
  // it had — while a worktree that matched no manifest entry must still reach
  // a human, because only editing karst.yml or re-scoping the ticket can
  // change that. The unavailable path (R2, below) must never read as either.
  it('blocks and names the unmapped worktrees when a repository is missing from the manifest', async () => {
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/unmapped', '/wt/unmapped', 'b', 'develop', 'inherited')",
      )
      .run(id);
    const runGates = vi.fn(deps().runGates!);
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: ['/unmapped'] }), runGates, openDiff }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'unmapped-repository' });
    expect(res).toMatchObject({ reason: expect.stringContaining('/unmapped') });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
    expect(stageBlock(store, id, 'review')?.kind).toBe('unmapped-repository');
    expect(runGates).not.toHaveBeenCalled();
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('passes with a note when every repository mapped and none has changes', async () => {
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/web', '/wt/web', 'b', 'develop', 'inherited')",
      )
      .run(id);
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: [] }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(getTicket(store, id).stageCurrent).toBe('ship');
    expect(stageBlock(store, id, 'review')).toBeNull();
    expect(readFileSync(reviewStage(store, id).artifactPath!, 'utf8')).toContain(
      'no repository has changes from its base, so review had nothing to check',
    );
  });

  // Zero worktrees is a third case, and it is neither of the two above: the
  // question was never asked of any repository, so it can only park.
  it('parks when the ticket has no registered worktree at all', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: [] }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(res).toMatchObject({
      reason:
        'no worktree is registered for this ticket, so there is no repository to run review against',
    });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
    expect(stageBlock(store, id, 'review')?.kind).toBe('nothing-to-run');
  });

  // R2. Environmental — karst could not even determine which repositories are
  // affected. Never a verdict about the ticket's code, so it parks rather than
  // transitioning or (as before this task) throwing out of the stage.
  it('an unavailable target selection blocks with the propagated blocker and reason', async () => {
    const reason = 'cannot determine review changes in /wt/web: baseline unavailable';
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'unavailable', blocker: 'capability-missing', reason }) }),
    );
    expect(res).toEqual({ kind: 'blocked', blocker: 'capability-missing', reason });
    expect(stageBlock(store, id, 'review')).toEqual({ kind: 'capability-missing', reason, at: now() });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
    expect(listGateRuns(store, id)).toEqual([]);
  });

  // An `unavailable` selection and a genuine empty target list must stay
  // distinguishable: collapsing them reads an environmental failure as
  // "nothing to review". The empty list's own fate is a pass with a note
  // (every worktree mapped, none changed), asserted separately above.
  it('keeps an unavailable selection and a genuine empty target list apart', async () => {
    const unavailable = await runReview(
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
    walkToReview(store, id2);
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/web', '/wt/web', 'b', 'develop', 'inherited')",
      )
      .run(id2);
    const empty = await runReview(
      store,
      { ticketId: id2, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: [] }) }),
    );
    expect(empty).not.toMatchObject({ kind: 'blocked' });
    expect(empty).toMatchObject({ kind: 'advanced', next: 'ship' });
    expect(empty).not.toMatchObject({ blocker: 'capability-missing' });
  });

  it('an unreadable repository blocks capability-missing', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'io-error', message: 'EACCES' }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    expect(reviewStage(store, id).attempt).toBe(0);
  });

  // R2 outranks R5: a repository karst could not ask anything of is not a
  // verdict about the ticket's code, however red an earlier target was.
  it('a repository karst cannot read outranks a red gate in an earlier target', async () => {
    const res = await runReview(
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
            ? { kind: 'ok', scripts: { lint: 'eslint .' } }
            : { kind: 'io-error', message: 'EACCES' },
        runGates: async (gates, _cwd, opts) => {
          const results = gates.map((g, i) => {
            const startedAt = now();
            const endedAt = now();
            opts?.onGateComplete?.(g.name, 1, startedAt, endedAt, i);
            return { name: g.name, exitCode: 1, output: 'boom', startedAt, endedAt };
          });
          return { kind: 'ran', results };
        },
      }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    // The completed target's evidence goes down with the park.
    expect(listGateRuns(store, id).map((r) => r.gateName)).toEqual(['lint (web)']);
    expect(listGateRuns(store, id)[0]!.attempt).toBe(0);
  });

  // R3 — the repository answers none of review's questions.
  it('a repository defining none of the review scripts blocks nothing-to-run', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { deploy: 'foo' } }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
  });

  // R3 is decided ACROSS every target, never per target. A repository that
  // answers none of review's questions (a Go service, a docs package, anything
  // with no package.json) says nothing on its own — parking the whole run on it
  // discards the green target beside it, depends on target order, and leaves a
  // mixed-stack ticket unprogressable without a human clearing the block every
  // single run.
  it('a target with no runnable script does not park a run another target answered', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/svc', path: '/wt/svc', names: ['svc'] },
            { repo: '/web', path: '/wt/web', names: ['web'] },
          ],
        unmapped: [],
        }),
        probe: (cwd) =>
          cwd === '/wt/web' ? { kind: 'ok', scripts: ALL_SCRIPTS } : { kind: 'absent' },
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(listGateRuns(store, id).map((r) => r.gateName)).toEqual([
      'lint (web)',
      'typecheck (web)',
      'build (web)',
      'format:check (web)',
    ]);
    // The repository that answered nothing is still named in the log — an
    // absence a human cannot see is indistinguishable from one karst never met.
    expect(readFileSync(reviewStage(store, id).artifactPath!, 'utf8')).toContain('svc');
  });

  // ...and the order of that target must not change the outcome.
  it('reaches the same verdict whichever way round the scriptless target sorts', async () => {
    const probeOf = (cwd: string) =>
      cwd === '/wt/web' ? ({ kind: 'ok', scripts: ALL_SCRIPTS } as const) : ({ kind: 'absent' } as const);
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/svc', path: '/wt/svc', names: ['svc'] },
          ],
        unmapped: [],
        }),
        probe: probeOf,
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
  });

  // A repository karst could not READ is still a park, even beside a green one:
  // capability-missing is environmental and a human has to act on it.
  it('still parks on an unreadable target beside one that answered', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/svc', path: '/wt/svc', names: ['svc'] },
          ],
        unmapped: [],
        }),
        probe: (cwd) =>
          cwd === '/wt/web'
            ? { kind: 'ok', scripts: ALL_SCRIPTS }
            : { kind: 'io-error', message: 'EACCES' },
      }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
  });

  it('every gate reporting null blocks nothing-to-run, keeping the rows that say so', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates, _cwd, opts) => {
          // Every gate answered null: karst asked, and nothing answered. Each
          // row proves a question WAS asked — and must survive the park.
          const results = gates.map((g, i) => {
            opts?.onGateComplete?.(g.name, null, null, null, i);
            return { name: g.name, exitCode: null, output: 'nothing to run' };
          });
          return { kind: 'ran', results };
        },
      }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(listGateRuns(store, id).every((r) => r.exitCode === null)).toBe(true);
    expect(reviewStage(store, id).artifactPath).not.toBeNull();
  });

  // R4 — a repository defect an agent CAN fix, so it reaches a verdict.
  it('a malformed package.json fails by name rather than parking', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'malformed', message: 'Unexpected token }' }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(stageBlock(store, id, 'review')).toBeNull();
    const rows = listGateRuns(store, id);
    expect(rows.map((r) => r.gateName)).toEqual(['package.json (/wt/web)']);
    expect(rows[0]!.exitCode).toBe(1);
    expect(readFileSync(reviewStage(store, id).artifactPath!, 'utf8')).toContain('Unexpected token }');
  });

  // R7 — review re-asking only UAT's questions has added no signal. A FAILURE,
  // not a warning: review's escape hatch is configuration, available the same day.
  it('fails when every gate that ran duplicates the latest UAT batch', async () => {
    recordGateRun(store, {
      ticketId: id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T09:00:00.000Z',
      gates: [{ gateName: 'lint (/wt/web)', exitCode: 0 }],
    });
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(reviewStage(store, id).verdict).toContain('review asked no question uat does not');
  });

  // Task 10: the manifest value must reach the rule through the real
  // orchestration path, not just the pure `aggregateReview` function — a test
  // that only exercised the pure function would leave the wiring unproven.
  it('review.requireIndependentSignal: false lets a run that would otherwise fail R7 reach a pass', async () => {
    // A manifest is supplied, so `deps().planTargets` names the target 'web'
    // (not the bare path) — the recorded uat gate name must match that label
    // for this to be the genuine overlap R7 exists to catch.
    recordGateRun(store, {
      ticketId: id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T09:00:00.000Z',
      gates: [{ gateName: 'lint (web)', exitCode: 0 }],
    });
    const res = await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { review: reviewConfig({ requireIndependentSignal: false }) }),
      },
      deps({ probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
  });

  // Backward compatibility: a manifest present but carrying no `review:` block
  // (or one that omits the key) must behave exactly like no manifest at all —
  // R7 stays a FAILURE by default.
  it('a manifest with no review.requireIndependentSignal key still defaults to true', async () => {
    // With a manifest present, `deps().planTargets` names the target 'web'
    // (not the bare path), so the recorded uat gate name must match that label
    // for the two sides to be recognised as the same question.
    recordGateRun(store, {
      ticketId: id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T09:00:00.000Z',
      gates: [{ gateName: 'lint (web)', exitCode: 0 }],
    });
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }) }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(reviewStage(store, id).verdict).toContain('review asked no question uat does not');
  });

  it('passes when one gate asks something the latest UAT batch did not', async () => {
    recordGateRun(store, {
      ticketId: id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T09:00:00.000Z',
      gates: [{ gateName: 'lint (/wt/web)', exitCode: 0 }],
    });
    const res = await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
  });

  it('a stopped run keeps its partial rows, states no verdict and consumes no attempt', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (_gates, _cwd, opts) => {
          // The one gate completed before the stop landed — real `runGateList`
          // fires the callback for it, and the row must survive the stop.
          opts?.onGateComplete?.('lint', 0, now(), now(), 0);
          return {
            kind: 'stopped',
            results: [{ name: 'lint', exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() }],
          };
        },
      }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
    const rows = listGateRuns(store, id);
    expect(rows.map((r) => r.gateName)).toEqual(['lint (/wt/web)']);
    expect(rows[0]!.attempt).toBe(0);
    expect(readFileSync(reviewStage(store, id).artifactPath!, 'utf8')).toContain('ok');
  });

  it('clears a previous block when a fresh run reaches a verdict', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { deploy: 'foo' } }) }),
    );
    expect(stageBlock(store, id, 'review')).not.toBeNull();
    await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(stageBlock(store, id, 'review')).toBeNull();
  });

  it('keeps the gate rows of a run whose transition throws, without advancing it', async () => {
    // Evidence is written as each gate FINISHES, not when the run ends, so a
    // run destroyed after its gates ran leaves exactly what it learned
    // readable. The VERDICT is still all-or-nothing — the throw must not
    // advance the ticket — but the two are no longer the same commit, because a
    // host restart fires no abort signal and used to discard the lot.
    store.db.prepare('DELETE FROM stages WHERE ticket_id = ? AND stage_key = ?').run(id, 'review');
    await expect(
      runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps()),
    ).rejects.toThrow(/has no stage 'review'/);
    expect(listGateRuns(store, id).length).toBeGreaterThan(0);
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  // The durability property at its finest grain: the row is written when the
  // GATE finishes, inside the runner's loop — never batched to the end of the
  // target. A runner that dies mid-list (a throw here, process death in
  // production) leaves every gate that already finished readable.
  it('persists each gate the moment it finishes, before the target list completes', async () => {
    await expect(
      runReview(
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
    expect(rows.map((r) => r.gateName)).toEqual(['lint (/wt/web)']);
    expect(rows[0]!.exitCode).toBe(0);
    // The run itself is still open — the next run (or the activation sweep)
    // reads it as destroyed, never as never-started or in flight.
    expect(listStageRuns(store, id).map((r) => r.status)).toEqual(['running']);
  });

  it('runs every target and aggregates only after all of them complete', async () => {
    const ran: string[] = [];
    await runReview(
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
    expect(ran).toEqual(['/wt/web', '/wt/api']);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('threads one abort signal into every gate invocation, so Stop reaches a running gate', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    await runReview(
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
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates, _cwd, opts) => {
          available = opts?.scriptsAvailable;
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(available?.('lint')).toBe(true);
    expect(available?.('e2e')).toBe(false);
  });

  it('surfaces the changes of every target it reviewed, and records that as evidence', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig({ openChanges: true }) }) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        unmapped: [],
        }),
        openDiff,
      }),
    );
    expect(openDiff.mock.calls.map((call) => call[1])).toEqual(['/wt/web', '/wt/api']);
    // Named 'changes', not 'diff': the host reveals the Changes panel — it does
    // not itself open a diff editor.
    expect(listGateRuns(store, id).find((r) => r.gateName === 'changes')).toMatchObject({
      exitCode: 0,
      stageKey: 'review',
      attempt: 0,
    });
  });

  // The 'changes' row is one fact about the RUN ("did the surface open at
  // all"), not one per repository — `diffOpened` only latches it on the first
  // target, so a second and third target opening their own diff must not
  // multiply the row.
  it('records the changes evidence exactly once, however many targets opened it', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig({ openChanges: true }) }) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
        unmapped: [],
        }),
        openDiff,
      }),
    );
    expect(listGateRuns(store, id).filter((r) => r.gateName === 'changes')).toHaveLength(1);
  });

  it('records no changes evidence when nothing was wired to open it', async () => {
    await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(listGateRuns(store, id).find((r) => r.gateName === 'changes')).toBeUndefined();
  });

  // The host ALWAYS wires `openDiff`; the manifest setting is the only gate.
  // With the default (absent key → OFF), a wired host must not open anything
  // and must not claim it did in the evidence.
  it('does not open the changes surface while review.openChanges is off, even with a host wired to open it', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [{ repo: '/web', path: '/wt/web', names: ['web'] }],
        unmapped: [],
        }),
        openDiff,
      }),
    );
    expect(openDiff).not.toHaveBeenCalled();
    expect(listGateRuns(store, id).find((r) => r.gateName === 'changes')).toBeUndefined();
  });

  it('opens the changes surface on a failing verdict too', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig({ openChanges: true }) }) },
      deps({
        openDiff,
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now() })),
        }),
      }),
    );
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(openDiff).toHaveBeenCalledWith(id, '/wt/web');
    // Filed under the SAME pre-bump attempt as the gates that failed beside it.
    expect(listGateRuns(store, id).every((r) => r.attempt === 0)).toBe(true);
  });

  it('a gate failure commits a review-origin recovery round attributed to the gates source', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now() })),
        }),
      }),
    );
    const rounds = listRecoveryRounds(store, id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      sourceStage: 'review',
      sourceProcessId: 'gates',
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'gates failed: lint (/wt/web), typecheck (/wt/web), build (/wt/web), format:check (/wt/web)',
      round: 1,
      maxRounds: 3,
      status: 'pending',
    });
    expect(rounds[0]!.sourceStageRunId).toBe(listStageRuns(store, id)[0]!.id);
  });

  it('blocking findings are attributed to the review process — never a reconstructed gate verdict', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      deps({
        findingsAdapter: findingsAgent(
          JSON.stringify([{ severity: 'critical', title: 'boom', detail: 'very bad' }]),
        ),
      }),
    );
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    const rounds = listRecoveryRounds(store, id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      sourceStage: 'review',
      sourceProcessId: 'review',
      triggerKind: 'blocking-review-findings',
      triggerDetail: 'review findings: 1 critical',
      round: 1,
      status: 'pending',
    });
  });

  it('snapshots review.maxFixAttempts into the round — a later manifest edit cannot widen it', async () => {
    await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { review: reviewConfig({ maxFixAttempts: 1 }) }),
      },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now() })),
        }),
      }),
    );
    expect(listRecoveryRounds(store, id)[0]!.maxRounds).toBe(1);
  });

  it('opens nothing further once the run was stopped', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ openDiff, runGates: async () => ({ kind: 'stopped', results: [] }) }),
    );
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('writes each gate section to the artifact and records its path on the stage', async () => {
    await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    const path = reviewStage(store, id).artifactPath!;
    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('# lint (/wt/web, exit 0)');
    expect(contents).toContain('# typecheck (/wt/web, exit 0)');
  });

  it('says a gate was skipped in the artifact rather than claiming it passed', async () => {
    // A skipped gate alongside one that ran — an all-skipped run is its own
    // case (it blocks), so this fixture keeps one gate answered to isolate the
    // artifact wording under test.
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g, i) =>
            i === 0
              ? { name: g.name, exitCode: null, output: 'no "lint" script — nothing to run' }
              : { name: g.name, exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() },
          ),
        }),
      }),
    );
    const contents = readFileSync(reviewStage(store, id).artifactPath!, 'utf8');
    expect(contents).toContain('# lint (/wt/web, skipped)');
    expect(contents).not.toContain('# lint (/wt/web, exit 0)');
  });

  it('stores the timings a gate reports and leaves a gate that never ran without any', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates, _cwd, opts) => {
          const results = gates.map((g, i) => {
            if (i === 0) {
              const startedAt = '2026-07-20T12:00:00.000Z';
              const endedAt = '2026-07-20T12:00:06.400Z';
              opts?.onGateComplete?.(g.name, 0, startedAt, endedAt, i);
              return { name: g.name, exitCode: 0, output: 'ok', startedAt, endedAt };
            }
            // A gate that never ran still reports itself — real `runGateList`
            // fires the callback with no timing, and no timing is recorded.
            opts?.onGateComplete?.(g.name, null, null, null, i);
            return { name: g.name, exitCode: null, output: 'nothing to run' };
          });
          return { kind: 'ran', results };
        },
      }),
    );
    const [first, second] = listGateRuns(store, id);
    expect(first!.startedAt).toBe('2026-07-20T12:00:00.000Z');
    expect(first!.endedAt).toBe('2026-07-20T12:00:06.400Z');
    // A gate that never ran has no duration; inventing one would read as a
    // zero-length run rather than as "karst had nothing to ask".
    expect(second!.startedAt).toBeNull();
    expect(second!.endedAt).toBeNull();
  });

  it('does not run a review gate the ticket disabled', async () => {
    setDisabledGates(store, id, 'review', ['lint']);
    const invoked: string[] = [];
    await runReview(
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
              output: 'ok',
              startedAt: now(),
              endedAt: now(),
            })),
          };
        },
      }),
    );
    expect(invoked).not.toContain('lint');
  });

  it('records the disabled review gate as a skipped row', async () => {
    setDisabledGates(store, id, 'review', ['lint']);
    await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    const skipped = listGateRuns(store, id).filter((r) => r.skipped);
    expect(skipped.map((r) => r.stageKey)).toEqual(['review']);
    expect(skipped[0]!.gateName).toContain('lint');
    expect(skipped[0]!.exitCode).toBeNull();
  });

  it("a uat disable does not affect review's gates", async () => {
    setDisabledGates(store, id, 'uat', ['lint']);
    const invoked: string[] = [];
    await runReview(
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
              output: 'ok',
              startedAt: now(),
              endedAt: now(),
            })),
          };
        },
      }),
    );
    expect(invoked).toContain('lint');
  });

  it('a disabled review gate never fails the stage', async () => {
    setDisabledGates(store, id, 'review', ['lint']);
    const result = await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(result).toEqual({ kind: 'advanced', next: 'ship' });
  });

  it('advances when every review gate is disabled — the user chose to skip all checks', async () => {
    setDisabledGates(store, id, 'review', ['lint', 'typecheck', 'build', 'format:check']);
    const result = await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(result).toEqual({ kind: 'advanced', next: 'ship' });
  });
});

describe('review findings lane (Lane B)', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    walkToReview(store, id);
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-review-findings-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  // spec §8.14: findings.enabled on, but no agent core available, is NOT a
  // review failure — it is capability-missing, parked for a human, exactly
  // like an unreadable repository (R2).
  it('a missing agent core is capability-missing blocked, not a failure', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ findingsAdapter: undefined }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(stageBlock(store, id, 'review')?.kind).toBe('capability-missing');
    expect(listFindings(store, id)).toEqual([]);
  });

  // spec §8.14: "If gates already produced a failure, R5 wins and no agent
  // call is made at all."
  it('a gate failure short-circuits before any AI call is made', async () => {
    const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    const adapter: AgentAdapter = { ...findingsAgent(), runHeadless };
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        findingsAdapter: adapter,
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({
            name: g.name,
            exitCode: g.name === 'lint' ? 1 : 0,
            output: 'lint error',
            startedAt: now(),
            endedAt: now(),
          })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(runHeadless).not.toHaveBeenCalled();
    expect(listFindings(store, id)).toEqual([]);
  });

  it('blockingSeverity: none never fails a ticket, however severe the findings', async () => {
    const res = await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest(
          {},
          {
            review: reviewConfig({
              findings: { enabled: true, blockingSeverity: 'none', maxFindings: 50 },
            }),
          },
        ),
      },
      deps({
        findingsAdapter: findingsAgent(
          JSON.stringify([{ severity: 'critical', title: 'boom', detail: 'very bad' }]),
        ),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    // Still recorded as evidence even though it never blocked anything.
    expect(listFindings(store, id)).toHaveLength(1);
    expect(listFindings(store, id)[0]!.severity).toBe('critical');
  });

  it('a critical finding fails review to fix, at the configured threshold', async () => {
    const res = await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { review: reviewConfig() }), // default: enabled, blockingSeverity 'high'
      },
      deps({
        findingsAdapter: findingsAgent(
          JSON.stringify([{ severity: 'critical', title: 'boom', detail: 'very bad' }]),
        ),
      }),
    );
    expect(res).toMatchObject({ kind: 'advanced', next: 'fix' });
    expect(reviewStage(store, id).verdict).toContain('review findings: 1 critical');
  });

  it('a low finding is recorded but does not block', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      deps({
        findingsAdapter: findingsAgent(
          JSON.stringify([{ severity: 'low', title: 'nit', detail: 'style only' }]),
        ),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(listFindings(store, id)).toHaveLength(1);
  });

  // I3: `worktrees.base_ref` is already in hand at this call site — the
  // findings prompt must name it rather than leaving the agent to guess "its
  // base branch", which at `blockingSeverity: 'high'` can fail a ticket over
  // a commit that was never part of its diff.
  //
  // fu1: the worktree's BRANCH is equally in hand — the scope block names it
  // so the diff range `origin/<base>...<branch>` reads the ticket's changes
  // from any checkout instead of a silent empty `...HEAD` on the base branch.
  it("threads the worktree's base ref and branch into the findings prompt", async () => {
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/web', '/wt/web', 'karst/x', 'develop', 'inherited')",
      )
      .run(id);
    let capturedPrompt: string | undefined;
    const runHeadless = vi.fn(async (headlessOpts: { prompt: string }) => {
      capturedPrompt = headlessOpts.prompt;
      return { sessionId: '', verdict: null, raw: '[]' };
    });
    const adapter: AgentAdapter = { ...findingsAgent(), runHeadless };
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      deps({
        findingsAdapter: adapter,
        planTargets: async () => ({
          kind: 'targets',
          targets: [{ repo: '/web', path: '/wt/web', names: ['web'] }],
        unmapped: [],
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(runHeadless).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toContain('develop');
    expect(capturedPrompt).toContain('karst/x');
    expect(capturedPrompt).toContain('origin/develop...origin/karst/x');
  });

  // A failed/garbage agent call must not break the stage: the run still
  // reaches a verdict decided by its gates, never a park.
  it('a failed agent call still reaches a gate-based verdict, contributing no findings', async () => {
    const adapter: AgentAdapter = {
      ...findingsAgent(),
      runHeadless: async () => {
        throw new Error('spawn ENOENT');
      },
    };
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ findingsAdapter: adapter }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(listFindings(store, id)).toEqual([]);
  });

  // R6b: an agent response that carries no readable JSON at all is not a
  // clean review — it is the vacuous-pass bug this whole plan closes. The
  // lane still runs and reaches `ran` (never breaking the stage), but the
  // aggregate now blocks rather than reading unreadable output as "nothing
  // wrong", so this response can no longer wave a ticket through to ship.
  it('an unreadable (fully prose) agent response blocks instead of reaching a vacuous pass', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ findingsAdapter: findingsAgent('sure, looks fine to me!') }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    expect(listFindings(store, id)).toEqual([]);
  });

  // Finding 2 (pin): the stage must actually SUPPLY its `warn` dependency to
  // the lane, not merely accept one — a `parseFindings` boundary warning
  // (untrusted-agent-output diagnostics) raised during a real run must reach
  // the injected `warn`, never the extension-host console. If a future
  // refactor stops threading `deps.warn` through to `planAndRunFindingsLane`,
  // this test fails instead of the warning silently reverting to
  // `console.warn`.
  it('supplies its warn dependency to the findings lane, reaching it instead of the console', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warn = vi.fn();
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ findingsAdapter: findingsAgent('sure, looks fine to me!'), warn }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some(([message]) => message.includes('not recognizable JSON'))).toBe(true);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('keeps the findings of a run whose transition throws', async () => {
    store.db.prepare('DELETE FROM stages WHERE ticket_id = ? AND stage_key = ?').run(id, 'review');
    await expect(
      runReview(
        store,
        { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
        deps({
          findingsAdapter: findingsAgent(
            JSON.stringify([{ severity: 'critical', title: 'boom', detail: 'very bad' }]),
          ),
        }),
      ),
    ).rejects.toThrow(/has no stage 'review'/);
    // Persisted the moment the lane returned, before any aggregation — these
    // are completed model output the user already paid for (a single lane has
    // cost 1.3M tokens). Holding them for the verdict is what let a host
    // restart discard a whole run's findings with nothing recorded anywhere.
    expect(listFindings(store, id).map((f) => f.title)).toEqual(['boom']);
  });

  it('records findings under the SAME batch stamp as the gates that ran beside them', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      deps({
        findingsAdapter: findingsAgent(
          JSON.stringify([{ severity: 'low', title: 'nit', detail: '' }]),
        ),
      }),
    );
    const gateRunAt = new Set(listGateRuns(store, id).map((r) => r.runAt));
    const findingRunAt = new Set(listFindings(store, id).map((f) => f.runAt));
    expect(findingRunAt).toEqual(gateRunAt);
  });

  // F2 at its finest grain: each target's findings are persisted the instant
  // THAT call returns — readable while the lane is still awaiting the next
  // target. A host that dies mid-lane (the 1.3M-token incident shape, one
  // target up) must not take the targets that already answered with it.
  it("persists each target's findings as its call returns, while the lane is still in flight", async () => {
    let releaseSecond!: () => void;
    const secondCall = new Promise<void>((resolve) => (releaseSecond = resolve));
    const runHeadless = vi
      .fn()
      .mockImplementationOnce(async () => ({
        sessionId: '',
        verdict: null,
        raw: JSON.stringify([{ severity: 'low', title: 'first repo bug', detail: 'd' }]),
      }))
      .mockImplementationOnce(() =>
        secondCall.then(() => ({ sessionId: '', verdict: null, raw: '[]' })),
      );
    const adapter: AgentAdapter = { ...findingsAgent(), runHeadless };
    const pending = runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        findingsAdapter: adapter,
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
    // Both calls started means the first already RETURNED — and its findings
    // were written before the second target was even asked.
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(2));
    expect(listFindings(store, id).map((f) => f.title)).toEqual(['first repo bug']);
    releaseSecond();
    await expect(pending).resolves.toMatchObject({ kind: 'advanced' });
  });

  it("records the run's manifest_hash when a manifest is supplied", async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      deps(),
    );
    expect(latestStageRun(store, id, 'review')?.manifestHash).not.toBeNull();
  });

  it('records no manifest_hash when no manifest is supplied', async () => {
    await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(latestStageRun(store, id, 'review')?.manifestHash).toBeNull();
  });

  // The mechanism `runReview` actually uses: `evidence.appendFindings` writes
  // the moment the lane returns, from inside `planAndRunFindingsLane`'s caller
  // — well before `aggregateReview` decides anything, and before
  // `commitGateOutcome` is even invoked. `runReview`'s own gate rules make a
  // 'blocked' outcome and a produced finding mutually exclusive in practice
  // (the lane only ever runs once R3–R5 have already let the gates through,
  // and R6's only block, capability-missing, is the one path that never calls
  // the adapter at all) — so this exercises the same `evidence`/
  // `commitGateOutcome` seam directly, proving the ordering holds regardless
  // of what outcome ends up being committed, not just the one review's rules
  // happen to reach today.
  it('keeps a persisted finding when the outcome committed afterward is a park, not a verdict', async () => {
    const runAt = now();
    const evidence = openGateRun(store, { ticketId: id, stageKey: 'review', runAt });
    evidence.appendFindings([
      { repo: '/web', severity: 'low', title: 'nit', detail: 'style only', file: null, line: null, source: 'agent' },
    ]);
    // Already on disk before any outcome exists.
    expect(listFindings(store, id)).toHaveLength(1);

    commitGateOutcome(store, {
      ticketId: id,
      stageKey: 'review',
      runAt,
      artifactPath: join(artifactDir, 'manual.log'),
      gates: [],
      outcome: { kind: 'blocked', blocker: 'capability-missing', reason: 'no agent core available' },
      stageRunId: evidence.runId,
      now,
    });

    expect(listFindings(store, id)).toHaveLength(1);
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(stageBlock(store, id, 'review')?.kind).toBe('capability-missing');
  });
});

/**
 * The Review findings process run (Task 8): opened before the AI call with the
 * resolved assignment snapshot, finished with an EXPLICIT result kind after
 * it. A crash stays distinguishable from a finding: `execution-failed`,
 * artifact exposed, and no recovery round — only a blocking FINDING may open
 * one.
 */
describe('runReview — findings process run (Task 8)', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  const reviewProcessDeps = (raw: string, over: Partial<ReviewDeps> = {}): ReviewDeps =>
    deps({
      reviewProcess: {
        assignment: { agentName: 'Review Agent', provider: 'claude', model: 'claude-sonnet-5' },
        adapter: findingsAgent(raw),
      },
      ...over,
    });

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    walkToReview(store, id);
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-review-process-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('opens the Review process run before the call and finishes it validated on a clean pass', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      reviewProcessDeps('[]'),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    const run = listProcessRuns(store, id)[0]!;
    expect(run).toMatchObject({
      stageKey: 'review',
      processId: 'review',
      resultKind: 'validated',
      status: 'passed',
      agentName: 'Review Agent',
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    expect(run.stageRunId).toBe(listStageRuns(store, id)[0]!.id);
  });

  it('finishes the Review process run blocking when findings blocked the run', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      reviewProcessDeps(JSON.stringify([{ severity: 'critical', title: 'boom', detail: 'very bad' }])),
    );
    expect(res).toMatchObject({ kind: 'advanced', next: 'fix' });
    expect(listProcessRuns(store, id)[0]).toMatchObject({ resultKind: 'blocking', status: 'failed' });
    expect(listRecoveryRounds(store, id)[0]).toMatchObject({
      sourceProcessId: 'review',
      triggerKind: 'blocking-review-findings',
    });
  });

  it('names the ACTUAL findings process run as the blocking round\'s source process run', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      reviewProcessDeps(JSON.stringify([{ severity: 'critical', title: 'boom', detail: 'very bad' }])),
    );
    expect(res).toMatchObject({ kind: 'advanced', next: 'fix' });
    const run = listProcessRuns(store, id).find((r) => r.processId === 'review')!;
    expect(run).toMatchObject({ resultKind: 'blocking', status: 'failed' });
    // The round names the exact findings process run that produced the block —
    // causal provenance, never an id of another table forced into the column.
    expect(listRecoveryRounds(store, id)[0]).toMatchObject({
      sourceProcessId: 'review',
      sourceProcessRunId: run.id,
      triggerKind: 'blocking-review-findings',
    });
  });

  // R6b (Task 2.4): a run whose only answer was unreadable must not be
  // recorded as `validated` — that would contradict the `blocked` outcome
  // and read, in the process history, as a review that actually happened.
  it('finishes the Review process run execution-failed, never validated, on an R6b unreadable block', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      reviewProcessDeps('sure, looks fine to me!'),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    const run = listProcessRuns(store, id)[0]!;
    expect(run).toMatchObject({ resultKind: 'execution-failed', status: 'failed' });
  });

  it('a deterministic gate failure keeps the round\'s source process run null, however the process was wired', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      reviewProcessDeps('[]', {
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({
            name: g.name,
            exitCode: 1,
            output: 'boom',
            startedAt: now(),
            endedAt: now(),
          })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    // The gates decided before the lane ran, so no process run was opened —
    // and the round must not invent an AI source for a deterministic failure.
    expect(listRecoveryRounds(store, id)[0]).toMatchObject({
      sourceProcessId: 'gates',
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
    });
  });

  it('a crash records execution-failed, exposes the artifact, and does not increment recovery rounds', async () => {
    const adapter: AgentAdapter = {
      ...findingsAgent('[]'),
      runHeadless: async () => {
        throw new Error('spawn ENOENT');
      },
    };
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      deps({ reviewProcess: { assignment: { provider: 'claude' }, adapter } }),
    );
    // The gates still decide: an AI crash is not a code verdict.
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    const run = listProcessRuns(store, id)[0]!;
    expect(run).toMatchObject({ resultKind: 'execution-failed', status: 'failed' });
    // The artifact is where the crash is exposed: the one-line collapsed
    // boundary diagnostic lands in the run's artifact.
    expect(run.artifactPath).toBe(join(artifactDir, `review-ticket-${id}.log`));
    expect(readFileSync(run.artifactPath!, 'utf8')).toContain('spawn ENOENT');
    // A crash is not a finding: no recovery round was opened for it.
    expect(listRecoveryRounds(store, id)).toEqual([]);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('opens no process run when the lane itself is skipped (gates already decided)', async () => {
    const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        reviewProcess: {
          assignment: { provider: 'claude' },
          adapter: { ...findingsAgent('[]'), runHeadless },
        },
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

  it('attributes the findings batch to the opened process run', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig() }) },
      reviewProcessDeps(JSON.stringify([{ severity: 'low', title: 'nit', detail: '' }])),
    );
    const run = listProcessRuns(store, id)[0]!;
    expect(listFindings(store, id)[0]!.processRunId).toBe(run.id);
  });

  // Finding 2: a disabled `processes.review` resolves to NULL — configured
  // absence, short-circuited before any provider/model resolution. The stage
  // then has no Review process and no adapter to ask: the deterministic gate
  // lane still runs, but no AI call is made and no process run is opened.
  it('a disabled Review process reads as configured absence — no AI call, no process run, gates still run', async () => {
    const disabled: Manifest = { ...manifest({}), processes: { review: { enabled: false } } };
    const assignment = resolveProcessAssignment(disabled, 'review');
    expect(assignment).toBeNull();
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: disabled },
      deps({ reviewProcess: null, findingsAdapter: undefined }),
    );
    // The lane has no agent core to ask: capability-missing park — the absence
    // is NAMED, never read as a green review the AI skipped.
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
    expect(listProcessRuns(store, id).filter((r) => r.processId === 'review')).toHaveLength(0);
    expect(listFindings(store, id)).toEqual([]);
    expect(listGateRuns(store, id).length).toBeGreaterThan(0);
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  // Finding 3: a Stop during the findings lane is an explicit stopped outcome —
  // the Review process is interrupted, and the run returns stopped before any
  // aggregation, recovery round, or transition. Gates that already finished
  // stay recorded; nothing further opens.
  it('a Stop before the lane first target returns stopped with the process interrupted — no verdict, no round, no transition', async () => {
    const controller = new AbortController();
    const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    const res = await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { review: reviewConfig() }),
        signal: controller.signal,
      },
      deps({
        reviewProcess: {
          assignment: { agentName: 'Review Agent', provider: 'claude' },
          adapter: { ...findingsAgent('[]'), runHeadless },
        },
        runGates: async (gates) => {
          controller.abort();
          return {
            kind: 'ran',
            results: gates.map((g) => ({
              name: g.name,
              exitCode: 0,
              output: 'ok',
              startedAt: now(),
              endedAt: now(),
            })),
          };
        },
      }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    expect(runHeadless).not.toHaveBeenCalled();
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
    expect(listRecoveryRounds(store, id)).toEqual([]);
    expect(listProcessRuns(store, id)[0]).toMatchObject({
      processId: 'review',
      resultKind: 'interrupted',
      status: 'interrupted',
    });
  });

  it('a Stop between lane targets returns stopped — the second target is never asked and the process is interrupted', async () => {
    const controller = new AbortController();
    const runHeadless = vi.fn(async () => {
      controller.abort();
      return { sessionId: '', verdict: null, raw: '[]' };
    });
    const res = await runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { review: reviewConfig() }),
        signal: controller.signal,
      },
      deps({
        reviewProcess: {
          assignment: { agentName: 'Review Agent', provider: 'claude' },
          adapter: { ...findingsAgent('[]'), runHeadless },
        },
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
    expect(res).toEqual({ kind: 'stopped' });
    expect(runHeadless).toHaveBeenCalledTimes(1);
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
    expect(listRecoveryRounds(store, id)).toEqual([]);
    expect(listProcessRuns(store, id)[0]).toMatchObject({
      processId: 'review',
      resultKind: 'interrupted',
      status: 'interrupted',
    });
  });

  // Residual-fix regression: an adapter that REJECTS on abort is a Stop — the
  // run must return stopped with the process interrupted, never a `ran` whose
  // AbortError was recorded as a crash (which would let a cancelled review
  // read as a verdict-deciding lane).
  it('an in-flight adapter rejection on abort is a Stop — interrupted process, no verdict, no round, no transition', async () => {
    const controller = new AbortController();
    const adapter: AgentAdapter = {
      ...findingsAgent('[]'),
      runHeadless: ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    };
    const pending = runReview(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir,
        manifest: manifest({}, { review: reviewConfig() }),
        signal: controller.signal,
      },
      deps({
        reviewProcess: {
          assignment: { agentName: 'Review Agent', provider: 'claude' },
          adapter,
        },
      }),
    );
    // Gates resolve in microtasks; the findings call hangs on the adapter, so
    // by the next macrotask it is in flight — aborting now rejects it mid-call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const res = await pending;
    expect(res).toEqual({ kind: 'stopped' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
    expect(listRecoveryRounds(store, id)).toEqual([]);
    expect(listProcessRuns(store, id)[0]).toMatchObject({
      processId: 'review',
      resultKind: 'interrupted',
      status: 'interrupted',
    });
  });
});

/**
 * R7 (independent signal) compares the identity `runReview` records for its own
 * gates against the identity `runUat` recorded for its. The rule everywhere
 * else in this file exercises `sameGateIdentity` against HANDCRAFTED
 * `recordGateRun` calls, which proves nothing about whether the two real
 * writers actually agree on what a "repo"/"command"/"args" is — that is
 * exactly the hazard Task 7 introduces (e.g. one writer recording a repository
 * NAME and the other a PATH would silently disable R7 while every handcrafted
 * test stayed green). These tests run BOTH stages through their real
 * orchestration code (`runUat` then `runReview`) against the same target and
 * assert on the resulting verdict, so a divergence between the writers would
 * fail here even though it fails nowhere else in this file.
 */
describe('runUat and runReview record identities R7 can actually compare (differential)', () => {
  let store: Store;
  let id: number;
  let uatArtifactDir: string;
  let reviewArtifactDir: string;

  const target = { repo: '/web', path: '/wt/web', names: ['web'] };

  function uatDeps(over: Partial<UatDeps> = {}): UatDeps {
    return {
      now,
      planTargets: async () => ({ kind: 'targets', targets: [target], unmapped: [] }),
      // UAT's own probe fallback list never includes `lint` — an explicit
      // `uat.gates: [lint]` (below) is what makes UAT run it, so the overlap
      // with review's own default probe list is deliberate config, not an
      // accident of what each stage happens to probe for.
      probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }),
      runGates: async (gates, _cwd, opts) => {
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

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    uatArtifactDir = mkdtempSync(join(tmpdir(), 'karst-uat-diff-'));
    reviewArtifactDir = mkdtempSync(join(tmpdir(), 'karst-review-diff-'));
  });
  afterEach(() => {
    store.close();
    rmSync(uatArtifactDir, { recursive: true, force: true });
    rmSync(reviewArtifactDir, { recursive: true, force: true });
  });

  it('review re-invoking the SAME command UAT ran is caught by R7, using each writer’s real identity', async () => {
    // UAT declares an explicit `lint` gate — its own probe fallback list never
    // includes it — so it records `npm run lint` against `/web` through its
    // own real code path (`resolveGates` -> `runGateList` -> `commitGateOutcome`).
    const uatRes = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir: uatArtifactDir,
        manifest: manifest({}, { uat: uatConfig({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] }) }),
      },
      uatDeps(),
    );
    expect(uatRes).toEqual({ kind: 'advanced', next: 'review' });

    // Review probes the SAME repository and finds the SAME `lint` script
    // through its own default probe list, so it too resolves to `npm run
    // lint` against `/web` — through ITS real code path, independently. If
    // either writer disagreed on what `repo` means (a name vs. a path) or
    // dropped `command`/`args`, this would silently pass instead of failing R7.
    const reviewRes = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir: reviewArtifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({ kind: 'targets', targets: [target], unmapped: [] }),
        probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }),
      }),
    );
    expect(reviewRes).toEqual({ kind: 'advanced', next: 'fix' });
    expect(reviewStage(store, id).verdict).toContain('review asked no question uat does not');

    // Confirm both writers actually recorded a rich, matching identity — not
    // that they degraded to name comparison by accident.
    const rows = listGateRuns(store, id);
    const uatRow = rows.find((r) => r.stageKey === 'uat')!;
    const reviewRow = rows.find((r) => r.stageKey === 'review')!;
    expect(uatRow.repo).toBe('/web');
    expect(uatRow.command).toBe('npm');
    expect(uatRow.args).toEqual(['run', 'lint']);
    expect(reviewRow.repo).toBe(uatRow.repo);
    expect(reviewRow.command).toBe(uatRow.command);
    expect(reviewRow.args).toEqual(uatRow.args);
  });

  it('review asking an ADDITIONAL question beyond UAT’s real invocation still passes', async () => {
    const uatRes = await runUat(
      store,
      {
        ticketId: id,
        cwd: '/wt/web',
        artifactDir: uatArtifactDir,
        manifest: manifest({}, { uat: uatConfig({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] }) }),
      },
      uatDeps(),
    );
    expect(uatRes).toEqual({ kind: 'advanced', next: 'review' });

    // Review's repository also defines `typecheck`, which UAT never runs —
    // one real independent question is enough to satisfy R7.
    const reviewRes = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir: reviewArtifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({ kind: 'targets', targets: [target], unmapped: [] }),
        probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }),
      }),
    );
    expect(reviewRes).toEqual({ kind: 'advanced', next: 'ship' });
  });
});
