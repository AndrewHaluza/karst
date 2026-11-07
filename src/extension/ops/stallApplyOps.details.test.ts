import { describe, it, expect, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, setStageCurrent, updateTicketFields } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { recordFindings } from '../../store/reviewFindings.js';
import { openRecoveryRound, failRevalidationForStall } from '../../store/recoveryRounds.js';
import { listRecoveryRounds } from '../../store/recoveryRoundsRead.js';
import { applyStallOption, type StallApplyDeps } from './stallApplyOps.js';

const T0 = '2026-01-01T00:00:00.000Z';
const AT = '2026-01-02T00:00:00.000Z';

function parked(): { store: Store; ticketId: number } {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'ST-1', title: 't' }).id;
  updateTicketFields(store, ticketId, { description: 'old desc', intent: 'old check' });
  setStageCurrent(store, ticketId, 'fix');
  setStage(store, ticketId, 'review', { status: 'failed', verdict: 'review findings', attempt: 3, endedAt: T0, artifactPath: '/art/review.md' });
  recordFindings(store, { ticketId, attempt: 3, runAt: T0, findings: [{ severity: 'high', repo: '', file: 'docs/a.md', title: 'claim', detail: 'd', source: 'agent' }] });
  const trigger = {
    ticketId, sourceStage: 'review' as const, sourceProcessId: 'review' as const, sourceStageRunId: null, sourceProcessRunId: null,
    triggerKind: 'blocking-review-findings' as const, triggerDetail: 'x', maxRounds: 5, startedAt: T0,
  };
  openRecoveryRound(store, trigger);
  failRevalidationForStall(store, trigger);
  setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'stalled', endedAt: T0, blockedKind: 'review-stalled', blockedReason: 'same files', blockedAt: T0 });
  return { store, ticketId };
}

function mk(store: Store, ticketId: number, over: Partial<StallApplyDeps> = {}) {
  const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
  const debug = vi.fn();
  const deps: StallApplyDeps = { store, ticketId, notify, redrive: vi.fn(), refresh: vi.fn(), diffFiles: async () => ['docs/a.md'], maxRounds: () => 7, blockingSeverity: () => 'medium' as const, now: () => AT, debug, ...over };
  return { deps, notify, debug };
}

describe('applyStallOption — details', () => {
  it('trims the stored fields and opens a round that names the option and uses the cap', async () => {
    const { store, ticketId } = parked();
    const { deps, notify } = mk(store, ticketId);
    await applyStallOption(deps, { kind: 'agent', label: 'Cut scope', note: ' n ', description: '  new desc  ', acceptanceCheck: '  new check ' });
    const t = getTicket(store, ticketId);
    expect(t.description).toBe('new desc');
    expect(t.intent).toBe('new check');
    const last = listRecoveryRounds(store, ticketId).at(-1)!;
    expect(last.triggerKind).toBe('blocking-review-findings');
    expect(last.triggerDetail).toBe('stall option applied: Cut scope');
    expect(last.sourceProcessId).toBe('review');
    expect(last.startedAt).toBe(AT);
    expect(last.maxRounds).toBe(7);
    expect(notify.info).toHaveBeenCalledWith(expect.stringContaining('stall answered — "Cut scope". A fix round opens.'));
  });

  it('keeps one field when only the other changes', async () => {
    const { store, ticketId } = parked();
    await applyStallOption(mk(store, ticketId).deps, { kind: 'agent', label: 'l', note: 'n', acceptanceCheck: 'only check' });
    expect(getTicket(store, ticketId).description).toBe('old desc');
    expect(getTicket(store, ticketId).intent).toBe('only check');
  });

  it('explains a refusal in the warning and the debug log', async () => {
    const { store, ticketId } = parked();
    const { deps, notify, debug } = mk(store, ticketId);
    const res = await applyStallOption(deps, { kind: 'agent', label: 'l', note: ' ' });
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).not.toBe('');
    expect(notify.warn).toHaveBeenCalledWith(expect.stringContaining(res.reason));
    expect(notify.warn.mock.calls[0]![0]).toMatch(/^\S+: /);
    expect(debug).toHaveBeenCalledWith(`[stall] apply ticket ${ticketId}: refused (${res.reason})`);
  });

  it('accept: keeps the artifact path and the cap-free state, and reports the open count', async () => {
    const { store, ticketId } = parked();
    const { deps, notify, debug } = mk(store, ticketId);
    await applyStallOption(deps, { kind: 'accept-docs', label: 'Accept', note: 'n' });
    const review = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'review')!;
    expect(review.status).toBe('passed');
    expect(review.artifactPath).toBe('/art/review.md');
    const fix = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
    expect(fix.status).toBe('pending');
    expect(fix.attempt).toBe(0);
    expect(fix.startedAt).toBeNull();
    expect(fix.endedAt).toBeNull();
    expect(notify.info).toHaveBeenCalledWith(expect.stringContaining('report accepted with 1 open blocking finding(s). They stay unfixed.'));
    expect(debug).toHaveBeenCalled();
  });

  it('accept without a debug seam still passes review', async () => {
    const { store, ticketId } = parked();
    const { deps } = mk(store, ticketId);
    delete (deps as { debug?: unknown }).debug;
    expect(await applyStallOption(deps, { kind: 'accept-docs', label: 'Accept', note: 'n' })).toEqual({ ok: true });
  });
});
