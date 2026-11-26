import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, setAgentState } from '../store/tickets.js';
import { claimAutopilotTicket, syncAutopilotSessionOwner } from '../store/autopilot.js';
import { startAutopilot, makePlacementCheck, registerAutopilotCommands, type AutopilotBindingDeps } from './autopilotBinding.js';
import { autopilotSweep, ciOutcome, conflictOutcome, gateFailureOutcome, postAutopilotNote } from './ops/autopilotWiring.js';
import { gitFor, headShaOf, rebaseOnBaseAction } from './ops/ciActionsWiring.js';
import { resumeFinishedMerge } from './ops/conflictResumeOps.js';
import { verifyMergeResolved, conflictRoundEnded } from './ops/autoDeliverOps.js';
import { deliverTargets } from '../workflow/deliverState.js';
import { makeBaseRedSeams, makeTransientCiSeams } from '../integrations/ciRerun.js';
import { roundDied } from './ops/autopilotOps.js';
import { approveCommand, retryCommand, setOverrideCommand, stopCommand } from './ops/autopilotCommandOps.js';

vi.mock('./ops/autopilotWiring.js', () => ({
  autopilotSweep: vi.fn(async () => {}), ciOutcome: vi.fn(), gateFailureOutcome: vi.fn(), conflictOutcome: vi.fn(), postAutopilotNote: vi.fn(),
}));
vi.mock('./ops/ciActionsWiring.js', () => ({ rebaseOnBaseAction: vi.fn(async () => true), gitFor: vi.fn(() => 'GIT'), headShaOf: vi.fn(async () => 'HEAD') }));
vi.mock('./ops/conflictResumeOps.js', () => ({ resumeFinishedMerge: vi.fn(async () => 'resumed') }));
vi.mock('./ops/autoDeliverOps.js', () => ({ conflictRounds: 'ROUNDS', verifyMergeResolved: vi.fn(() => 'VERIFIED'), conflictRoundEnded: vi.fn(async () => true) }));
vi.mock('../workflow/deliverState.js', () => ({ deliverTargets: vi.fn() }));
vi.mock('../integrations/ciRerun.js', () => ({
  makeTransientCiSeams: vi.fn(() => ({ readJobLog: 'RJL', readRunHeadSha: 'RRS' })),
  makeBaseRedSeams: vi.fn((_gh: unknown, rebase: unknown) => ({ kind: 'BASE_RED', rebase })),
  createBaseRedMemo: vi.fn(() => new Map()),
}));
vi.mock('./ops/autopilotOps.js', () => ({ roundDied: vi.fn(() => null) }));
vi.mock('./ops/autopilotCommandOps.js', () => ({
  approveCommand: vi.fn(async () => 'approve'), retryCommand: vi.fn(async () => 'retry'), setOverrideCommand: vi.fn(async () => 'override'), stopCommand: vi.fn(async () => 'stop'),
}));

const INTERVAL = 1000;
const NOW = 5_000_000;
const COOLDOWN = 120_000;

type Seams = Parameters<typeof autopilotSweep>[0]['seamsFor'] extends (id: number) => infer S ? S : never;

function rig(over: Partial<AutopilotBindingDeps> = {}) {
  const store = openStore(':memory:');
  const id = createTicket(store, { key: 'SEAM-1', title: 't' }).id;
  const debug = vi.fn();
  const ciInput = vi.fn((ticketId: number) => ({ ticketId, tag: 'ci' }) as never);
  const deps: AutopilotBindingDeps = {
    store, projectId: () => 7, manifest: () => undefined, caps: () => ({ perParent: 1, total: 1 }), debug, changed: vi.fn(),
    intervalMs: INTERVAL, windowId: 'W', isLive: () => false, now: () => NOW, ciInput,
    conflictInput: vi.fn((ticketId: number, repo: string) => ({ ticketId, repo }) as never), conflictRoundActive: () => false, conflictRoundStalled: () => false,
    dropConflictRound: vi.fn(), takeLaunch: () => undefined, placement: async () => 'host', ...over,
  };
  return { deps, store, id, debug, ciInput };
}

