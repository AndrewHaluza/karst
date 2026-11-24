import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { getTicket } from '../../store/tickets.js';
import { openStageRun } from '../../store/stageRuns.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { manifest as makeManifest, uat as makeUat } from '../../manifest/fixtures.js';
import { latestBaselineDecisions, recordBaselineDecisions } from '../../store/baselineDecisions.js';
import { listRecoveryRounds } from '../../store/recoveryRounds.js';
import type { BaselineEntry } from '../../workflow/gates/baselineReview.js';
import { decideBaselines, makeBaselineActions, type BaselineDecisionDeps } from './baselineDecisionOps.js';

const NOW = '2026-07-30T10:00:00.000Z';
const entry = (path: string, sha: string): BaselineEntry => ({
  repo: '/web', cwd: '/wt/web', path, status: 'modified', newSha256: sha, mergeBase: 'mb', autoApproved: false,
});
const ENTRIES = [entry('a.png', 's-a'), entry('b.png', 's-b')];
const ENTRIES3 = [entry('a.png', 's-a'), entry('b.png', 's-b'), entry('c.png', 's-c')];

describe('decideBaselines', () => {
  let store: Store;
  let id: number;
  let redrive: Mock<(ticketId: number) => void>;
  let warn: Mock<(message: string) => void>;
  let deps: BaselineDecisionDeps;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    openStageRun(store, { ticketId: id, stageKey: 'uat', attempt: 0, runAt: NOW, startedAt: NOW });
    parkGateStage(store, {
      ticketId: id, stageKey: 'uat', kind: 'baseline-review', reason: '2 changed', runAt: NOW, gates: [],
    });
    redrive = vi.fn<(ticketId: number) => void>();
    warn = vi.fn<(message: string) => void>();
    deps = {
      store, manifest: undefined, ticketId: id, now: () => NOW,
      deriveEntries: async () => ENTRIES, redrive,
      notify: { info: vi.fn(), warn, error: async () => {} },
    };
  });
  afterEach(() => store.close());

  it('approve-all clears the block and re-drives UAT', async () => {
    expect(await decideBaselines(deps, { kind: 'approve', indices: [0, 1] })).toEqual({ kind: 'approved' });
    expect(stageBlock(store, id, 'uat')).toBeNull();
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(redrive).toHaveBeenCalledWith(id);
    expect(latestBaselineDecisions(store, id).get('/web\0a.png')?.decision).toBe('approved');
  });

  it('approve-all approves 600 pending entries in one request and never a rejected one', async () => {
    const many = Array.from({ length: 601 }, (_, i) => entry(`p${i}.png`, `s-${i}`));
    deps.deriveEntries = async () => many;
    // One entry (the last) already carries the user's rejection for its current sha.
    recordBaselineDecisions(store, id, [
      { repo: '/web', path: 'p600.png', sha256: 's-600', decision: 'rejected', reason: 'bad' },
    ], NOW);
    const result = await decideBaselines(deps, { kind: 'approve-all' });
    const latest = latestBaselineDecisions(store, id);
    const approved = [...latest.values()].filter((d) => d.decision === 'approved');
    expect(approved).toHaveLength(600);
    expect(latest.get('/web\0p600.png')?.decision).toBe('rejected');
    expect(result.kind).toBe('rejected');
    // The kept rejection fails UAT into fix (the existing rejection path); the block is never cleared as 'all approved'.
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });

  it('approve-all with no rejected entry clears the block and re-drives', async () => {
    deps.deriveEntries = async () => Array.from({ length: 600 }, (_, i) => entry(`p${i}.png`, `s-${i}`));
    expect(await decideBaselines(deps, { kind: 'approve-all' })).toEqual({ kind: 'approved' });
    expect(latestBaselineDecisions(store, id).size).toBe(600);
    expect(stageBlock(store, id, 'uat')).toBeNull();
    expect(redrive).toHaveBeenCalledWith(id);
  });

  it('approve-all with nothing pending refuses with a visible warning', async () => {
    await decideBaselines(deps, { kind: 'approve', indices: [0, 1] });
    parkGateStage(store, { ticketId: id, stageKey: 'uat', kind: 'baseline-review', reason: 'r', runAt: NOW, gates: [] });
    const result = await decideBaselines(deps, { kind: 'approve-all' });
    expect(result.kind).toBe('refused');
    expect(warn).toHaveBeenCalled();
  });

  it('a partial approval keeps the block and does not re-drive', async () => {
    expect(await decideBaselines(deps, { kind: 'approve', indices: [0] })).toEqual({ kind: 'pending', remaining: 1 });
    expect(stageBlock(store, id, 'uat')?.kind).toBe('baseline-review');
    expect(redrive).not.toHaveBeenCalled();
  });

  it('a single rejection records the decision and keeps the ticket parked', async () => {
    const res = await decideBaselines(deps, { kind: 'reject', index: 1, reason: '  wrong colour  ' });
    expect(res).toEqual({ kind: 'pending', remaining: 1 });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(stageBlock(store, id, 'uat')?.kind).toBe('baseline-review');
    expect(listRecoveryRounds(store, id)).toHaveLength(0);
    expect(latestBaselineDecisions(store, id).get('/web\0b.png')).toMatchObject({
      decision: 'rejected', reason: 'wrong colour',
    });
    expect(redrive).not.toHaveBeenCalled();
  });

  it('rejecting every entry fails UAT into fix with the user reason per rejected path', async () => {
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'one' });
    const res = await decideBaselines(deps, { kind: 'reject', index: 1, reason: '  wrong colour  ' });
    expect(res).toEqual({ kind: 'rejected' });
    const ticket = getTicket(store, id);
    expect(ticket.stageCurrent).toBe('fix');
    expect(ticket.stages.find((s) => s.stageKey === 'uat')?.verdict).toBe(
      'Visual baseline rejected: a.png: one\nVisual baseline rejected: b.png: wrong colour',
    );
    expect(stageBlock(store, id, 'uat')).toBeNull();
    expect(listRecoveryRounds(store, id)[0]?.triggerDetail).toBe(
      'Visual baseline rejected: a.png: one\nVisual baseline rejected: b.png: wrong colour',
    );
    expect(redrive).toHaveBeenCalledWith(id);
  });

  it('includes the per-region checklist rule in the rejection verdict when the ticket links a prototype', async () => {
    store.db.prepare('UPDATE tickets SET description = ? WHERE id = ?').run(
      'Follow prototype docs/design/ticket-form-b-prime.html',
      id,
    );
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'wrong colour' });
    const res = await decideBaselines(deps, { kind: 'reject', index: 1, reason: 'wrong colour' });
    expect(res).toEqual({ kind: 'rejected' });
    const ticket = getTicket(store, id);
    expect(ticket.stages.find((s) => s.stageKey === 'uat')?.verdict).toContain('@ui:UI-R39-REJECT');
    expect(listRecoveryRounds(store, id)[0]?.triggerDetail).toContain('@ui:UI-R39-REJECT');
  });

  it('refuses a forged index and writes nothing', async () => {
    for (const bad of [[2], [-1], [1.5], [0, 9], []]) {
      expect((await decideBaselines(deps, { kind: 'approve', indices: bad }))).toMatchObject({ kind: 'refused' });
    }
    expect(latestBaselineDecisions(store, id).size).toBe(0);
    expect(stageBlock(store, id, 'uat')?.kind).toBe('baseline-review');
    expect(redrive).not.toHaveBeenCalled();
  });

  it('requires a reason to reject', async () => {
    expect(await decideBaselines(deps, { kind: 'reject', index: 0, reason: '   ' })).toMatchObject({ kind: 'refused' });
    expect(latestBaselineDecisions(store, id).size).toBe(0);
  });

  it('refuses when the ticket is not parked on a baseline review (stale panel)', async () => {
    store.db.prepare("UPDATE stages SET blocked_kind = NULL WHERE ticket_id = ? AND stage_key = 'uat'").run(id);
    expect(await decideBaselines(deps, { kind: 'approve', indices: [0] })).toMatchObject({ kind: 'refused' });
    expect(warn).toHaveBeenCalled();
  });

  it('refuses when the block clears during the entry derivation and writes nothing', async () => {
    const res = await decideBaselines(
      {
        ...deps,
        deriveEntries: async () => {
          store.db.prepare("UPDATE stages SET blocked_kind = NULL WHERE ticket_id = ? AND stage_key = 'uat'").run(id);
          return ENTRIES;
        },
      },
      { kind: 'approve', indices: [0] },
    );
    expect(res).toEqual({ kind: 'refused', reason: `T${id} is no longer waiting for a baseline review.` });
    expect(latestBaselineDecisions(store, id).size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses when the stage moves on during the entry derivation although the block stays', async () => {
    const res = await decideBaselines(
      {
        ...deps,
        deriveEntries: async () => {
          store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('fix', id);
          return ENTRIES;
        },
      },
      { kind: 'approve', indices: [0] },
    );
    expect(res).toEqual({ kind: 'refused', reason: `T${id} is no longer waiting for a baseline review.` });
    expect(latestBaselineDecisions(store, id).size).toBe(0);
  });

  it('writes nothing when the entries cannot be re-derived', async () => {
    const res = await decideBaselines(
      { ...deps, deriveEntries: async () => { throw new Error('git broke'); } },
      { kind: 'approve', indices: [0] },
    );
    expect(res).toMatchObject({ kind: 'refused', reason: 'git broke' });
    expect(latestBaselineDecisions(store, id).size).toBe(0);
  });
});

