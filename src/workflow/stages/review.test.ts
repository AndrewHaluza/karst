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
import { stageBlock } from '../../store/stageBlocks.js';
import { latestStageRun } from '../../store/stageRuns.js';
import { openGateRun } from '../gates/evidence.js';
import { commitGateOutcome } from '../gates/commit.js';
import { manifest, uat as uatConfig, review as reviewConfig } from '../../manifest/fixtures.js';
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
    }),
    probe: () => ({ kind: 'ok', scripts: ALL_SCRIPTS }),
    runGates: async (gates) => ({
      kind: 'ran',
      results: gates.map((g) => ({
        name: g.name,
        exitCode: 0,
        output: 'ok',
        startedAt: now(),
        endedAt: now(),
      })),
    }),
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

  // R1. The old assertion here pinned the bug: a review touching zero
  // repositories used to ship as green. "Asked nothing" must reach a human.
  it('no target resolved -> blocks nothing-to-run, never passes', async () => {
    const runGates = vi.fn(deps().runGates!);
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [] }), runGates, openDiff }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(reviewStage(store, id).attempt).toBe(0);
    expect(stageBlock(store, id, 'review')?.kind).toBe('nothing-to-run');
    expect(runGates).not.toHaveBeenCalled();
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('names the ticket worktrees when none of them mapped to a manifest repository', async () => {
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/unmapped', '/wt/unmapped', 'b', 'develop', 'inherited')",
      )
      .run(id);
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [] }) }),
    );
    expect(res).toMatchObject({ reason: expect.stringContaining('/unmapped') });
  });

  it('says so plainly when the ticket has no worktree at all', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [] }) }),
    );
    expect(res).toMatchObject({ reason: expect.stringContaining('no worktree') });
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
  // "nothing to review".
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
    const empty = await runReview(
      store,
      { ticketId: id2, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({ planTargets: async () => ({ kind: 'targets', targets: [] }) }),
    );
    expect(empty).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
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
        }),
        probe: (cwd) =>
          cwd === '/wt/web'
            ? { kind: 'ok', scripts: { lint: 'eslint .' } }
            : { kind: 'io-error', message: 'EACCES' },
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now() })),
        }),
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
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: null, output: 'nothing to run' })),
        }),
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
        runGates: async () => ({
          kind: 'stopped',
          results: [{ name: 'lint', exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() }],
        }),
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
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
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
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [
            { repo: '/web', path: '/wt/web', names: ['web'] },
            { repo: '/api', path: '/wt/api', names: ['api'] },
          ],
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

  it('opens the changes surface on a failing verdict too', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
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
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g, i) =>
            i === 0
              ? {
                  name: g.name,
                  exitCode: 0,
                  output: 'ok',
                  startedAt: '2026-07-20T12:00:00.000Z',
                  endedAt: '2026-07-20T12:00:06.400Z',
                }
              : { name: g.name, exitCode: null, output: 'nothing to run' },
          ),
        }),
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

  it('parks, naming the disable, when every review gate is disabled', async () => {
    setDisabledGates(store, id, 'review', ['lint', 'typecheck', 'build', 'format:check']);
    const result = await runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(result).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    if (result.kind !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toContain('disabled by user');
    expect(getTicket(store, id).stageCurrent).toBe('review');
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
  it("threads the worktree's base ref into the findings prompt", async () => {
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/web', '/wt/web', 'b', 'develop', 'inherited')",
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
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(runHeadless).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toContain('develop');
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

  it('a garbage (unparseable) agent response still reaches a gate-based verdict', async () => {
    const res = await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ findingsAdapter: findingsAgent('sure, looks fine to me!') }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
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
    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
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
      planTargets: async () => ({ kind: 'targets', targets: [target] }),
      // UAT's own probe fallback list never includes `lint` — an explicit
      // `uat.gates: [lint]` (below) is what makes UAT run it, so the overlap
      // with review's own default probe list is deliberate config, not an
      // accident of what each stage happens to probe for.
      probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }),
      runGates: async (gates) => ({
        kind: 'ran',
        results: gates.map((g) => ({
          name: g.name,
          exitCode: 0,
          output: 'ok',
          startedAt: now(),
          endedAt: now(),
        })),
      }),
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
        planTargets: async () => ({ kind: 'targets', targets: [target] }),
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
        planTargets: async () => ({ kind: 'targets', targets: [target] }),
        probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }),
      }),
    );
    expect(reviewRes).toEqual({ kind: 'advanced', next: 'ship' });
  });
});