/** Start the engine, fire one sweep tick and give back the seams the sweep got for the ticket. */
function open(r: ReturnType<typeof rig>) {
  const handle = startAutopilot(r.deps);
  vi.advanceTimersByTime(INTERVAL);
  const args = vi.mocked(autopilotSweep).mock.calls.at(-1)![0];
  return { handle, args, seams: args.seamsFor(r.id) as Seams };
}

const lease = (r: ReturnType<typeof rig>): number =>
  (r.store.db.prepare('SELECT claim_until AS u FROM autopilot_tickets WHERE ticket_id = ?').get(r.id) as { u: number }).u;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(autopilotSweep).mockReset();
  vi.mocked(autopilotSweep).mockImplementation(async () => 0);
  vi.mocked(ciOutcome).mockReset();
  vi.mocked(gateFailureOutcome).mockReset();
  vi.mocked(conflictOutcome).mockReset();
  vi.mocked(postAutopilotNote).mockReset();
  vi.mocked(resumeFinishedMerge).mockClear();
  vi.mocked(deliverTargets).mockReset();
  vi.mocked(headShaOf).mockClear();
  vi.mocked(rebaseOnBaseAction).mockClear();
  vi.mocked(makeTransientCiSeams).mockClear();
  vi.mocked(roundDied).mockReset();
  vi.mocked(roundDied).mockImplementation(() => null);
});
afterEach(() => vi.useRealTimers());