describe('decideBaselines — collect rejections, then send them', () => {
  let store: Store;
  let id: number;
  let redrive: Mock<(ticketId: number) => void>;
  let warn: Mock<(message: string) => void>;
  let info: Mock<(message: string, ticketId?: number) => void>;
  let deps: BaselineDecisionDeps;

  const verdict = (): string | null | undefined =>
    getTicket(store, id).stages.find((s) => s.stageKey === 'uat')?.verdict;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    openStageRun(store, { ticketId: id, stageKey: 'uat', attempt: 0, runAt: NOW, startedAt: NOW });
    parkGateStage(store, {
      ticketId: id, stageKey: 'uat', kind: 'baseline-review', reason: '3 changed', runAt: NOW, gates: [],
    });
    redrive = vi.fn<(ticketId: number) => void>();
    warn = vi.fn<(message: string) => void>();
    info = vi.fn<(message: string, ticketId?: number) => void>();
    deps = {
      store, manifest: undefined, ticketId: id, now: () => NOW,
      deriveEntries: async () => ENTRIES3, redrive,
      notify: { info, warn, error: async () => {} },
    };
  });
  afterEach(() => store.close());

  it('records two rejections and keeps the ticket parked with no failed verdict (AC1)', async () => {
    expect(await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'one' })).toEqual(
      { kind: 'pending', remaining: 2 },
    );
    expect(await decideBaselines(deps, { kind: 'reject', index: 1, reason: 'two' })).toEqual(
      { kind: 'pending', remaining: 1 },
    );
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(stageBlock(store, id, 'uat')?.kind).toBe('baseline-review');
    expect(listRecoveryRounds(store, id)).toHaveLength(0);
    expect(verdict()).toBeNull();
    const rows = [...latestBaselineDecisions(store, id).values()].filter((d) => d.decision === 'rejected');
    expect(rows.map((r) => r.reason)).toEqual(['one', 'two']);
    expect(info).not.toHaveBeenCalled();
  });

  it('sends every rejected entry in one failed verdict when the last decision leaves none pending (AC2)', async () => {
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'one' });
    await decideBaselines(deps, { kind: 'reject', index: 1, reason: 'two' });
    expect(await decideBaselines(deps, { kind: 'approve', indices: [2] })).toEqual({ kind: 'rejected' });
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(verdict()).toBe('Visual baseline rejected: a.png: one\nVisual baseline rejected: b.png: two');
    expect(listRecoveryRounds(store, id)).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(`Sent 2 rejected baselines of T${id} to fix.`, id);
  });

  it('sends only the rejected entries and leaves the pending ones undecided (AC3)', async () => {
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'one' });
    expect(await decideBaselines(deps, { kind: 'send-rejections' })).toEqual({ kind: 'rejected' });
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(verdict()).toBe('Visual baseline rejected: a.png: one');
    expect([...latestBaselineDecisions(store, id).keys()]).toEqual(['/web\0a.png']);
    expect(listRecoveryRounds(store, id)).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(`Sent 1 rejected baseline of T${id} to fix.`, id);
  });

  it('refuses Send with nothing rejected and writes nothing (AC4)', async () => {
    expect(await decideBaselines(deps, { kind: 'send-rejections' })).toMatchObject({ kind: 'refused' });
    expect(warn).toHaveBeenCalledWith(`Nothing is rejected for T${id}.`);
    expect(latestBaselineDecisions(store, id).size).toBe(0);
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(stageBlock(store, id, 'uat')?.kind).toBe('baseline-review');
    expect(redrive).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('writes one failed verdict when Send completes while an Approve is in flight (AC5)', async () => {
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'bad' });
    // The Approve passes the first stage check, then Send completes during its
    // deriveEntries wait and moves the ticket to fix. The re-check must refuse.
    let sent = false;
    const approveDeps: BaselineDecisionDeps = {
      ...deps,
      deriveEntries: async () => {
        if (!sent) {
          sent = true;
          await decideBaselines(deps, { kind: 'send-rejections' });
        }
        return ENTRIES3;
      },
    };
    expect(await decideBaselines(approveDeps, { kind: 'approve-all' })).toEqual(
      { kind: 'refused', reason: `T${id} is no longer waiting for a baseline review.` },
    );
    expect(listRecoveryRounds(store, id)).toHaveLength(1);
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });

  it('does not fail UAT while an entry is still pending, even when a rejection stands (AC6)', async () => {
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'one' });
    expect(await decideBaselines(deps, { kind: 'approve', indices: [1] })).toEqual(
      { kind: 'pending', remaining: 1 },
    );
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(listRecoveryRounds(store, id)).toHaveLength(0);
    expect(verdict()).toBeNull();
  });
});

