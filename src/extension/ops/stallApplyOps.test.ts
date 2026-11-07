import { describe, it, expect, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, setAgentState, setStageCurrent, updateTicketFields } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { recordFindings, listFindings } from '../../store/reviewFindings.js';
import { openRecoveryRound, failRevalidationForStall } from '../../store/recoveryRounds.js';
import { listRecoveryRounds } from '../../store/recoveryRoundsRead.js';
import { stallNote, STALL_ACCEPT_TITLE } from '../../store/stallNote.js';
import { reviewStallAttempts } from '../../workflow/reviewStallRead.js';
import { applyStallOption, type StallApplyDeps, type StallApplyRequest } from './stallApplyOps.js';

const T0 = '2026-01-01T00:00:00.000Z';
const AT = '2026-01-02T00:00:00.000Z';

function parked(): { store: Store; ticketId: number } {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'ST-1', title: 't' }).id;
  updateTicketFields(store, ticketId, { description: 'old desc', intent: 'old check' });
  setStageCurrent(store, ticketId, 'fix');
  setStage(store, ticketId, 'review', { status: 'failed', verdict: 'review findings', attempt: 3, endedAt: T0 });
  recordFindings(store, {
    ticketId, attempt: 3, runAt: T0,
    findings: [{ severity: 'high', repo: '', file: 'docs/a.md', title: 'claim', detail: 'd', source: 'agent' }],
  });
  const trigger = {
    ticketId, sourceStage: 'review' as const, sourceProcessId: 'review' as const,
    sourceStageRunId: null, sourceProcessRunId: null,
    triggerKind: 'blocking-review-findings' as const, triggerDetail: 'x', maxRounds: 5, startedAt: T0,
  };
  openRecoveryRound(store, trigger);
  failRevalidationForStall(store, trigger);
  setStage(store, ticketId, 'fix', {
    status: 'failed', verdict: 'stalled', endedAt: T0,
    blockedKind: 'review-stalled', blockedReason: 'same files', blockedAt: T0,
  });
  return { store, ticketId };
}

function mk(store: Store, ticketId: number, over: Partial<StallApplyDeps> = {}) {
  const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
  const redrive = vi.fn();
  const refresh = vi.fn();
  const deps: StallApplyDeps = {
    store, ticketId, notify, redrive, refresh,
    diffFiles: async () => ['docs/a.md'],
    maxRounds: () => 5,
    blockingSeverity: () => 'medium' as const,
    now: () => AT,
    ...over,
  };
  return { deps, notify, redrive, refresh };
}

const agentReq: StallApplyRequest = {
  kind: 'agent', label: 'Cut scope', note: 'Remove section 3.', description: 'new desc', acceptanceCheck: 'new check',
};
const acceptReq: StallApplyRequest = { kind: 'accept-docs', label: 'Accept', note: 'n' };

describe('applyStallOption — agent option', () => {
  it('writes the fields, records the note, clears the park and opens a pending fix round with no review', async () => {
    const { store, ticketId } = parked();
    const { deps, redrive } = mk(store, ticketId);
    expect(await applyStallOption(deps, agentReq)).toEqual({ ok: true });
    const t = getTicket(store, ticketId);
    expect(t.description).toBe('new desc');
    expect(t.intent).toBe('new check');
    expect(t.stageCurrent).toBe('fix');
    expect(stageBlock(store, ticketId, 'fix')).toBeNull();
    expect(t.stages.find((s) => s.stageKey === 'fix')?.status).toBe('running');
    expect(stallNote(store, ticketId)).toBe('Remove section 3.');
    const last = listRecoveryRounds(store, ticketId).at(-1)!;
    expect(last.status).toBe('pending');
    expect(last.sourceStage).toBe('review');
    expect(last.episode).toBe(2);
    expect(redrive).toHaveBeenCalledWith(ticketId);
  });

  it('ends the episode so the stall window restarts', async () => {
    const { store, ticketId } = parked();
    await applyStallOption(mk(store, ticketId).deps, agentReq);
    expect(reviewStallAttempts(store, ticketId, 'medium')).toEqual([]);
  });

  it('leaves description and acceptance check alone when the option does not change them', async () => {
    const { store, ticketId } = parked();
    await applyStallOption(mk(store, ticketId).deps, { kind: 'agent', label: 'l', note: 'n', description: ' ' });
    const t = getTicket(store, ticketId);
    expect(t.description).toBe('old desc');
    expect(t.intent).toBe('old check');
  });

  it('is refused with a reason when an agent session runs', async () => {
    const { store, ticketId } = parked();
    setAgentState(store, ticketId, 'running');
    const { deps, redrive, notify } = mk(store, ticketId);
    const res = await applyStallOption(deps, agentReq);
    expect(res.ok).toBe(false);
    expect(redrive).not.toHaveBeenCalled();
    expect(notify.warn).toHaveBeenCalled();
    expect(stageBlock(store, ticketId, 'fix')?.kind).toBe('review-stalled');
    expect(getTicket(store, ticketId).description).toBe('old desc');
  });

  it('is refused when an agent session waits for input', async () => {
    const { store, ticketId } = parked();
    setAgentState(store, ticketId, 'waiting');
    const res = await applyStallOption(mk(store, ticketId).deps, agentReq);
    expect(res.ok).toBe(false);
    expect(getTicket(store, ticketId).agentState).toBe('waiting');
    expect(stageBlock(store, ticketId, 'fix')?.kind).toBe('review-stalled');
  });

  it('is refused when the ticket is not parked on a stall', async () => {
    const { store, ticketId } = parked();
    setStage(store, ticketId, 'fix', { blockedKind: null, blockedReason: null, blockedAt: null });
    const res = await applyStallOption(mk(store, ticketId).deps, agentReq);
    expect(res).toMatchObject({ ok: false });
  });

  it('is refused when the note is blank', async () => {
    const { store, ticketId } = parked();
    const res = await applyStallOption(mk(store, ticketId).deps, { ...agentReq, note: '  ' });
    expect(res).toMatchObject({ ok: false });
    expect(stageBlock(store, ticketId, 'fix')?.kind).toBe('review-stalled');
  });

  it('always refreshes the panel', async () => {
    const { store, ticketId } = parked();
    const { deps, refresh } = mk(store, ticketId, { diffFiles: async () => null });
    await applyStallOption(deps, acceptReq);
    expect(refresh).toHaveBeenCalledWith(ticketId);
  });
});