describe('the seams of one ticket', () => {
  it('send each kind of round through its own outcome with the ticket inputs', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'skipped' } as never);
    vi.mocked(gateFailureOutcome).mockResolvedValue({ kind: 'skipped' } as never);
    vi.mocked(conflictOutcome).mockResolvedValue({ kind: 'skipped' } as never);
    const r = rig();
    const { handle, seams } = open(r);
    await expect(seams.sendCi()).resolves.toEqual({ kind: 'skipped' });
    await expect(seams.sendGateFailure!()).resolves.toEqual({ kind: 'skipped' });
    await expect(seams.sendConflict('repo-a')).resolves.toEqual({ kind: 'skipped' });
    expect(ciOutcome).toHaveBeenCalledWith({ ticketId: r.id, tag: 'ci' });
    expect(gateFailureOutcome).toHaveBeenCalledWith({ ticketId: r.id, tag: 'ci' });
    expect(conflictOutcome).toHaveBeenCalledWith({ ticketId: r.id, repo: 'repo-a' });
    handle.dispose();
  });

  it('delegate the conflict round state and the drop to the deps', () => {
    const dropConflictRound = vi.fn();
    const r = rig({ conflictRoundActive: (t) => t === 1, conflictRoundStalled: (t) => t !== 1, dropConflictRound });
    const { handle, seams } = open(r);
    expect(seams.conflictRoundActive()).toBe(r.id === 1);
    expect(seams.conflictRoundStalled()).toBe(r.id !== 1);
    seams.dropConflictRound();
    expect(dropConflictRound).toHaveBeenCalledWith(r.id);
    handle.dispose();
  });

  it('leaves the ship-retry seams absent until the host finished wiring them (T1362)', async () => {
    let ready = false;
    const shipRetry = vi.fn(() => ({ worktreeClean: async () => ({ ok: true as const, clean: true }), localHead: async () => 'h' }));
    const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
    const r = rig({ ready: () => ready, shipRetry, retryShip });
    const handle = startAutopilot(r.deps);
    vi.advanceTimersByTime(INTERVAL);
    const before = vi.mocked(autopilotSweep).mock.calls.at(-1)![0].seamsFor(r.id) as Seams;
    expect(before.shipRetry).toBeUndefined();
    expect(before.retryShip).toBeUndefined();
    ready = true;
    vi.advanceTimersByTime(INTERVAL);
    const after = vi.mocked(autopilotSweep).mock.calls.at(-1)![0].seamsFor(r.id) as Seams;
    expect(after.shipRetry).toBe(shipRetry.mock.results.at(-1)!.value);
    expect(after.retryShip).toBeTypeOf('function');
    handle.dispose();
  });

  it('holds the ticket lease for a whole round while the ship retry runs (T1362)', async () => {
    const during: number[] = [];
    const shipRetry = () => ({ worktreeClean: async () => ({ ok: true as const, clean: true }), localHead: async () => 'h' });
    const retryShip = vi.fn(async () => { during.push(lease(r)); return { kind: 'sent' as const }; });
    const r = rig({ shipRetry, retryShip });
    const { handle, seams } = open(r);
    await seams.retryShip!(['repo-a']);
    expect(during).toEqual([NOW + COOLDOWN]);
    expect(lease(r)).toBe(NOW + INTERVAL * 3);
    handle.dispose();
  });

  it('reports busy instead of retrying when another window holds the lease (T1362)', async () => {
    const shipRetry = () => ({ worktreeClean: async () => ({ ok: true as const, clean: true }), localHead: async () => 'h' });
    const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
    const r = rig({ shipRetry, retryShip });
    claimAutopilotTicket(r.store, r.id, 'OTHER-WINDOW', NOW, COOLDOWN);
    const { handle, seams } = open(r);
    await expect(seams.retryShip!(['repo-a'])).resolves.toEqual({ kind: 'busy' });
    expect(retryShip).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('forwards the ship-retry seams for the ticket (T1362)', async () => {
    const shipRetry = vi.fn(() => ({ worktreeClean: async () => ({ ok: true as const, clean: true }), localHead: async () => 'h' }));
    const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
    const r = rig({ shipRetry, retryShip });
    const { handle, seams } = open(r);
    expect(seams.shipRetry).toBe(shipRetry.mock.results[0]!.value);
    await expect(seams.retryShip!(['repo-a'])).resolves.toEqual({ kind: 'sent' });
    expect(retryShip).toHaveBeenCalledWith(r.id, ['repo-a']);
    handle.dispose();
  });

  it('pass the optional seams only when the deps carry them', () => {
    const bare = open(rig());
    expect(Object.keys(bare.seams)).not.toEqual(expect.arrayContaining(['isDraining', 'resumeDeliver', 'transientCi', 'staleRebase', 'baseRed', 'sandboxPreflight']));
    bare.handle.dispose();
    const isDraining = (): boolean => true;
    const sandboxPreflight = vi.fn(async () => 'blocked');
    const full = open(rig({ isDraining, startAutoDeliver: vi.fn(), gh: vi.fn() as never, sandboxPreflight }));
    expect(full.seams.isDraining).toBe(isDraining);
    expect(full.seams.resumeDeliver).toBeTypeOf('function');
    expect(full.seams.transientCi).toEqual({ readJobLog: 'RJL', readRunHeadSha: 'RRS' });
    expect(full.seams.staleRebase).toBeDefined();
    expect(full.seams.baseRed).toEqual({ kind: 'BASE_RED', rebase: expect.any(Function) });
    expect(full.seams.sandboxPreflight).toBeTypeOf('function');
    full.handle.dispose();
  });

  it('the preflight and the placement read the ticket of the seams', async () => {
    const sandboxPreflight = vi.fn(async () => 'blocked');
    const placement = vi.fn(async () => 'sandbox' as const);
    const r = rig({ sandboxPreflight, placement });
    const { handle, seams } = open(r);
    await expect(seams.sandboxPreflight!()).resolves.toBe('blocked');
    await expect(seams.placement()).resolves.toBe('sandbox');
    expect(sandboxPreflight).toHaveBeenCalledWith(r.id);
    expect(placement).toHaveBeenCalledWith(r.id);
    handle.dispose();
  });

  it('localHead reads the head of the PR of the repo, or null', async () => {
    const r = rig();
    const { handle, seams } = open(r);
    vi.mocked(deliverTargets).mockReturnValue({ available: true, prs: [{ repo: 'a', cwd: '/a' }, { repo: 'b', cwd: '/b' }] } as never);
    vi.mocked(headShaOf).mockResolvedValue('SHA-B');
    await expect(seams.localHead!('b')).resolves.toBe('SHA-B');
    expect(headShaOf).toHaveBeenCalledWith({ ticketId: r.id, tag: 'ci' }, '/b');
    vi.mocked(headShaOf).mockClear();
    await expect(seams.localHead!('c')).resolves.toBeNull();
    vi.mocked(deliverTargets).mockReturnValue({ available: false, prs: [{ repo: 'a', cwd: '/a' }] } as never);
    await expect(seams.localHead!('a')).resolves.toBeNull();
    expect(headShaOf).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('the round-end seam reads the open PR head and the worktree of its repo', async () => {
    const r = rig();
    r.store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_oid) VALUES (?, ?, 5, ?, ?, ?)').run(r.id, 'a', 'u', 'open', 'PR-A');
    r.store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_oid) VALUES (?, ?, 6, ?, ?, ?)').run(r.id, 'b', 'u', 'closed', 'PR-B');
    vi.mocked(deliverTargets).mockReturnValue({ available: true, prs: [{ repo: 'a', cwd: '/wt/a' }] } as never);
    const { handle, seams } = open(r);
    await expect(seams.conflictRoundEnded!()).resolves.toBe(true);
    const args = vi.mocked(conflictRoundEnded).mock.calls[0]![0];
    expect(args).toMatchObject({ store: r.store, ticketId: r.id, rounds: 'ROUNDS', git: 'GIT' });
    expect(args.prHead('a')).toBe('PR-A');
    expect(args.prHead('b')).toBeNull(); // a closed PR never ends a round
    expect(args.cwd('a')).toBe('/wt/a');
    expect(args.cwd('z')).toBeNull();
    vi.mocked(deliverTargets).mockReturnValue({ available: false, prs: [{ repo: 'a', cwd: '/wt/a' }] } as never);
    await seams.conflictRoundEnded!();
    expect(vi.mocked(conflictRoundEnded).mock.calls[1]![0].cwd('a')).toBeNull();
    handle.dispose();
  });

  it('the resume of a finished merge gets the ticket seams', async () => {
    const startAutoDeliver = vi.fn();
    const r = rig({ startAutoDeliver });
    const { handle, seams } = open(r);
    await expect(seams.resumeDeliver!(true)).resolves.toBe('resumed');
    const [resumeDeps, fromRound] = vi.mocked(resumeFinishedMerge).mock.calls[0]!;
    expect(fromRound).toBe(true);
    expect(resumeDeps).toMatchObject({ store: r.store, ticketId: r.id, rounds: 'ROUNDS', debug: r.debug });
    const targets = { available: true, prs: [] };
    vi.mocked(deliverTargets).mockReturnValue(targets as never);
    expect(resumeDeps.targets()).toBe(targets);
    expect(deliverTargets).toHaveBeenCalledWith(r.store, r.id);
    vi.mocked(headShaOf).mockResolvedValue('H1');
    await expect(resumeDeps.headOf('/cwd')).resolves.toBe('H1');
    expect(headShaOf).toHaveBeenCalledWith({ ticketId: r.id, tag: 'ci' }, '/cwd');
    expect(resumeDeps.verify('/cwd', 3 as never)).toBe('VERIFIED');
    expect(gitFor).toHaveBeenCalledWith({ ticketId: r.id, tag: 'ci' });
    expect(verifyMergeResolved).toHaveBeenCalledWith('GIT', '/cwd', 3);
    resumeDeps.startDeliver();
    expect(startAutoDeliver).toHaveBeenCalledWith(r.id);
    handle.dispose();
  });

  it('the stale rebase reads the manifest commands and holds the ticket for the rebase', async () => {
    const manifest = { repositories: { r: { ship: { regenerate: ['one', { run: 'two' }] } } } };
    const r = rig({ gh: vi.fn() as never, manifest: () => manifest as never });
    const { handle, seams } = open(r);
    const stale = seams.staleRebase!;
    expect(stale.readJobLog).toBe('RJL');
    expect(stale.readRunHeadSha).toBe('RRS');
    expect(stale.regenerate('r')).toEqual(['one', 'two']);
    expect(stale.regenerate('other')).toEqual([]);
    vi.mocked(rebaseOnBaseAction).mockImplementation(async (_i, entriesOf, opts) => {
      expect(entriesOf('r')).toEqual(['one', { run: 'two' }]);
      expect(opts).toEqual({ repos: new Set(['r']) });
      expect(lease(r)).toBe(NOW + COOLDOWN);
      return true;
    });
    await expect(stale.rebase('r')).resolves.toBe(true);
    expect(rebaseOnBaseAction).toHaveBeenCalledTimes(1);
    expect(lease(r)).toBe(NOW + INTERVAL * 3);
    handle.dispose();
  });

  it('rebases for base red through the held Rebase on base (T1383)', async () => {
    const r = rig({ gh: vi.fn() as never });
    const { handle, seams } = open(r);
    vi.mocked(rebaseOnBaseAction).mockImplementation(async () => {
      expect(lease(r)).toBe(NOW + COOLDOWN);
      return true;
    });
    await expect((seams.baseRed as unknown as { rebase: (repo: string) => Promise<boolean> }).rebase('repo-a')).resolves.toBe(true);
    expect(rebaseOnBaseAction).toHaveBeenCalledWith(expect.anything(), expect.any(Function), { repos: new Set(['repo-a']) });
    expect(lease(r)).toBe(NOW + INTERVAL * 3);
    handle.dispose();
  });

  it('gives the base-red seams of every sweep the same develop-job memo (T1383 review)', () => {
    const r = rig({ gh: vi.fn() as never });
    const handle = startAutopilot(r.deps);
    vi.advanceTimersByTime(INTERVAL);
    vi.mocked(autopilotSweep).mock.calls.at(-1)![0].seamsFor(r.id);
    vi.advanceTimersByTime(INTERVAL);
    vi.mocked(autopilotSweep).mock.calls.at(-1)![0].seamsFor(r.id);
    const memos = vi.mocked(makeBaseRedSeams).mock.calls.slice(-2).map((c) => c[2]);
    expect(memos[0]).toBeInstanceOf(Map);
    expect(memos[1]).toBe(memos[0]);
    handle.dispose();
  });

  it('the stale rebase runs nothing when another window holds the ticket', async () => {
    const r = rig({ gh: vi.fn() as never });
    const { handle, seams } = open(r);
    claimAutopilotTicket(r.store, r.id, 'OTHER', NOW, COOLDOWN);
    await expect(seams.staleRebase!.rebase('r')).resolves.toBe(false);
    expect(rebaseOnBaseAction).not.toHaveBeenCalled();
    handle.dispose();
  });
});

