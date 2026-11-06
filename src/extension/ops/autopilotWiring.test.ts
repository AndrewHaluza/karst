import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actionSeams, ciOutcome, conflictOutcome } from './autopilotWiring.js';
import { sendCiFailureAction } from './ciActionsWiring.js';

vi.mock('./ciActionsWiring.js', () => ({ sendCiFailureAction: vi.fn() }));
beforeEach(() => { vi.mocked(sendCiFailureAction).mockReset(); });


describe('conflictOutcome', () => {
  it('maps a sent round', () => {
    expect(conflictOutcome({ kind: 'sent' })).toEqual({ kind: 'sent' });
  });
  it('maps a dirty or diverged sandbox clone (AC-46) to an environment blocker', () => {
    expect(conflictOutcome({ kind: 'refused', cause: 'sandbox-sync', message: 'm', reason: 'clone diverged' })).toEqual({ kind: 'env-blocker', reason: 'clone diverged' });
  });
  it.each(['placement-unknown', 'no-conflict'] as const)('maps %s to a failure, never a host fallback', (cause) => {
    expect(conflictOutcome({ kind: 'refused', cause, message: 'm', reason: 'r' })).toEqual({ kind: 'failed', reason: 'r' });
  });
});

describe('actionSeams', () => {
  it('maps the round result and passes the CI outcome through', async () => {
    const send = vi.fn(async () => ({ kind: 'failed', reason: 'gh' }) as const);
    const seams = actionSeams(async () => ({ kind: 'sent' }), send);
    expect(await seams.resolveConflicts('r')).toEqual({ kind: 'sent' });
    expect(await seams.sendCiFailure()).toEqual({ kind: 'failed', reason: 'gh' });
  });
});

import { upsertProject } from '../../store/projects.js';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { autopilotSweep, concurrencyFullFor, type TicketSeams } from './autopilotWiring.js';

describe('concurrencyFullFor', () => {
  const caps = { perParent: 1, total: 3 };
  const t = (id: number, agentState: string | null, subtaskParentId: number | null = null) => ({ id, agentState, subtaskParentId });
  it('is full at the total cap, ignoring the ticket itself', () => {
    const all = [t(1, 'running'), t(2, 'running'), t(3, 'running'), t(4, null)];
    expect(concurrencyFullFor(all, t(4, null), caps)).toBe(true);
    expect(concurrencyFullFor(all, t(3, 'running'), caps)).toBe(false);
  });
  it('treats a cap of 0 as unlimited', () => {
    const all = [t(1, 'running', 8), t(2, 'running', 8), t(3, 'running', 8), t(4, null, 8)];
    expect(concurrencyFullFor(all, t(4, null, 8), { perParent: 0, total: 0 })).toBe(false);
    expect(concurrencyFullFor(all, t(4, null, 8), { perParent: 0, total: 3 })).toBe(true);
  });
  it('counts only running siblings of the same parent against the per-parent cap', () => {
    const all = [t(1, 'running', 8), t(2, null, 9)];
    expect(concurrencyFullFor(all, t(2, null, 9), caps)).toBe(false);
    expect(concurrencyFullFor([t(1, 'running', 9)], t(2, null, 9), caps)).toBe(true);
  });
  it('is full at the per-parent cap for a sub-task only', () => {
    const all = [t(1, 'running', 9), t(2, null, 9)];
    expect(concurrencyFullFor(all, t(2, null, 9), caps)).toBe(true);
    expect(concurrencyFullFor(all, t(5, null, null), caps)).toBe(false);
  });
});

describe('autopilotSweep', () => {
  function shipTicket() {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const id = createTicket(store, { key: 'AP-9', title: 't', projectId: project.id }).id;
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
    setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w', 'b');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 5, ?, ?)').run(id, 'r', 'https://github.com/o/r/pull/5', 'open');
    setMergeCheck(store, { ticketId: id, repo: 'r', state: 'conflicted', files: [], reason: null, headSha: 'h', baseSha: 'b1', baseRef: 'develop', checkedAt: 'x' });
    return { store, id, projectId: project.id };
  }
  const cfg = { enabled: true, conflicts: { policy: 'auto' as const, maxRounds: 2 }, ci: { policy: 'auto' as const, maxAttempts: 3, checks: [] } };
  const seams = (over: Partial<TicketSeams> = {}): TicketSeams => ({
    controls: () => true, sessionRunning: () => false,
    resolveRound: vi.fn(async () => ({ kind: 'sent' }) as const), sendCi: vi.fn(async () => ({ kind: 'sent' }) as const), ...over,
  });

  it('arms a conflict round for a ship ticket and writes a bulletin note', async () => {
    const { store, projectId } = shipTicket();
    const changed = vi.fn();
    const s = seams();
    const acted = await autopilotSweep({
      store, projectId: () => projectId, manifest: () => ({ autopilot: cfg }) as never,
      caps: () => ({ perParent: 2, total: 4 }), seamsFor: () => s, debug: () => {}, changed,
    });
    expect(acted).toBe(1);
    expect(s.resolveRound).toHaveBeenCalledWith('r');
    expect(changed).toHaveBeenCalledTimes(1);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM bulletin_notes').get() as { n: number }).n).toBe(1);
  });

  it('does nothing without a bound project, and when this window does not control the ticket', async () => {
    const { store, projectId } = shipTicket();
    const s = seams({ controls: () => false });
    const base = { store, manifest: () => ({ autopilot: cfg }) as never, caps: () => ({ perParent: 2, total: 4 }), seamsFor: () => s, debug: () => {}, changed: () => {} };
    expect(await autopilotSweep({ ...base, projectId: () => undefined })).toBe(0);
    expect(await autopilotSweep({ ...base, projectId: () => projectId })).toBe(0);
    expect(s.resolveRound).not.toHaveBeenCalled();
  });
});