describe('decideBaselines — messages, clock and evidence', () => {
  let store: Store;
  let id: number;
  let debug: string[];
  let warns: string[];
  let errors: string[];
  let deps: BaselineDecisionDeps;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-9', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    openStageRun(store, { ticketId: id, stageKey: 'uat', attempt: 0, runAt: NOW, startedAt: NOW });
    parkGateStage(store, {
      ticketId: id, stageKey: 'uat', kind: 'baseline-review', reason: 'r', runAt: NOW, gates: [],
      artifactPath: '/logs/uat.log',
    });
    debug = [];
    warns = [];
    errors = [];
    deps = {
      store, manifest: undefined, ticketId: id,
      deriveEntries: async () => ENTRIES, redrive: vi.fn(),
      notify: { info: vi.fn(), warn: (m) => warns.push(m), error: async (m) => { errors.push(m); } },
      debug: (m) => debug.push(m),
    };
  });
  afterEach(() => store.close());

  it('stamps decisions with the real clock when none is injected', async () => {
    await decideBaselines(deps, { kind: 'approve', indices: [0] });
    const at = latestBaselineDecisions(store, id).get('/web\0a.png')!.decidedAt;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('logs entry, decision and exit with the [gate] prefix', async () => {
    await decideBaselines(deps, { kind: 'approve', indices: [0] });
    expect(debug).toEqual([
      `[gate] baseline decision ticket ${id}: approve`,
      `[gate] baseline decision ticket ${id}: 1 still pending`,
    ]);
    debug.length = 0;
    await decideBaselines(deps, { kind: 'approve', indices: [1] });
    expect(debug).toEqual([
      `[gate] baseline decision ticket ${id}: approve`,
      `[gate] baseline decision ticket ${id}: all approved — re-driving uat`,
    ]);
  });

  it('names the ticket and the reason when it refuses', async () => {
    await decideBaselines(deps, { kind: 'approve', indices: [9] });
    expect(warns).toEqual([`The changed baselines of T${id} moved on — reopen the UAT report.`]);
    expect(debug.at(-1)).toBe(`[gate] baseline decision ticket ${id}: refused (${warns[0]})`);
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: ' ' });
    expect(warns.at(-1)).toBe('Say why the baseline is wrong — the fix agent reads the reason.');
  });

  it('reports a stale panel by ticket', async () => {
    store.db.prepare("UPDATE stages SET blocked_kind = NULL WHERE ticket_id = ?").run(id);
    await decideBaselines(deps, { kind: 'approve', indices: [0] });
    expect(warns).toEqual([`T${id} is no longer waiting for a baseline review.`]);
  });

  it('shows git failures to the user and logs them', async () => {
    await decideBaselines(
      { ...deps, deriveEntries: async () => { throw new Error('git broke'); } },
      { kind: 'approve', indices: [0] },
    );
    expect(errors).toEqual([`Cannot read the changed baselines for T${id}: git broke`]);
    expect(debug.at(-1)).toBe(`[gate] baseline decision ticket ${id}: could not derive entries (git broke)`);
  });

  it('bounds the stored reason and keeps the uat log path on the failed stage', async () => {
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'y'.repeat(1500) });
    await decideBaselines(deps, { kind: 'reject', index: 1, reason: 'wrong' });
    expect(latestBaselineDecisions(store, id).get('/web\0a.png')!.reason).toHaveLength(1000);
    expect(getTicket(store, id).stages.find((st) => st.stageKey === 'uat')!.artifactPath).toBe('/logs/uat.log');
  });

  it('opens the fix round with the manifest uat budget and the rejection as the cause', async () => {
    const manifest = makeManifest({}, { uat: makeUat({ maxFixAttempts: 7 }) });
    await decideBaselines({ ...deps, manifest }, { kind: 'reject', index: 0, reason: 'bad' });
    await decideBaselines({ ...deps, manifest }, { kind: 'send-rejections' });
    const round = listRecoveryRounds(store, id)[0]!;
    expect(round.maxRounds).toBe(7);
    expect(round.triggerKind).toBe('gate-failure');
    expect(round.sourceProcessId).toBe('gates');
    expect(debug.at(-1)).toBe(`[gate] baseline decision ticket ${id}: 1 rejected → uat failed, fix`);
  });

  it('lists every rejected path in the verdict when an earlier rejection stands', async () => {
    // a.png was rejected before and not touched since; the user now rejects b.png too.
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'one' });
    // The second rejection leaves no entry pending, so it sends both entries to fix.
    await decideBaselines(deps, { kind: 'reject', index: 1, reason: 'two' });
    expect(getTicket(store, id).stages.find((st) => st.stageKey === 'uat')!.verdict).toBe(
      'Visual baseline rejected: a.png: one\nVisual baseline rejected: b.png: two',
    );
  });

  it('refuses a rejection when the ticket has no UAT run to fail', async () => {
    store.db.prepare('DELETE FROM stage_runs WHERE ticket_id = ?').run(id);
    await decideBaselines(deps, { kind: 'reject', index: 0, reason: 'bad' });
    const res = await decideBaselines(deps, { kind: 'reject', index: 1, reason: 'bad' });
    expect(res).toMatchObject({ kind: 'refused' });
    expect(warns).toEqual([`T${id} has no UAT run to fail.`]);
  });
});

