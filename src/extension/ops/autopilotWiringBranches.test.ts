import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket } from '../../store/tickets.js';
import { BULLETIN_TITLE_MAX } from '../../store/bulletinNotes.js';
import { baseMovedFailureState } from '../../workflow/baseMovedFailure.js';
import { autopilotTick } from './autopilotOps.js';
import { sendGateFailureAction } from './ciActionsWiring.js';
import { autopilotSweep, gateFailureOutcome, postAutopilotNote, type TicketSeams } from './autopilotWiring.js';

vi.mock('./autopilotOps.js', () => ({ autopilotTick: vi.fn(async () => ({ kind: 'idle' })) }));
vi.mock('./ciActionsWiring.js', () => ({ sendCiFailureAction: vi.fn(), sendGateFailureAction: vi.fn() }));
vi.mock('../../workflow/baseMovedFailure.js', () => ({ baseMovedFailureState: vi.fn() }));

const cfg = { enabled: true, ci: { policy: 'auto' as const, maxAttempts: 3, checks: ['build'] }, conflicts: { policy: 'auto' as const, maxRounds: 2 } };

beforeEach(() => {
  vi.mocked(autopilotTick).mockReset();
  vi.mocked(autopilotTick).mockResolvedValue({ kind: 'idle' } as never);
  vi.mocked(sendGateFailureAction).mockReset();
  vi.mocked(baseMovedFailureState).mockReset();
});

describe('gateFailureOutcome', () => {
  const input = (store: Store, ticketId: number, debug = vi.fn(), handOff = vi.fn(() => null)) => ({ store, ticketId, debug, handOff }) as never;

  it('is failed, and never runs the action, when no base-moved run failed', async () => {
    vi.mocked(baseMovedFailureState).mockReturnValue({ available: false } as never);
    const store = openStore(':memory:');
    await expect(gateFailureOutcome(input(store, 1))).resolves.toEqual({ kind: 'failed', reason: 'no failed base-moved gate run to send' });
    expect(sendGateFailureAction).not.toHaveBeenCalled();
  });

  it('answers the confirm yes, logs with the ci tag and reports sent', async () => {
    vi.mocked(baseMovedFailureState).mockReturnValue({ available: true } as never);
    const debug = vi.fn();
    vi.mocked(sendGateFailureAction).mockImplementation(async (i) => {
      await expect(i.confirm('t', 'go?', 'ok')).resolves.toBe(true);
      i.info('sent it');
    });
    await expect(gateFailureOutcome(input(openStore(':memory:'), 12, debug))).resolves.toEqual({ kind: 'sent' });
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket T12 ci: sent it');
  });

  it('turns an action error into a failed outcome', async () => {
    vi.mocked(baseMovedFailureState).mockReturnValue({ available: true } as never);
    const debug = vi.fn();
    vi.mocked(sendGateFailureAction).mockImplementation(async (i) => { i.error('gh down'); });
    await expect(gateFailureOutcome(input(openStore(':memory:'), 12, debug))).resolves.toEqual({ kind: 'failed', reason: 'gh down' });
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket T12 ci error: gh down');
  });
});