describe('applyStallOption — accept', () => {
  it('passes review with no fix round and keeps the findings', async () => {
    const { store, ticketId } = parked();
    const before = listRecoveryRounds(store, ticketId).length;
    const { deps, redrive } = mk(store, ticketId);
    expect(await applyStallOption(deps, acceptReq)).toEqual({ ok: true });
    expect(listRecoveryRounds(store, ticketId).filter((r) => r.status === 'pending')).toHaveLength(0);
    expect(listRecoveryRounds(store, ticketId).length).toBe(before);
    const t = getTicket(store, ticketId);
    expect(t.stages.find((s) => s.stageKey === 'review')?.status).toBe('passed');
    expect(t.stageCurrent).not.toBe('fix');
    expect(t.stageCurrent).not.toBe('review');
    expect(stageBlock(store, ticketId, 'fix')).toBeNull();
    const findings = listFindings(store, ticketId);
    expect(findings.some((f) => f.source === 'agent' && f.title === 'claim')).toBe(true);
    const human = findings.find((f) => f.source === 'human' && f.title === STALL_ACCEPT_TITLE);
    expect(human?.severity).toBe('info');
    expect(human?.detail).toContain('1 open blocking');
    expect(redrive).toHaveBeenCalledWith(ticketId);
  });

  it('is refused when a file outside docs/ entered the diff', async () => {
    const { store, ticketId } = parked();
    const { deps, redrive } = mk(store, ticketId, { diffFiles: async () => ['docs/a.md', 'src/x.ts'] });
    const res = await applyStallOption(deps, acceptReq);
    expect(res).toMatchObject({ ok: false });
    expect(redrive).not.toHaveBeenCalled();
    expect(stageBlock(store, ticketId, 'fix')?.kind).toBe('review-stalled');
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'review')?.status).toBe('failed');
    expect(listFindings(store, ticketId).some((f) => f.source === 'human')).toBe(false);
  });

  it('is refused when the diff cannot be read', async () => {
    const { store, ticketId } = parked();
    const res = await applyStallOption(mk(store, ticketId, { diffFiles: async () => null }).deps, acceptReq);
    expect(res).toMatchObject({ ok: false });
  });

  it('is refused when an agent session runs', async () => {
    const { store, ticketId } = parked();
    setAgentState(store, ticketId, 'running');
    expect(await applyStallOption(mk(store, ticketId).deps, acceptReq)).toMatchObject({ ok: false });
  });

  it('is refused when a session starts while the diff is read', async () => {
    const { store, ticketId } = parked();
    const { deps, redrive } = mk(store, ticketId, {
      diffFiles: async () => {
        setAgentState(store, ticketId, 'running');
        return ['docs/a.md'];
      },
    });
    expect(await applyStallOption(deps, acceptReq)).toMatchObject({ ok: false });
    expect(redrive).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'review')?.status).toBe('failed');
  });

  it('reads the blocking severity at each Apply', async () => {
    const { store, ticketId } = parked();
    let severity: 'medium' | 'none' = 'none';
    await applyStallOption(mk(store, ticketId, { blockingSeverity: () => severity }).deps, acceptReq);
    expect(listFindings(store, ticketId).find((f) => f.title === STALL_ACCEPT_TITLE)?.detail).toContain('0 open blocking');
    expect(severity).toBe('none');
  });
});