describe('makeBaselineActions — the full path', () => {
  it('approves through the block id, re-drives and repaints once each', async () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-8', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    parkGateStage(store, { ticketId: id, stageKey: 'uat', kind: 'baseline-review', reason: 'r', runAt: NOW, gates: [] });
    const redrive = vi.fn<(ticketId: number) => void>();
    const refresh = vi.fn<(ticketId: number) => void>();
    const actions = makeBaselineActions({
      store, manifest: () => undefined, ticketId: id, redrive, refresh,
      notify: { info: vi.fn(), warn: vi.fn(), error: async () => {} },
      deriveEntries: async () => ENTRIES,
    });
    await actions.baselineApprove('baseline-review', [0, 1]);
    expect(redrive).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(id);
    expect(latestBaselineDecisions(store, id).size).toBe(2);
    store.close();
  });

  it('sends the rejected entries to fix through the block id and repaints', async () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-8', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    openStageRun(store, { ticketId: id, stageKey: 'uat', attempt: 0, runAt: NOW, startedAt: NOW });
    parkGateStage(store, { ticketId: id, stageKey: 'uat', kind: 'baseline-review', reason: 'r', runAt: NOW, gates: [] });
    const redrive = vi.fn<(ticketId: number) => void>();
    const refresh = vi.fn<(ticketId: number) => void>();
    const actions = makeBaselineActions({
      store, manifest: () => undefined, ticketId: id, redrive, refresh,
      notify: { info: vi.fn(), warn: vi.fn(), error: async () => {} },
      deriveEntries: async () => ENTRIES,
    });
    recordBaselineDecisions(store, id, [
      { repo: '/web', path: 'a.png', sha256: 's-a', decision: 'rejected', reason: 'bad' },
    ], NOW);
    await actions.baselineSendRejections('baseline-review');
    expect(redrive).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(id);
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    store.close();
  });
});

describe('makeBaselineActions', () => {
  it('ignores any block other than baseline-review and never touches the store', async () => {
    const store = openStore(':memory:');
    const refresh = vi.fn<(ticketId: number) => void>();
    const actions = makeBaselineActions({
      store, manifest: () => undefined, ticketId: 1, refresh, redrive: vi.fn(),
      notify: { info: vi.fn(), warn: vi.fn(), error: async () => {} },
    });
    await actions.baselineApprove('awaiting-merge', [0]);
    await actions.baselineReject('/etc/passwd', 0, 'x');
    expect(refresh).not.toHaveBeenCalled();
    store.close();
  });
});
