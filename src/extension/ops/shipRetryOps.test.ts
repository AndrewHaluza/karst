import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import type { GitResult } from '../../integrations/git.js';
import type { CiActionsInput } from './ciActionsWiring.js';
import { ShipDrainingError } from './reloadWhenIdle.js';
import { makeRetryShip, makeShipRetrySeams } from './shipRetryOps.js';

let store: Store;
let id: number;

const gitResult = (exitCode: number, stdout = ''): GitResult => ({ exitCode, stdout, stderr: '' });

function worktree(repo: string, path: string): void {
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, repo, path, 'b');
}

const input = (git: CiActionsInput['git']): CiActionsInput => ({ git }) as unknown as CiActionsInput;

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'SR-2', title: 't' }).id;
});

describe('makeShipRetrySeams', () => {
  it('reports the worktree clean only when git exits 0 with empty porcelain', async () => {
    worktree('r', '/w/r');
    const git = vi.fn(async () => gitResult(0, ''));
    const seams = makeShipRetrySeams({ store, ticketId: id, ciInput: () => input(git as never) });
    await expect(seams.worktreeClean('r')).resolves.toEqual({ ok: true, clean: true });
    expect(git).toHaveBeenCalledWith(['status', '--porcelain', '-uall'], '/w/r');

    const dirty = makeShipRetrySeams({ store, ticketId: id, ciInput: () => input(vi.fn(async () => gitResult(0, ' M a.ts\n')) as never) });
    await expect(dirty.worktreeClean('r')).resolves.toEqual({ ok: true, clean: false });
  });

  it('is unreadable for an unknown repo or a git that fails', async () => {
    worktree('r', '/w/r');
    const failing = makeShipRetrySeams({ store, ticketId: id, ciInput: () => input(vi.fn(async () => gitResult(2, '')) as never) });
    await expect(failing.worktreeClean('r')).resolves.toEqual({ ok: false });
    const seams = makeShipRetrySeams({ store, ticketId: id, ciInput: () => input(vi.fn() as never) });
    await expect(seams.worktreeClean('gone')).resolves.toEqual({ ok: false });
  });

  it('reads the HEAD of the repo worktree, or null when it has none', async () => {
    worktree('r', '/w/r');
    const git = vi.fn(async () => gitResult(0, 'a'.repeat(40) + '\n'));
    const seams = makeShipRetrySeams({ store, ticketId: id, ciInput: () => input(git as never) });
    await expect(seams.localHead('r')).resolves.toBe('a'.repeat(40));
    await expect(seams.localHead('gone')).resolves.toBeNull();
  });
});

describe('makeRetryShip', () => {
  const deps = (runShip: () => Promise<void>, debug = vi.fn()) => ({ runShip, debug, label: 'T1' });

  it('reports sent when the saga ran', async () => {
    const runShip = vi.fn(async () => {});
    await expect(makeRetryShip(deps(runShip))(['r'])).resolves.toEqual({ kind: 'sent' });
    expect(runShip).toHaveBeenCalledWith(['r']);
  });

  it('reports busy while the host drains, so the next tick retries', async () => {
    const debug = vi.fn();
    const runShip = vi.fn(async () => { throw new ShipDrainingError(); });
    await expect(makeRetryShip(deps(runShip, debug))(['r'])).resolves.toEqual({ kind: 'busy' });
    expect(debug).not.toHaveBeenCalled();
  });

  it('reports sent for a failed ship: the saga recorded it on the stage and opened its run', async () => {
    const debug = vi.fn();
    const runShip = vi.fn(async () => { throw new Error('ship failed for 1 repo(s)'); });
    await expect(makeRetryShip(deps(runShip, debug))(['r'])).resolves.toEqual({ kind: 'sent' });
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket T1: the ship retry ended (ship failed for 1 repo(s))');
  });
});