describe('autopilotSweep seams and counts', () => {
  function setup() {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const ship = (title: string, parent?: number, projectId = project.id): number => {
      const id = createTicket(store, { key: title, title, projectId }).id;
      store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(id);
      if (parent !== undefined) store.db.prepare('UPDATE tickets SET subtask_parent_id = ? WHERE id = ?').run(parent, id);
      return id;
    };
    return { store, project, ship };
  }
  const base = (over: Partial<TicketSeams> = {}): TicketSeams => ({
    controls: () => true, sessionRunning: () => false, placement: async () => 'host', sendCi: async () => ({ kind: 'sent' }),
    sendConflict: async () => ({ kind: 'sent' }), conflictRoundActive: () => false, conflictRoundStalled: () => false, dropConflictRound: () => {}, ...over,
  });
  const run = (store: Store, projectId: number | undefined, seams: TicketSeams, over: { manifest?: () => never; caps?: () => { perParent: number; total: number }; debug?: (m: string) => void; changed?: () => void } = {}) =>
    autopilotSweep({
      store, projectId: () => projectId, manifest: over.manifest ?? (() => ({ autopilot: cfg }) as never), caps: over.caps ?? (() => ({ perParent: 0, total: 0 })),
      seamsFor: () => seams, debug: over.debug ?? (() => {}), changed: over.changed ?? (() => {}),
    });
  const lastInput = () => vi.mocked(autopilotTick).mock.calls.at(-1)![0];

  it('does nothing without a project', async () => {
    const { store, ship } = setup();
    ship('A');
    await expect(run(store, undefined, base())).resolves.toBe(0);
    expect(autopilotTick).not.toHaveBeenCalled();
  });

  it('ticks only the ship tickets of the project', async () => {
    const { store, project, ship } = setup();
    const other = upsertProject(store, { slug: 'q' });
    const mine = ship('MINE');
    ship('THEIRS', undefined, other.id);
    await run(store, project.id, base());
    expect(vi.mocked(autopilotTick).mock.calls.map((c) => c[0].ticketId)).toEqual([mine]);
  });

  it('gives the tick the ticket key, or its id form when the key is missing', async () => {
    const { store, project, ship } = setup();
    const id = ship('KEYED');
    await run(store, project.id, base());
    expect(lastInput().key).toBe('KEYED');
    store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(id);
    await run(store, project.id, base());
    expect(lastInput().key).toBe(`T${id}`);
  });

  it('reads the autopilot config from the manifest, and none without a manifest', async () => {
    const { store, project, ship } = setup();
    ship('A');
    await run(store, project.id, base());
    expect(lastInput().config()).toBe(cfg);
    await run(store, project.id, base(), { manifest: () => undefined as never });
    expect(lastInput().config()).toBeUndefined();
  });

  it('passes each optional seam only when the host gave it', async () => {
    const { store, project, ship } = setup();
    ship('A');
    await run(store, project.id, base());
    for (const key of ['sandboxPreflight', 'sendGateFailure', 'isDraining', 'resumeDeliver', 'localHead', 'transientCi', 'staleRebase']) expect(lastInput()).not.toHaveProperty(key);
    const given = {
      sandboxPreflight: async () => null, sendGateFailure: async () => ({ kind: 'sent' as const }), isDraining: () => false,
      resumeDeliver: async () => ({ kind: 'none' }) as never, localHead: async () => null, transientCi: {} as never, staleRebase: {} as never,
    };
    await run(store, project.id, base(given));
    for (const [key, value] of Object.entries(given)) expect(lastInput()).toHaveProperty(key, value);
  });

  it('counts a sub-task armed earlier in the pass as a held slot, and a plain ticket as none', async () => {
    const { store, project, ship } = setup();
    const parent = ship('PARENT');
    const a = ship('A', parent);
    const b = ship('B', parent);
    const full: boolean[] = [];
    vi.mocked(autopilotTick).mockImplementation(async (i) => { full.push(i.concurrencyFull()); return { kind: 'armed' } as never; });
    await run(store, project.id, base(), { caps: () => ({ perParent: 0, total: 1 }) });
    // Order: newest first. The parent has no sub-task parent and holds no slot.
    expect(vi.mocked(autopilotTick).mock.calls.map((c) => c[0].ticketId)).toEqual([b, a, parent]);
    expect(full.slice(0, 2)).toEqual([false, true]);
  });

  it('a plain ticket armed first holds no slot for the sub-task after it', async () => {
    const { store, project, ship } = setup();
    const parent = ship('PARENT');
    const sub = ship('SUB', parent);
    const plain = ship('PLAIN');
    const order: number[] = [];
    let fullForSub: boolean | undefined;
    vi.mocked(autopilotTick).mockImplementation(async (i) => {
      order.push(i.ticketId);
      if (i.ticketId === sub) fullForSub = i.concurrencyFull();
      return { kind: 'armed' } as never;
    });
    await run(store, project.id, base(), { caps: () => ({ perParent: 0, total: 1 }) });
    expect(order.indexOf(plain)).toBeLessThan(order.indexOf(sub));
    expect(fullForSub).toBe(false);
  });

  it.each(['armed', 'parked', 'cleared', 'rerun', 'rebased'])('counts a %s tick as an action and tells the host', async (kind) => {
    const { store, project, ship } = setup();
    ship('A');
    vi.mocked(autopilotTick).mockResolvedValue({ kind } as never);
    const changed = vi.fn();
    await expect(run(store, project.id, base(), { changed })).resolves.toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('counts a tick that did nothing as no action, and does not tell the host', async () => {
    const { store, project, ship } = setup();
    ship('A');
    const changed = vi.fn();
    await expect(run(store, project.id, base(), { changed })).resolves.toBe(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it('logs a failing tick with the key, or the id form without a key, and goes on', async () => {
    const { store, project, ship } = setup();
    const first = ship('FIRST');
    const second = ship('SECOND');
    store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(first);
    vi.mocked(autopilotTick).mockRejectedValueOnce(new Error('tick broke')).mockRejectedValueOnce('plain');
    const debug = vi.fn();
    await run(store, project.id, base(), { debug });
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket SECOND: sweep failed (tick broke)');
    expect(debug).toHaveBeenCalledWith(`[ship] autopilot ticket T${first}: sweep failed (plain)`);
    expect(second).toBeGreaterThan(first);
  });
});

describe('postAutopilotNote edges', () => {
  const rows = (store: Store) => store.db.prepare('SELECT title, body FROM bulletin_notes').all() as Array<{ title: string; body: string }>;
  function setup() {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const id = createTicket(store, { key: 'N-1', title: 't', projectId: project.id }).id;
    return { store, id, projectId: project.id };
  }

  it('keeps a title of exactly the limit whole', () => {
    const { store, id, projectId } = setup();
    const title = 'T'.repeat(BULLETIN_TITLE_MAX);
    postAutopilotNote(store, projectId, id, title, 'body', vi.fn());
    expect(rows(store)[0]!.title).toBe(title);
  });

  it('trims the blanks around the body', () => {
    const { store, id, projectId } = setup();
    postAutopilotNote(store, projectId, id, 'title', '  \n body text \n ', vi.fn());
    expect(rows(store)[0]!.body).toBe('body text');
  });
});
