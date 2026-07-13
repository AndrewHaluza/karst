import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { runReview, type GateRunner } from './review.js';

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
});