describe('a round that goes out', () => {
  it('marks the round for the ticket while it runs, and clears the mark after', async () => {
    const marks: Array<[number, boolean]> = [];
    vi.mocked(ciOutcome).mockImplementation(async () => { expect(marks).toEqual([[1, true]]); return { kind: 'skipped' } as never; });
    const r = rig({ markRound: (t, on) => { marks.push([t, on]); } });
    const { handle, seams } = open(r);
    await seams.sendCi();
    expect(marks).toEqual([[r.id, true], [r.id, false]]);
    handle.dispose();
  });

  it('clears the mark when the outcome throws', async () => {
    vi.mocked(ciOutcome).mockRejectedValue(new Error('boom'));
    const marks: boolean[] = [];
    const r = rig({ markRound: (_t, on) => { marks.push(on); } });
    const { handle, seams } = open(r);
    await expect(seams.sendCi()).rejects.toThrow('boom');
    expect(marks).toEqual([true, false]);
    handle.dispose();
  });

  it('is lease-lost when another window holds the ticket, and runs no outcome', async () => {
    const r = rig();
    const { handle, seams } = open(r);
    claimAutopilotTicket(r.store, r.id, 'OTHER', NOW, COOLDOWN);
    await expect(seams.sendCi()).resolves.toEqual({ kind: 'lease-lost' });
    expect(ciOutcome).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('a round that did not go out frees the cooldown and gives the short lease back', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'skipped' } as never);
    const r = rig();
    const { handle, seams } = open(r);
    await seams.sendCi();
    expect(lease(r)).toBe(NOW + INTERVAL * 3);
    expect(seams.controls()).toBe(true);
    handle.dispose();
  });

  it('a round that went out keeps the cooldown until its last millisecond', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'sent' } as never);
    let now = NOW;
    const r = rig({ now: () => now });
    const { handle, seams } = open(r);
    await expect(seams.sendCi()).resolves.toEqual({ kind: 'sent' });
    expect(lease(r)).toBe(NOW + COOLDOWN);
    now = NOW + COOLDOWN - 1;
    expect(seams.controls()).toBe(false);
    now = NOW + COOLDOWN;
    expect(seams.controls()).toBe(true);
    handle.dispose();
  });

  it('a failed launch of a host ticket is a failed round with the reason', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'sent' } as never);
    const r = rig({ takeLaunch: () => Promise.resolve({ kind: 'failed', reason: 'no terminal' }) as never });
    const { handle, seams } = open(r);
    await expect(seams.sendCi()).resolves.toEqual({ kind: 'failed', reason: 'session launch failed: no terminal' });
    handle.dispose();
  });

  it('a failed launch is read as a host launch when the placement is not known', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'sent' } as never);
    const r = rig({ takeLaunch: () => Promise.resolve({ kind: 'failed', reason: 'x' }) as never, placement: async () => { throw new Error('none'); } });
    const { handle, seams } = open(r);
    await expect(seams.sendCi()).resolves.toEqual({ kind: 'failed', reason: 'session launch failed: x' });
    handle.dispose();
  });

  it('a failed launch of a sandbox ticket is an environment blocker with the reason', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'sent' } as never);
    const r = rig({ takeLaunch: () => Promise.resolve({ kind: 'failed', reason: 'read-only' }) as never, placement: async () => 'sandbox' });
    const { handle, seams } = open(r);
    await expect(seams.sendCi()).resolves.toEqual({ kind: 'env-blocker', reason: 'read-only' });
    handle.dispose();
  });

  it('a launch that is not a failure keeps the sent outcome', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'sent' } as never);
    const r = rig({ takeLaunch: () => Promise.resolve({ kind: 'not-applicable' }) as never });
    const { handle, seams } = open(r);
    await expect(seams.sendCi()).resolves.toEqual({ kind: 'sent' });
    handle.dispose();
  });
});

