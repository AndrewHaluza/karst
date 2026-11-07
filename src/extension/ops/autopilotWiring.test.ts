import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ciOutcome, conflictOutcome } from './autopilotWiring.js';
import { sendCiFailureAction } from './ciActionsWiring.js';

vi.mock('./ciActionsWiring.js', () => ({ sendCiFailureAction: vi.fn() }));
beforeEach(() => { vi.mocked(sendCiFailureAction).mockReset(); });


import { upsertProject } from '../../store/projects.js';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { transition } from '../../workflow/machine.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { autopilotSweep, concurrencyFullFor, listSlotHolders, postAutopilotNote, type TicketSeams } from './autopilotWiring.js';
import { BULLETIN_BODY_MAX, BULLETIN_TITLE_MAX } from '../../store/bulletinNotes.js';

describe('concurrencyFullFor', () => {
  const caps = { perParent: 1, total: 3 };
  const h = (id: number, subtaskParentId: number) => ({ id, subtaskParentId });
  const self = (id: number, subtaskParentId: number | null) => ({ id, subtaskParentId });
  it('is full at the total cap, ignoring the ticket itself', () => {
    const all = [h(1, 11), h(2, 12), h(3, 13)];
    expect(concurrencyFullFor(all, self(4, 14), caps)).toBe(true);
    expect(concurrencyFullFor(all, self(3, 13), caps)).toBe(false);
  });
  it('treats a cap of 0 as unlimited', () => {
    const all = [h(1, 8), h(2, 8), h(3, 8)];
    expect(concurrencyFullFor(all, self(4, 8), { perParent: 0, total: 0 })).toBe(false);
    expect(concurrencyFullFor(all, self(4, 8), { perParent: 0, total: 3 })).toBe(true);
  });
  it('counts only slot holders of the same parent against the per-parent cap', () => {
    expect(concurrencyFullFor([h(1, 8)], self(2, 9), caps)).toBe(false);
    expect(concurrencyFullFor([h(1, 9)], self(2, 9), caps)).toBe(true);
  });
  it('never limits a ticket that is not a sub-task', () => {
    expect(concurrencyFullFor([h(1, 9), h(2, 9), h(3, 9)], self(5, null), caps)).toBe(false);
  });
});

describe('autopilotSweep', () => {
  function shipTicket() {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const id = createTicket(store, { key: 'AP-9', title: 't', projectId: project.id }).id;
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
    setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked: not merged yet', runAt: '2026-08-09T10:00:00.000Z', gates: [] });
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w', 'b');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 5, ?, ?)').run(id, 'r', 'https://github.com/o/r/pull/5', 'open');
    setMergeCheck(store, { ticketId: id, repo: 'r', state: 'clean', files: [], reason: null, headSha: 'h', baseSha: 'b1', baseRef: 'develop', checkedAt: 'x' });
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify({ state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failedShown: 1, failing: [{ name: 'build', url: 'u' }] }), id);
    return { store, id, projectId: project.id };
  }
  const cfg = { enabled: true, ci: { policy: 'auto' as const, maxAttempts: 3, checks: ['build'] }, conflicts: { policy: 'auto' as const, maxRounds: 2 } };
  const seams = (over: Partial<TicketSeams> = {}): TicketSeams => ({
    controls: () => true, sessionRunning: () => false,
    isHostTicket: async () => true, sendCi: vi.fn(async () => ({ kind: 'sent' }) as const),
    sendConflict: vi.fn(async () => ({ kind: 'sent' }) as const), conflictRoundActive: () => false, conflictRoundStalled: () => false, dropConflictRound: () => {}, ...over,
  });

  it('a ticket with an implementation graph run parks and is not sent a round', async () => {
    const { store, projectId, id } = shipTicket();
    store.db.prepare("INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at) VALUES (?, 'impl', 1, 'a', 'closed', 'x')").run(id);
    const s = seams();
    await autopilotSweep({
      store, projectId: () => projectId, manifest: () => ({ autopilot: cfg }) as never,
      caps: () => ({ perParent: 2, total: 4 }), seamsFor: () => s, debug: () => {}, changed: () => {},
    });
    expect(s.sendCi).not.toHaveBeenCalled();
    expect((store.db.prepare('SELECT title FROM bulletin_notes').get() as { title: string }).title).toBe('Autopilot: auto-fix not run: graph ticket');
  });

  it('arms a CI round for a ship ticket and writes a bulletin note', async () => {
    const { store, projectId } = shipTicket();
    const changed = vi.fn();
    const s = seams();
    const acted = await autopilotSweep({
      store, projectId: () => projectId, manifest: () => ({ autopilot: cfg }) as never,
      caps: () => ({ perParent: 2, total: 4 }), seamsFor: () => s, debug: () => {}, changed,
    });
    expect(acted).toBe(1);
    expect(s.sendCi).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM bulletin_notes').get() as { n: number }).n).toBe(1);
  });

  it('does nothing without a bound project, and when this window does not control the ticket', async () => {
    const { store, projectId } = shipTicket();
    const s = seams({ controls: () => false });
    const base = { store, manifest: () => ({ autopilot: cfg }) as never, caps: () => ({ perParent: 2, total: 4 }), seamsFor: () => s, debug: () => {}, changed: () => {} };
    expect(await autopilotSweep({ ...base, projectId: () => undefined })).toBe(0);
    expect(await autopilotSweep({ ...base, projectId: () => projectId })).toBe(0);
    expect(s.sendCi).not.toHaveBeenCalled();
  });
});

