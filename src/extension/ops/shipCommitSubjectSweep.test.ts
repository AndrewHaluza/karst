import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { openShipRun, recordShipCommit, type ShipCommitOrigin } from '../../store/shipRuns.js';
import type { GitRunner } from '../../integrations/git.js';
import { runShipCommitSubjectSweep } from './bootSweeps.js';

describe('runShipCommitSubjectSweep', () => {
  let store: Store;
  let root: string;
  let repoA: string;
  let runId: number;
  const debug = vi.fn();
  const logError = vi.fn();

  beforeEach(() => {
    store = openStore(':memory:');
    root = mkdtempSync(join(tmpdir(), 'karst-sweep-'));
    repoA = join(root, 'repoA');
    mkdirSync(repoA);
    const ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    runId = openShipRun(store, { ticketId, attempt: 1, startedAt: '2026-08-08T10:00:00.000Z' }).id;
    debug.mockClear();
    logError.mockClear();
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const add = (repo: string, sha: string, message: string, origin: ShipCommitOrigin = 'before-ship') =>
    recordShipCommit(store, { shipRunId: runId, repo, sha, message, origin });
  const messages = (): string[] =>
    (store.db.prepare('SELECT message FROM ship_commits ORDER BY id').all() as { message: string }[]).map(
      (r) => r.message,
    );
  // Fake git: `git show -s --format=%s <sha>^{commit}` answers from a map.
  const gitWith = (known: Record<string, string>): GitRunner =>
    vi.fn(async (args: string[]) => {
      const sha = (args[args.length - 1] ?? '').replace('^{commit}', '');
      const subject = known[sha];
      return subject === undefined
        ? { stdout: '', stderr: 'fatal: bad object', exitCode: 128 }
        : { stdout: `${subject}\n`, stderr: '', exitCode: 0 };
    });
  const run = (git: GitRunner) =>
    runShipCommitSubjectSweep({ store, globalStorageRoot: root, git, debug, logError });

  it('fills an empty before-ship row, also for the trailing-slash form of the path', async () => {
    add(repoA, 'a1', '');
    add(`${repoA}/`, 'a2', '');
    await run(gitWith({ a1: 'first', a2: 'second' }));
    expect(messages()).toEqual(['first', 'second']);
  });

  it('leaves a created-by-ship row and a row that has a message unchanged', async () => {
    add(repoA, 'a1', '', 'created-by-ship');
    add(repoA, 'a2', 'kept');
    await run(gitWith({ a1: 'git-a1', a2: 'git-a2' }));
    expect(messages()).toEqual(['', 'kept']);
  });

  it('skips a missing path and a missing sha, leaves them blank, and still fills the rest', async () => {
    add(join(root, 'gone'), 'g1', '');
    add(repoA, 'missing', '');
    add(repoA, 'ok', '');
    await run(gitWith({ ok: 'fine' }));
    expect(messages()).toEqual(['', '', 'fine']);
    expect(debug).toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('runs once: a later boot makes no git call', async () => {
    add(repoA, 'a1', '');
    await run(gitWith({ a1: 'first' }));
    add(repoA, 'a2', '');
    const second = gitWith({ a2: 'second' });
    await run(second);
    expect(second).not.toHaveBeenCalled();
    expect(messages()).toEqual(['first', '']);
  });

  it('does not throw and does not record completion when the store read fails', async () => {
    const broken = { db: { prepare: () => { throw new Error('boom'); } } } as unknown as Store;
    const git = gitWith({});
    await expect(
      runShipCommitSubjectSweep({ store: broken, globalStorageRoot: root, git, debug, logError }),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
    add(repoA, 'a1', '');
    await run(gitWith({ a1: 'later' }));
    expect(messages()).toEqual(['later']);
  });
});