describe('who controls the ticket', () => {
  it('the session is running only while this window holds it and the agent works', () => {
    const r = rig();
    const { handle, seams } = open(r);
    setAgentState(r.store, r.id, 'running');
    expect(seams.sessionRunning()).toBe(false);
    handle.dispose();
    const live = rig({ isLive: () => true });
    const opened = open(live);
    expect(opened.seams.sessionRunning()).toBe(false);
    for (const [state, expected] of [['running', true], ['waiting', true], ['idle', false]] as const) {
      setAgentState(live.store, live.id, state);
      expect(opened.seams.sessionRunning()).toBe(expected);
    }
    opened.handle.dispose();
  });

  it('a live session here controls the ticket even when the store names another window', () => {
    const r = rig({ isLive: () => true });
    syncAutopilotSessionOwner(r.store, 'OTHER', [r.id]);
    const { handle } = open(r);
    expect(handle.controlsTicket(r.id)).toBe(true);
    handle.dispose();
  });

  it('another window that holds the session blocks the round, and the log names it', () => {
    const r = rig();
    syncAutopilotSessionOwner(r.store, 'OTHER', [r.id]);
    const { handle } = open(r);
    expect(handle.controlsTicket(r.id)).toBe(false);
    expect(r.debug).toHaveBeenCalledWith(`[ship] autopilot ticket ${r.id}: no round, window OTHER holds the session (a closed window leaves its row until a window syncs)`);
    handle.dispose();
  });

  it('a stored owner that is this window does not block the round', () => {
    const r = rig();
    syncAutopilotSessionOwner(r.store, 'W', [r.id]);
    const { handle } = open(r);
    expect(handle.controlsTicket(r.id)).toBe(true);
    expect(r.debug).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('an active agent with no known window blocks the round, and the log says so', () => {
    const r = rig();
    setAgentState(r.store, r.id, 'waiting');
    const { handle } = open(r);
    expect(handle.controlsTicket(r.id)).toBe(false);
    expect(r.debug).toHaveBeenCalledWith(`[ship] autopilot ticket ${r.id}: no round, the window that holds the session is not known`);
    handle.dispose();
  });

  it('controls takes the lease of a few intervals', () => {
    const r = rig();
    const { handle, seams } = open(r);
    expect(seams.controls()).toBe(true);
    expect(lease(r)).toBe(NOW + INTERVAL * 3);
    handle.dispose();
  });

  it('a cooling ticket whose session runs is not cooling', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'sent' } as never);
    const r = rig({ isLive: () => true });
    const { handle, seams } = open(r);
    await seams.sendCi();
    setAgentState(r.store, r.id, 'idle');
    expect(seams.controls()).toBe(false);
    setAgentState(r.store, r.id, 'running');
    expect(seams.controls()).toBe(true);
    handle.dispose();
  });
});