describe('ciOutcome', () => {
  const failingChecks = { state: 'failing', total: 1, passed: 0, failed: 1, pending: 0, failedShown: 1, failing: [{ name: 'build', url: 'u' }] };
  function rig(withFailure = true) {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'CI-1', title: 't' }).id;
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
    setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked: not merged yet', runAt: '2026-08-09T10:00:00.000Z', gates: [] });
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
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked: not merged yet', runAt: '2026-08-09T10:00:00.000Z', gates: [] });
    const d = base(store, projectId, { seamsFor: () => { throw new Error('boom'); } });
    expect(await autopilotSweep(d)).toBe(0);
    expect(d.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-7: sweep failed (boom)');
    expect(d.changed).not.toHaveBeenCalled();
  });

  it('describes a non-Error throw', async () => {
    const { store, projectId, id } = setup();
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
    setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked: not merged yet', runAt: '2026-08-09T10:00:00.000Z', gates: [] });
    const d = base(store, projectId, { seamsFor: () => { throw 'bad'; } });
    await autopilotSweep(d);
    expect(d.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-7: sweep failed (bad)');
  });
});

describe('listSlotHolders', () => {
  it('lists sub-tasks in a slot stage, and a ship sub-task whose agent runs (a conflict round); a plain ticket holds no slot', () => {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const parent = createTicket(store, { key: 'P-1', title: 'p', projectId: project.id }).id;
    const inImpl = createTicket(store, { key: 'S-1', title: 's', projectId: project.id, subtaskParentId: parent }).id;
    const inShip = createTicket(store, { key: 'S-2', title: 's', projectId: project.id, subtaskParentId: parent }).id;
    const idleShip = createTicket(store, { key: 'S-3', title: 's', projectId: project.id, subtaskParentId: parent }).id;
    const plain = createTicket(store, { key: 'T-1', title: 't', projectId: project.id }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id IN (?, ?)").run(inImpl, plain);
    store.db.prepare("UPDATE tickets SET stage_current = 'ship', agent_state = 'running' WHERE id = ?").run(inShip);
    store.db.prepare("UPDATE tickets SET stage_current = 'ship', agent_state = 'idle' WHERE id = ?").run(idleShip);
    expect(listSlotHolders(store, project.id)).toEqual([{ id: inImpl, subtaskParentId: parent }, { id: inShip, subtaskParentId: parent }]);
  });
});

describe('postAutopilotNote', () => {
  function setup() {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const id = createTicket(store, { key: 'AP-7', title: 't', projectId: project.id }).id;
    return { store, id, projectId: project.id };
  }
  const rows = (store: ReturnType<typeof openStore>) =>
    store.db.prepare('SELECT title, body FROM bulletin_notes').all() as Array<{ title: string; body: string }>;

  it('keeps the note when the park reason is long and has several lines', () => {
    const { store, id, projectId } = setup();
    const debug = vi.fn();
    const reason = `auto-fix stopped: ci could not run (gh failed\n${'x'.repeat(400)})`;
    postAutopilotNote(store, projectId, id, `Autopilot: ${reason}`, 'b'.repeat(BULLETIN_BODY_MAX + 50), debug);
    const [row] = rows(store);
    expect(row!.title).not.toContain('\n');
    expect(row!.title.length).toBeLessThanOrEqual(BULLETIN_TITLE_MAX);
    expect(row!.title.startsWith('Autopilot: auto-fix stopped: ci could not run (gh failed x')).toBe(true);
    expect(row!.body.length).toBe(BULLETIN_BODY_MAX);
    expect(debug).not.toHaveBeenCalled();
  });

  it('clips a long title to the title limit and ends it with an ellipsis', () => {
    const { store, id, projectId } = setup();
    postAutopilotNote(store, projectId, id, 'T'.repeat(BULLETIN_TITLE_MAX + 80), 'body', vi.fn());
    const [row] = rows(store);
    expect(row!.title).toHaveLength(BULLETIN_TITLE_MAX);
    expect(row!.title.endsWith('\u2026')).toBe(true);
  });

  it('turns a multi-line title into one line', () => {
    const { store, id, projectId } = setup();
    postAutopilotNote(store, projectId, id, 'first\nsecond\r\n  third', 'body', vi.fn());
    expect(rows(store)[0]!.title).toBe('first second third');
  });

  it('removes a control character from the title and the body', () => {
    const { store, id, projectId } = setup();
    const debug = vi.fn();
    postAutopilotNote(store, projectId, id, 'bad\u0000\u0007title\u007f', 'bo\u0001dy', debug);
    const [row] = rows(store);
    expect(row!.title).toBe('bad title');
    expect(row!.body).toBe('bo dy');
    expect(debug).not.toHaveBeenCalled();
  });

  it('falls back to a fixed title and body when both are blank', () => {
    const { store, id, projectId } = setup();
    postAutopilotNote(store, projectId, id, ' \n ', '  ', vi.fn());
    expect(rows(store)[0]).toEqual({ title: 'Autopilot', body: 'Autopilot' });
  });

  it('logs and does not throw when the post still fails', () => {
    const { store, id } = setup();
    const debug = vi.fn();
    postAutopilotNote(store, 9999, id, 't', 'b', debug);
    expect(rows(store)).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('[ship] autopilot note failed'));
  });
});

describe('conflictOutcome', () => {
  const input = (briefFor: () => string | null) => ({ repo: 'r', label: 'T1', probeSandbox: async () => ({ state: 'absent' }), briefFor, notify: vi.fn(), deliver: vi.fn() }) as never;
  it('is sent when the round reached the agent', async () => {
    expect(await conflictOutcome(input(() => 'BRIEF'))).toEqual({ kind: 'sent' });
  });
  it('is failed, with the decline reason, when the round reached no agent', async () => {
    expect(await conflictOutcome(input(() => null))).toMatchObject({ kind: 'failed', reason: expect.stringContaining('nothing to resolve') });
  });
});