describe('ciOutcome', () => {
  const failingChecks = { state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failedShown: 1, failing: [{ name: 'build', url: 'u' }] };
  function rig(withFailure = true) {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'CI-1', title: 't' }).id;
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
    setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w', 'b');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, 5, ?, ?, ?)').run(id, 'r', 'https://github.com/o/r/pull/5', 'open', withFailure ? JSON.stringify(failingChecks) : null);
    const info = vi.fn(); const error = vi.fn(); const debug = vi.fn();
    return { input: { store, ticketId: id, info, error, debug, handOff: vi.fn(() => null) } as never, info, error, debug };
  }
  it('is failed, and never calls the action, when no CI is failing', async () => {
    expect(await ciOutcome(rig(false).input)).toEqual({ kind: 'failed', reason: 'no failing CI to send' });
    expect(sendCiFailureAction).not.toHaveBeenCalled();
  });
  it('answers the confirm yes and reports sent when the action raises nothing', async () => {
    vi.mocked(sendCiFailureAction).mockImplementationOnce(async (i) => { expect(await i.confirm('t', 'd', 'a')).toBe(true); });
    expect(await ciOutcome(rig().input)).toEqual({ kind: 'sent' });
  });
  it('turns an action error into a failed outcome and shows no toast', async () => {
    const r = rig();
    vi.mocked(sendCiFailureAction).mockImplementationOnce(async (i) => { i.info('hello'); i.error('gh down'); });
    expect(await ciOutcome(r.input)).toEqual({ kind: 'failed', reason: 'gh down' });
    expect(r.error).not.toHaveBeenCalled();
    expect(r.info).not.toHaveBeenCalled();
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket T1 ci error: gh down');
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket T1 ci: hello');
  });
  it('a refused hand-off is a failed round: no session got the task', async () => {
    const r = rig();
    (r.input as { handOff: unknown }).handOff = vi.fn(() => 'no seat');
    vi.mocked(sendCiFailureAction).mockImplementationOnce(async (i) => { i.handOff('p'); });
    expect(await ciOutcome(r.input)).toEqual({ kind: 'failed', reason: 'no seat' });
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot ticket T1 ci: hand-off refused (no seat); the ticket is in Implement');
  });
});

describe('autopilotSweep edges', () => {
  function setup() {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p2' });
    const t = createTicket(store, { key: 'AP-7', title: 't', projectId: project.id });
    return { store, projectId: project.id, id: t.id };
  }
  const base = (store: ReturnType<typeof openStore>, projectId: number, over: object = {}) => ({
    store, projectId: () => projectId, manifest: () => undefined, caps: () => ({ perParent: 1, total: 1 }),
    seamsFor: vi.fn(), debug: vi.fn(), changed: vi.fn(), ...over,
  }) as never as Parameters<typeof autopilotSweep>[0] & { seamsFor: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; changed: ReturnType<typeof vi.fn> };

  it('skips tickets that are not in ship and never calls changed', async () => {
    const { store, projectId } = setup();
    const d = base(store, projectId);
    expect(await autopilotSweep(d)).toBe(0);
    expect(d.seamsFor).not.toHaveBeenCalled();
    expect(d.changed).not.toHaveBeenCalled();
  });

  it('logs a failing ticket and keeps going', async () => {
    const { store, projectId, id } = setup();
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
    setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    const d = base(store, projectId, { seamsFor: () => { throw new Error('boom'); } });
    expect(await autopilotSweep(d)).toBe(0);
    expect(d.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-7: sweep failed (boom)');
    expect(d.changed).not.toHaveBeenCalled();
  });

  it('describes a non-Error throw', async () => {
    const { store, projectId, id } = setup();
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
    setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    const d = base(store, projectId, { seamsFor: () => { throw 'bad'; } });
    await autopilotSweep(d);
    expect(d.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-7: sweep failed (bad)');
  });
});
