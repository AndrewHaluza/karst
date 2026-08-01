import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { runReview, makeGateRunner, ReviewAskedNothingError, type GateRunner } from './review.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { manifest, runnableRepo, dependsOn } from '../../manifest/fixtures.js';
import type { GitRunner } from '../../integrations/git.js';

function walkToReview(store: Store, id: number): void {
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
  transition(store, id, 'uat', { kind: 'passed' });
}

const PASS_GATES: GateRunner = async () => [
  { name: 'lint', exitCode: 0, output: 'ok' },
  { name: 'typecheck', exitCode: 0, output: 'ok' },
  { name: 'test', exitCode: 0, output: 'ok' },
];

describe('runReview', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;
  let openDiff: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    walkToReview(store, id);
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-review-'));
    openDiff = vi.fn();
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('passes only when lint AND typecheck AND tests all exit 0 -> ship', async () => {
    const res = await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, PASS_GATES, openDiff as never);
    expect(res.verdict).toEqual({ kind: 'passed' });
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('a single nonzero gate -> failed -> fix', async () => {
    const gates: GateRunner = async () => [
      { name: 'lint', exitCode: 1, output: 'lint error' },
      { name: 'typecheck', exitCode: 0, output: 'ok' },
      { name: 'test', exitCode: 0, output: 'ok' },
    ];
    const res = await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);
    expect(res.verdict.kind).toBe('failed');
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });

  it('a gate the repo cannot answer is skipped, never counted as a failure', async () => {
    // Regression: karst ran `npm run lint` in a repo with no lint script, read the
    // "Missing script" exit 1 as "the code is bad", and parked the ticket at fix —
    // a loop no agent can win, because there is nothing in the code to fix.
    const gates: GateRunner = async () => [
      { name: 'lint', exitCode: null, output: 'no "lint" script in package.json' },
      { name: 'typecheck', exitCode: 0, output: 'ok' },
      { name: 'test', exitCode: 0, output: 'ok' },
    ];
    const res = await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);
    expect(res.verdict).toEqual({ kind: 'passed' });
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('a skipped gate never hides a real failure', async () => {
    const gates: GateRunner = async () => [
      { name: 'lint', exitCode: null, output: 'no "lint" script in package.json' },
      { name: 'typecheck', exitCode: 0, output: 'ok' },
      { name: 'test', exitCode: 1, output: '2 failed' },
    ];
    const res = await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);
    expect(res.verdict).toEqual({ kind: 'failed', reason: 'gates failed: test' });
  });

  it('the artifact says a gate was skipped rather than claiming it passed', async () => {
    // A skipped gate alongside one that ran — an all-skipped run is its own
    // case (`ReviewAskedNothingError`, see below), so this fixture keeps one
    // gate answered to isolate the artifact-formatting behavior under test.
    const gates: GateRunner = async () => [
      { name: 'lint', exitCode: null, output: 'no "lint" script in package.json' },
      { name: 'typecheck', exitCode: 0, output: 'ok' },
    ];
    const res = await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);
    expect(readFileSync(res.artifactPath, 'utf8')).toContain('# lint (skipped)');
  });

  it('opens the diff for the human regardless of verdict', async () => {
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, PASS_GATES, openDiff as never);
    expect(openDiff).toHaveBeenCalledWith(id, '/wt');
  });

  it('records the changes surface as evidence only when a real openDiff opened it', async () => {
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, PASS_GATES, openDiff as never);
    const runs = listGateRuns(store, id);
    // Named 'changes', not 'diff': the host implementation reveals the
    // Changes panel, not a diff editor — the evidence must say what ran.
    expect(runs.find((r) => r.gateName === 'changes')).toMatchObject({ exitCode: 0, stageKey: 'review' });
  });

  it('records no changes evidence when nothing was wired to open it', async () => {
    // `openDiff` absent — as it is for any caller (a test, a future CLI path)
    // that supplies no host implementation. The recorded evidence must not
    // claim a surface opened that nothing performed.
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, PASS_GATES);
    const runs = listGateRuns(store, id);
    expect(runs.find((r) => r.gateName === 'changes')).toBeUndefined();
  });

  it('writes the combined gate output to an artifact and records its path', async () => {
    const res = await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, PASS_GATES, openDiff as never);
    const contents = readFileSync(res.artifactPath, 'utf8');
    expect(contents).toContain('lint');
    expect(contents).toContain('typecheck');
    const review = getTicket(store, id).stages.find((s) => s.stageKey === 'review');
    expect(review?.artifactPath).toBe(res.artifactPath);
  });

  it('records one gate row per gate, in the order the runner reported them', async () => {
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, PASS_GATES, openDiff as never);
    const runs = listGateRuns(store, id);
    // 'changes' is its own evidence row (recorded because `openDiff` is wired
    // in this suite's beforeEach), appended after the REVIEW_GATES-driven ones.
    expect(runs.map((r) => r.gateName)).toEqual(['lint', 'typecheck', 'test', 'changes']);
    expect(runs.every((r) => r.stageKey === 'review')).toBe(true);
    expect(new Set(runs.map((r) => r.runAt)).size).toBe(1); // one invocation, one batch
  });

  it('files a failing run under the attempt it ran as, not the one its failure creates', async () => {
    // `transition` increments `attempt` on the failed branch. The gates belong to
    // the run that produced the failure, so they must be read before that bump.
    // Same for the 'changes' row — the changes surface opens on every
    // verdict, and it must be filed under the SAME pre-bump attempt as the
    // gate that failed alongside it.
    const gates: GateRunner = async () => [{ name: 'test', exitCode: 1, output: 'boom' }];
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);

    expect(listGateRuns(store, id).map((r) => r.attempt)).toEqual([0, 0]);
    const review = getTicket(store, id).stages.find((s) => s.stageKey === 'review');
    expect(review?.attempt).toBe(1);
  });

  it('records a skipped gate as null, never as a pass', async () => {
    // Same reasoning as above: keep one gate answered so this exercises a
    // *mixed* skip, not the all-skipped case `ReviewAskedNothingError` covers.
    const gates: GateRunner = async () => [
      { name: 'lint', exitCode: null, output: 'no "lint" script in package.json' },
      { name: 'typecheck', exitCode: 0, output: 'ok' },
    ];
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);
    expect(listGateRuns(store, id)[0]!.exitCode).toBeNull();
  });

  it('stores the timings a gate reports and leaves a skipped gate without any', async () => {
    const gates: GateRunner = async () => [
      {
        name: 'lint',
        exitCode: 0,
        output: 'ok',
        startedAt: '2026-07-20T12:00:00.000Z',
        endedAt: '2026-07-20T12:00:06.400Z',
      },
      { name: 'test', exitCode: null, output: 'no "test" script in package.json' },
    ];
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);
    const [lint, test] = listGateRuns(store, id);
    expect(lint!.startedAt).toBe('2026-07-20T12:00:00.000Z');
    expect(lint!.endedAt).toBe('2026-07-20T12:00:06.400Z');
    // A gate that never ran has no duration; inventing one would read as a
    // zero-length run rather than as "karst had nothing to ask".
    expect(test!.startedAt).toBeNull();
    expect(test!.endedAt).toBeNull();
  });

  it('refuses to pass when every gate was skipped', async () => {
    // G1: a run whose gates are all `null` learned nothing about the ticket's
    // code and must not report a green verdict.
    const gates: GateRunner = async () => [
      { name: 'lint', exitCode: null, output: 'no "lint" script in package.json' },
      { name: 'typecheck', exitCode: null, output: 'no "typecheck" script in package.json' },
      { name: 'test', exitCode: null, output: 'no "test" script in package.json' },
    ];
    await expect(
      runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never),
    ).rejects.toThrow(ReviewAskedNothingError);
    expect(getTicket(store, id).stageCurrent).toBe('review'); // never advanced
    expect(listGateRuns(store, id)).toEqual([]); // no evidence for a run that asked nothing
  });

  it('fails, rather than skips, when package.json is malformed', async () => {
    // G2: `readPackageScripts` used to collapse a malformed package.json into
    // `{}` — the same answer as "no scripts defined" — so a repository defect
    // an agent could actually fix silently skipped every gate instead of
    // failing. `probeScripts` distinguishes the two; review must surface it.
    const cwd = mkdtempSync(join(tmpdir(), 'karst-review-malformed-'));
    writeFileSync(join(cwd, 'package.json'), '{ not json');
    try {
      const res = await runReview(
        store,
        { ticketId: id, cwd, artifactDir },
        makeGateRunner(),
        openDiff as never,
      );
      expect(res.verdict.kind).toBe('failed');
      expect(res.gates).toEqual([
        expect.objectContaining({ name: 'package.json', exitCode: 1 }),
      ]);
      expect(getTicket(store, id).stageCurrent).toBe('fix');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('leaves no gate rows behind when the transition throws', async () => {
    // The gates are written inside the transition's transaction, so evidence and
    // verdict land together or not at all. Dropping the stage row makes the
    // machine throw *after* the premutate has queued the gates, which is exactly
    // the window a non-atomic write would leak through.
    store.db
      .prepare('DELETE FROM stages WHERE ticket_id = ? AND stage_key = ?')
      .run(id, 'review');

    await expect(
      runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, PASS_GATES, openDiff as never),
    ).rejects.toThrow(/has no stage 'review'/);

    expect(listGateRuns(store, id)).toEqual([]);
    expect(getTicket(store, id).stageCurrent).toBe('review'); // no advance either
  });

  describe('repository-aware triggers', () => {
    const project = manifest({
      api: runnableRepo({}, { repoPath: '/repos/api' }),
      web: runnableRepo(
        { dependsOn: [dependsOn('api', 'http', [{ env: 'API', template: '{port}' }])] },
        { repoPath: '/repos/web' },
      ),
      docs: runnableRepo({}, { repoPath: '/repos/docs' }),
    });

    function seed(repo: string, path: string): void {
      store.db
        .prepare(
          `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
           VALUES (?, ?, ?, 'karst/x', 'develop', 'inherited')`,
        )
        .run(id, repo, path);
    }

    function changed(...paths: string[]): GitRunner {
      return async (args, cwd) => ({
        stdout: '',
        stderr: '',
        exitCode: args[0] === 'diff' && paths.includes(cwd) ? 1 : 0,
      });
    }

    it('refuses to pass when no target resolved', async () => {
      // OLD ASSERTION (pinned the bug, G1): this test used to assert
      // `result.verdict` equalled `{ kind: 'passed' }` with the runner never
      // called — i.e. it locked in that a review touching zero repositories
      // ships as green. That is exactly the vacuous pass this task closes:
      // "asked nothing" must never read as "passed".
      seed('/repos/api', '/wt/api');
      seed('/repos/web', '/wt/web');
      const runner = vi.fn(PASS_GATES);

      await expect(
        runReview(
          store,
          { ticketId: id, cwd: '/wt/api', artifactDir, manifest: project },
          runner,
          openDiff as never,
          changed(),
        ),
      ).rejects.toThrow(ReviewAskedNothingError);

      expect(runner).not.toHaveBeenCalled();
      expect(openDiff).not.toHaveBeenCalled();
      expect(getTicket(store, id).stageCurrent).toBe('review'); // never reached ship
    });

    // `selectReviewTargets` reports a git failure as `{kind:'unavailable', ...}`
    // rather than throwing (G4). Review has no `{kind:'blocked'}` path yet
    // (Task 6), so it re-throws with the same message a caller would have seen
    // before this task — carrying the failure OUT of the stage exactly as
    // before, rather than silently treating "could not ask" as "nothing
    // changed" and passing vacuously.
    it('re-throws a git failure with the same message, rather than passing vacuously', async () => {
      seed('/repos/api', '/wt/api');
      const runner = vi.fn(PASS_GATES);
      const failing: GitRunner = async (args) => ({
        stdout: '',
        stderr: args[0] === 'status' ? '' : 'baseline unavailable',
        exitCode: args[0] === 'status' ? 0 : 128,
      });

      await expect(
        runReview(
          store,
          { ticketId: id, cwd: '/wt/api', artifactDir, manifest: project },
          runner,
          openDiff as never,
          failing,
        ),
      ).rejects.toThrow(/cannot determine review changes.*baseline unavailable/);

      expect(runner).not.toHaveBeenCalled();
      expect(openDiff).not.toHaveBeenCalled();
      expect(listGateRuns(store, id)).toEqual([]);
      expect(getTicket(store, id).stageCurrent).toBe('review'); // parked, not passed
    });

    it('checks a directly changed repo and each relation-impacted dependent only', async () => {
      seed('/repos/api', '/wt/api');
      seed('/repos/web', '/wt/web');
      seed('/repos/docs', '/wt/docs');
      const runner = vi.fn(PASS_GATES);

      await runReview(
        store,
        { ticketId: id, cwd: '/wt/api', artifactDir, manifest: project },
        runner,
        openDiff as never,
        changed('/wt/api'),
      );

      expect(runner.mock.calls.map(([cwd]) => cwd)).toEqual(['/wt/api', '/wt/web']);
      expect(runner).not.toHaveBeenCalledWith('/wt/docs');
      expect(openDiff.mock.calls.map((call) => call[1])).toEqual(['/wt/api', '/wt/web']);
    });
  });
});
