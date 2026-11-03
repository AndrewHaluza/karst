import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { divergedReason } from '../../workflow/stages/shipPushRecovery.js';
import { decidePushDiverged, makePushDivergedActions } from './pushDivergedOps.js';

const REPO = '/repo/frontend';

function parked(kind = 'push-diverged') {
  const store = openStore(':memory:');
  const t = createTicket(store, { key: 'PD-1', title: 'diverged' });
  store.db
    .prepare(`INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, ?, '/p', 'karst/x', 'develop', 'inherited')`)
    .run(t.id, REPO);
  setStage(store, t.id, 'ship', {
    status: 'pending',
    verdict: null,
    endedAt: null,
    blockedKind: kind as never,
    blockedReason: divergedReason(REPO, 'karst/x', 'c'.repeat(40), [{ sha: 'abc1234', subject: 'fix: theirs' }]),
    blockedAt: '2026-10-30T10:00:00.000Z',
  });
  store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('ship', t.id);
  const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
  const runShip = vi.fn();
  const redrive = vi.fn();
  const refresh = vi.fn();
  const handOff = vi.fn((_p: string): string | null => null);
  return { store, id: t.id, notify, runShip, redrive, refresh, handOff, deps: { store, ticketId: t.id, notify, runShip, redrive, refresh, handOff } };
}

const leaseFlag = (p: ReturnType<typeof parked>) =>
  (p.store.db.prepare('SELECT needs_force_push AS f FROM worktrees WHERE ticket_id = ?').get(p.id) as { f: number | null }).f;

describe('push-diverged actions', () => {
  it('Overwrite arms the lease for the diverged repo, clears the block and re-runs ship', () => {
    const p = parked();
    expect(decidePushDiverged(p.deps, 'overwrite')).toBe('overwrite');
    expect(leaseFlag(p)).toBe(1);
    expect(stageBlock(p.store, p.id, 'ship')).toBeFalsy();
    expect(p.runShip).toHaveBeenCalledWith(p.id);
  });

  it('Integrate sends the ticket back to Implement and redrives', () => {
    const p = parked();
    expect(decidePushDiverged(p.deps, 'integrate')).toBe('integrate');
    expect(leaseFlag(p)).toBeNull();
    expect(p.store.db.prepare('SELECT stage_current AS s FROM tickets WHERE id = ?').get(p.id)).toEqual({ s: 'impl' });
    expect(p.redrive).toHaveBeenCalledWith(p.id);
    expect(p.handOff).toHaveBeenCalledOnce();
    expect(p.handOff.mock.calls[0]![0]).toContain('merge origin/');
    expect(p.notify.warn).not.toHaveBeenCalled();
  });
  it('Integrate warns that no session started when the hand-off refuses', () => {
    const p = parked();
    p.handOff.mockReturnValue('the ticket is paused.');
    expect(decidePushDiverged(p.deps, 'integrate')).toBe('integrate');
    expect(p.notify.warn).toHaveBeenCalledWith(expect.stringContaining('No session was started: the ticket is paused.'));
  });

  it.each(['overwrite', 'integrate'] as const)('%s refuses when ship is parked on another block', (request) => {
    const p = parked('boot-failed');
    expect(decidePushDiverged(p.deps, request)).toBe('refused');
    expect(leaseFlag(p)).toBeNull();
    expect(p.notify.warn).toHaveBeenCalled();
    expect(p.runShip).not.toHaveBeenCalled();
    expect(p.redrive).not.toHaveBeenCalled();
  });

  it('the bound actions act then repaint', () => {
    const p = parked();
    makePushDivergedActions(p.deps).pushDivergedOverwrite();
    expect(p.refresh).toHaveBeenCalledWith(p.id);
    expect(leaseFlag(p)).toBe(1);
  });
});