describe('the sweep timer', () => {
  it('runs one sweep at a time, and the next after the first ends', async () => {
    let finish: () => void = () => {};
    vi.mocked(autopilotSweep).mockImplementation(() => new Promise<number>((resolve) => { finish = () => resolve(0); }));
    const r = rig();
    const handle = startAutopilot(r.deps);
    vi.advanceTimersByTime(INTERVAL * 3);
    expect(autopilotSweep).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(INTERVAL);
    expect(autopilotSweep).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it('logs a failed sweep and runs the next one', async () => {
    vi.mocked(autopilotSweep).mockRejectedValueOnce(new Error('sweep broke')).mockRejectedValueOnce('plain text');
    const r = rig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot sweep failed: sweep broke');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(r.debug).toHaveBeenCalledWith('[ship] autopilot sweep failed: plain text');
    handle.dispose();
  });

  it('hands the sweep the store, the project and the caps of the deps', () => {
    const r = rig();
    const { handle, args } = open(r);
    expect(args).toMatchObject({ store: r.store, projectId: r.deps.projectId, manifest: r.deps.manifest, caps: r.deps.caps, debug: r.debug, changed: r.deps.changed });
    handle.dispose();
  });

  it('dispose logs a failed release of the session rows', () => {
    const r = rig();
    const { handle } = open(r);
    r.store.db.close();
    handle.dispose();
    expect(r.debug).toHaveBeenCalledWith(expect.stringMatching(/^\[ship\] autopilot: release of the session rows failed \(.+\)$/));
  });
});

describe('roundDied', () => {
  it('passes the ticket key, the detail and the seams to the engine, and tells the host of a change', () => {
    vi.mocked(roundDied).mockReturnValue({ paused: true } as never);
    const dropConflictRound = vi.fn();
    const r = rig({ dropConflictRound });
    const { handle } = open(r);
    handle.roundDied(r.id, 'it died');
    const [input, detail] = vi.mocked(roundDied).mock.calls[0]!;
    expect(detail).toBe('it died');
    expect(input).toMatchObject({ store: r.store, ticketId: r.id, key: 'SEAM-1', debug: r.debug });
    input.dropConflictRound();
    expect(dropConflictRound).toHaveBeenCalledWith(r.id);
    input.note('title', 'body');
    expect(postAutopilotNote).toHaveBeenCalledWith(r.store, 7, r.id, 'title', 'body', r.debug);
    expect(r.deps.changed).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('writes no note without a project, and tells the host of no change when nothing died', () => {
    const r = rig({ projectId: () => undefined });
    const { handle } = open(r);
    handle.roundDied(r.id, 'x');
    vi.mocked(roundDied).mock.calls[0]![0].note('t', 'b');
    expect(postAutopilotNote).not.toHaveBeenCalled();
    expect(r.deps.changed).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('names a ticket with no key by its id, and drops the cooldown of the ticket', async () => {
    vi.mocked(ciOutcome).mockResolvedValue({ kind: 'sent' } as never);
    const r = rig();
    r.store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(r.id);
    const { handle, seams } = open(r);
    await seams.sendCi();
    expect(seams.controls()).toBe(false);
    handle.roundDied(r.id, 'x');
    expect(vi.mocked(roundDied).mock.calls[0]![0].key).toBe(String(r.id));
    expect(seams.controls()).toBe(true);
    handle.dispose();
  });
});

describe('makePlacementCheck', () => {
  it('rejects with the reason when no placement is recorded', async () => {
    await expect(makePlacementCheck(() => null)(4)).rejects.toThrow('no placement is recorded for the ticket');
    await expect(makePlacementCheck(() => ({ backend: 'host' }))(4)).resolves.toBe('host');
  });
});

describe('registerAutopilotCommands (handlers)', () => {
  function register() {
    const handlers = new Map<string, (...a: never[]) => unknown>();
    const showQuickPick = vi.fn();
    const host = { commands: { registerCommand: (c: string, h: (...a: never[]) => unknown) => { handlers.set(c, h); return { dispose() {} }; } }, window: { showQuickPick } };
    const debug = vi.fn();
    registerAutopilotCommands(host as never, { store: openStore(':memory:'), projectId: () => 1, debug, stopSession: async () => true, dropConflictRound: () => {} });
    return { handlers, showQuickPick, debug };
  }
  const depsOf = (fn: unknown): Parameters<typeof setOverrideCommand>[0] => vi.mocked(fn as typeof setOverrideCommand).mock.calls.at(-1)![0];

  it('each handler runs its command with the arguments and gives the result back', async () => {
    const { handlers } = register();
    const target = { repo: 'r', kind: 'ci' } as never;
    await expect((handlers.get('karst.autopilot.setOverride') as (...a: unknown[]) => unknown)(3, 'on')).resolves.toBe('override');
    expect(setOverrideCommand).toHaveBeenLastCalledWith(expect.anything(), 3, 'on');
    await expect((handlers.get('karst.autopilot.approveOne') as (...a: unknown[]) => unknown)(4, target)).resolves.toBe('approve');
    expect(approveCommand).toHaveBeenLastCalledWith(expect.anything(), 4, target);
    await expect((handlers.get('karst.autopilot.retry') as (...a: unknown[]) => unknown)(5)).resolves.toBe('retry');
    expect(retryCommand).toHaveBeenLastCalledWith(expect.anything(), 5);
    await expect((handlers.get('karst.autopilot.stop') as (...a: unknown[]) => unknown)(6, 'now')).resolves.toBe('stop');
    expect(stopCommand).toHaveBeenLastCalledWith(expect.anything(), 6, 'now');
  });

  it('the ticket picker gives the id of the pick, or undefined when the pick is cancelled', async () => {
    const { handlers, showQuickPick } = register();
    await (handlers.get('karst.autopilot.retry') as () => unknown)();
    const d = depsOf(retryCommand);
    showQuickPick.mockResolvedValueOnce({ label: 'T', ticketId: 9 });
    await expect(d.pickTicket([{ label: 'T', ticketId: 9 }] as never, 'which?')).resolves.toBe(9);
    expect(showQuickPick).toHaveBeenLastCalledWith([{ label: 'T', ticketId: 9 }], { placeHolder: 'which?' });
    showQuickPick.mockResolvedValueOnce(undefined);
    await expect(d.pickTicket([] as never, 'which?')).resolves.toBeUndefined();
  });

  it('the choice picker gives the choice, and the say line has the ship prefix', async () => {
    const { handlers, showQuickPick, debug } = register();
    await (handlers.get('karst.autopilot.retry') as () => unknown)();
    const d = depsOf(retryCommand);
    showQuickPick.mockResolvedValueOnce('b');
    await expect(d.pick(['a', 'b'] as never, 'mode?')).resolves.toBe('b');
    expect(showQuickPick).toHaveBeenLastCalledWith(['a', 'b'], { placeHolder: 'mode?' });
    d.say('hello');
    expect(debug).toHaveBeenCalledWith('[ship] autopilot command: hello');
  });
});
