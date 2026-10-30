import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket, getTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { parkGateStage, stageBlock, clearStageBlock } from '../../store/stageBlocks.js';
import { openStageRun, latestStageRun } from '../../store/stageRuns.js';
import { formatId } from '../../model/entityId.js';
import { makeTesterSkipActions, decideTesterSkip } from './testerSkipOps.js';

function parked(kind = 'tester-skipped') {
  const store = openStore(':memory:');
  const t = createTicket(store, { key: 'SK-1', title: 'skipped' });
  setStage(store, t.id, 'uat', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
  parkGateStage(store, { ticketId: t.id, stageKey: 'uat', kind: kind as never, reason: 'tester observed nothing — x', runAt: '2026-08-09T10:33:42.000Z', gates: [] });
  store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('uat', t.id);
  const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
  const redrive = vi.fn();
  const refresh = vi.fn();
  const debug = vi.fn();
  return { store, id: t.id, notify, redrive, refresh, debug, deps: { store, ticketId: t.id, notify, redrive, refresh, debug } };
}

describe('tester-skipped actions', () => {
  it('Re-run clears the block and redrives', () => {
    const p = parked();
    expect(decideTesterSkip(p.deps, 'rerun')).toBe('rerun');
    expect(stageBlock(p.store, p.id, 'uat')).toBeFalsy();
    expect(p.redrive).toHaveBeenCalledWith(p.id);
  });

  it('Accept commits a passed UAT verdict and clears the block', () => {
    const p = parked();
    expect(decideTesterSkip(p.deps, 'accept')).toBe('accept');
    expect(stageBlock(p.store, p.id, 'uat')).toBeFalsy();
    expect(getTicket(p.store, p.id).stageCurrent).toBe('review');
    expect(p.notify.info).toHaveBeenCalledWith(expect.stringContaining('uat: tester skip accepted by user'));
    expect(p.redrive).toHaveBeenCalledWith(p.id);
  });

  it.each(['rerun', 'accept'] as const)('%s refuses when UAT is parked on another block', (request) => {
    const p = parked('boot-failed');
    expect(decideTesterSkip(p.deps, request)).toBe('refused');
    expect(stageBlock(p.store, p.id, 'uat')?.kind).toBe('boot-failed');
    expect(p.notify.warn).toHaveBeenCalled();
    expect(p.redrive).not.toHaveBeenCalled();
  });

  it('the bound actions act then repaint', () => {
    const p = parked();
    const actions = makeTesterSkipActions(p.deps);
    actions.testerSkippedAccept();
    expect(p.refresh).toHaveBeenCalledWith(p.id);
    expect(getTicket(p.store, p.id).stageCurrent).toBe('review');
  });

  it('the bound re-run clears the block then repaints', () => {
    const p = parked();
    makeTesterSkipActions(p.deps).testerSkippedRerun();
    expect(stageBlock(p.store, p.id, 'uat')).toBeFalsy();
    expect(getTicket(p.store, p.id).stageCurrent).toBe('uat');
    expect(p.refresh).toHaveBeenCalledWith(p.id);
  });

  it('closes the open UAT stage run on accept', () => {
    const p = parked();
    const run = openStageRun(p.store, { ticketId: p.id, stageKey: 'uat', attempt: 0, runAt: '2026-08-09T10:33:42.000Z', startedAt: '2026-08-09T10:00:00.000Z' });
    decideTesterSkip(p.deps, 'accept');
    expect(latestStageRun(p.store, p.id, 'uat')).toMatchObject({ id: run, status: 'finished' });
  });

  it('names the ticket and logs when it refuses', () => {
    const p = parked('boot-failed');
    decideTesterSkip(p.deps, 'accept');
    expect(p.notify.warn).toHaveBeenCalledWith(`${formatId('ticket', p.id)} is no longer waiting on a skipped tester.`);
    expect(p.debug).toHaveBeenCalledWith(`[gate] tester skip ticket ${p.id}: refused (not parked)`);
  });

  it('refuses when the ticket sits in another stage even with the block stored', () => {
    const p = parked();
    p.store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', p.id);
    expect(decideTesterSkip(p.deps, 'rerun')).toBe('refused');
    expect(stageBlock(p.store, p.id, 'uat')?.kind).toBe('tester-skipped');
  });

  it('refuses when UAT has no block at all', () => {
    const p = parked();
    clearStageBlock(p.store, p.id, 'uat');
    expect(decideTesterSkip(p.deps, 'accept')).toBe('refused');
    expect(p.redrive).not.toHaveBeenCalled();
  });

  it('logs what it did and keeps the stage artifact path on accept', () => {
    const p = parked();
    setStage(p.store, p.id, 'uat', { artifactPath: '/a/uat.log' });
    decideTesterSkip(p.deps, 'accept');
    expect(p.debug).toHaveBeenCalledWith(`[gate] tester skip ticket ${p.id}: uat: tester skip accepted by user`);
    expect(p.notify.info).toHaveBeenCalledWith(`${formatId('ticket', p.id)}: uat: tester skip accepted by user`);
    expect(getTicket(p.store, p.id).stages.find((s) => s.stageKey === 'uat')?.artifactPath).toBe('/a/uat.log');
  });

  it('logs the re-run', () => {
    const p = parked();
    decideTesterSkip(p.deps, 'rerun');
    expect(p.debug).toHaveBeenCalledWith(`[gate] tester skip ticket ${p.id}: re-running the tester`);
  });
});
