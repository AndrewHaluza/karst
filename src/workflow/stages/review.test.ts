import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { runReview, type GateRunner } from './review.js';
import { listGateRuns } from '../../store/gateRuns.js';

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
    const gates: GateRunner = async () => [
      { name: 'lint', exitCode: null, output: 'no "lint" script in package.json' },
    ];
    const res = await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);
    expect(readFileSync(res.artifactPath, 'utf8')).toContain('# lint (skipped)');
  });

  it('opens the diff for the human regardless of verdict', async () => {
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, PASS_GATES, openDiff as never);
    expect(openDiff).toHaveBeenCalledWith(id, '/wt');
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
    expect(runs.map((r) => r.gateName)).toEqual(['lint', 'typecheck', 'test']);
    expect(runs.every((r) => r.stageKey === 'review')).toBe(true);
    expect(new Set(runs.map((r) => r.runAt)).size).toBe(1); // one invocation, one batch
  });

  it('files a failing run under the attempt it ran as, not the one its failure creates', async () => {
    // `transition` increments `attempt` on the failed branch. The gates belong to
    // the run that produced the failure, so they must be read before that bump.
    const gates: GateRunner = async () => [{ name: 'test', exitCode: 1, output: 'boom' }];
    await runReview(store, { ticketId: id, cwd: '/wt', artifactDir }, gates, openDiff as never);

    expect(listGateRuns(store, id).map((r) => r.attempt)).toEqual([0]);
    const review = getTicket(store, id).stages.find((s) => s.stageKey === 'review');
    expect(review?.attempt).toBe(1);
  });

  it('records a skipped gate as null, never as a pass', async () => {
    const gates: GateRunner = async () => [
      { name: 'lint', exitCode: null, output: 'no "lint" script in package.json' },
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
});
