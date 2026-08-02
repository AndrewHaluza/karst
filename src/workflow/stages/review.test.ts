import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { listGateRuns, recordGateRun } from '../../store/gateRuns.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { manifest, uat as uatConfig } from '../../manifest/fixtures.js';
import { runReview, type OpenDiff, type ReviewDeps } from './review.js';
import { runUat, type UatDeps } from './uat.js';

const now = (): string => '2026-08-01T10:00:00.000Z';

/** A repository that answers every review gate. */
const ALL_SCRIPTS = {
  lint: 'eslint .',
  typecheck: 'tsc --noEmit',
  build: 'tsc -b',
  format: 'prettier --check .',
};

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
      'format (/wt/web)',
    ]);
    expect(listGateRuns(store, id).every((r) => r.stageKey === 'review')).toBe(true);
    expect(new Set(listGateRuns(store, id).map((r) => r.runAt)).size).toBe(1);
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
      'format (web)',
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

  it('leaves no gate rows behind when the transition throws', async () => {
    // Evidence is written inside the transition's transaction, so it and the
    // verdict land together or not at all. Dropping the stage row makes the
    // machine throw AFTER the premutate queued the gates — exactly the window a
    // non-atomic write would leak through.
    store.db.prepare('DELETE FROM stages WHERE ticket_id = ? AND stage_key = ?').run(id, 'review');
    await expect(
      runReview(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps()),
    ).rejects.toThrow(/has no stage 'review'/);
    expect(listGateRuns(store, id)).toEqual([]);
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
