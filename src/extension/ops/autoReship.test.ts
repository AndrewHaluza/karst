import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, pauseTicket, setStageCurrent, unpauseTicket } from '../../store/tickets.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { setStage } from '../../store/stages.js';
import {
  getAutopilotTicket, getCiRoundAt, markCiRound, setAutopilotOverride, setAutopilotPaused, setAutopilotStopAfter, setAutopilotStopped, takeAutopilotAttempt,
} from '../../store/autopilot.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import type { ShipPreview, ShipPreviewRepo } from '../../workflow/shipPreview.js';
import { approveOneMore, stopAutopilot } from './autopilotOps.js';
import { autoReship, reshipAtShipConfirm, reshipBlocker, RESHIP_SHIP_OPTS, type AutoReshipDeps } from './autoReship.js';

const CFG: AutopilotConfig = { enabled: true, ci: { policy: 'auto', maxAttempts: 3, checks: ['unit'] }, conflicts: { policy: 'auto', maxRounds: 2 } };

const repo = (over: Partial<ShipPreviewRepo> = {}): ShipPreviewRepo => ({
  repo: 'karst', prTitle: 't', commitMessage: 'm', commitFiles: ['a.ts'], excludedFiles: [], committedExcludedWarning: [], deny: [],
  prNumber: 7, changedFromBase: true, branchCommits: [], branchCommitsMore: 0, status: 'will-commit', ...over,
});
const preview = (...repos: ShipPreviewRepo[]): ShipPreview => ({ computedAt: 'now', repos });

let store: Store;
let id: number;

function deps(o: { cfg?: AutopilotConfig | undefined; controls?: boolean; prev?: ShipPreview | Error; ship?: () => Promise<void> } = {}) {
  const notes: Array<[string, string]> = [];
  const debug = vi.fn();
  const ship = vi.fn(o.ship ?? (async () => undefined));
  const d: AutoReshipDeps = {
    store, ticketId: id, key: 'AP-1',
    config: () => ('cfg' in o ? o.cfg : CFG),
    controls: () => o.controls ?? true,
    preview: async () => { if (o.prev instanceof Error) throw o.prev; return o.prev ?? preview(repo()); },
    ship, note: (t, b) => void notes.push([t, b]), debug,
  };
  return { d, notes, debug, ship };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'AP-1', title: 't' }).id;
  setStageCurrent(store, id, 'ship');
  takeAutopilotAttempt(store, id, 'karst', 'ci', 'unit', 3);
  markCiRound(store, id, 1000);
});

describe('autoReship', () => {
  it('(a) runs ship with no click after a ci round when every PR is open, and notes the round', async () => {
    const x = deps();
    expect(await autoReship(x.d)).toEqual({ kind: 'shipped', used: 1, max: 3 });
    expect(x.ship).toHaveBeenCalledTimes(1);
    expect(x.notes).toEqual([['Autopilot: re-shipped after ci round 1/3', expect.any(String)]]);
    expect(x.debug.mock.calls.every(([m]) => (m as string).startsWith('[ship] autopilot'))).toBe(true);
  });

  it('(b) waits for Confirm when a repo has no open PR', async () => {
    const x = deps({ prev: preview(repo(), repo({ repo: 'other', prNumber: null })) });
    expect(await autoReship(x.d)).toMatchObject({ kind: 'waits' });
    expect(x.ship).not.toHaveBeenCalled();
    expect(getCiRoundAt(store, id)).toBe(1000);
  });

  it('(b) waits when no repo has an open PR at all (a first ship)', async () => {
    const x = deps({ prev: preview(repo({ prNumber: null })) });
    expect(await autoReship(x.d)).toMatchObject({ kind: 'waits' });
    expect(x.ship).not.toHaveBeenCalled();
  });

  it('(c) waits when autopilot is off, the ticket is paused, stopped or flagged, or another window controls it', async () => {
    setAutopilotOverride(store, id, 'off');
    markCiRound(store, id, 1000);
    expect((await autoReship(deps().d)).kind).toBe('waits');
    setAutopilotOverride(store, id, 'on');
    markCiRound(store, id, 1000);
    expect((await autoReship(deps({ cfg: { ...CFG, enabled: false } }).d)).kind).toBe('shipped');
    markCiRound(store, id, 1000);
    expect((await autoReship(deps({ controls: false }).d)).kind).toBe('waits');
    pauseTicket(store, id);
    expect((await autoReship(deps().d)).kind).toBe('waits');
  });

  it('(c) waits when the mode inherits an off manifest, and spends the mark', async () => {
    const x = deps({ cfg: { ...CFG, enabled: false } });
    expect(await autoReship(x.d)).toMatchObject({ kind: 'waits', reason: 'autopilot is off' });
    expect(getCiRoundAt(store, id)).toBeNull();
  });

  it('(c) waits on a stop flag, a paused reason and a stopped reason', async () => {
    setAutopilotStopped(store, id, 'auto-fix stopped: ci 3/3');
    markCiRound(store, id, 1000);
    expect((await autoReship(deps().d)).kind).toBe('waits');
    setAutopilotStopped(store, id, null);
    markCiRound(store, id, 1000);
    expect((await autoReship(deps().d)).kind).toBe('shipped');
  });

  it('(d) waits, with no debug line, for a ticket that never had a round', async () => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'AP-2', title: 't' }).id;
    setStageCurrent(store, id, 'ship');
    const x = deps();
    expect(await autoReship(x.d)).toMatchObject({ kind: 'waits' });
    expect(x.ship).not.toHaveBeenCalled();
    expect(x.debug).not.toHaveBeenCalled();
  });

  it('(e) clears the mark before ship starts, so a second drive does not ship again', async () => {
    let markDuringShip: number | null | undefined;
    const x = deps({ ship: async () => { markDuringShip = getCiRoundAt(store, id); } });
    await autoReship(x.d);
    expect(markDuringShip).toBeNull();
    expect(await autoReship(x.d)).toMatchObject({ kind: 'waits' });
    expect(x.ship).toHaveBeenCalledTimes(1);
  });

  it('starts one ship only when two drives overlap', async () => {
    let release!: () => void;
    const x = deps({ ship: () => new Promise<void>((r) => { release = r; }) });
    const first = autoReship(x.d);
    await vi.waitFor(() => expect(x.ship).toHaveBeenCalled());
    markCiRound(store, id, 2000);
    expect(await autoReship(x.d)).toMatchObject({ kind: 'waits' });
    release();
    await first;
    expect(x.ship).toHaveBeenCalledTimes(1);
  });

  it('waits when the ship stage has a block or a ship runs', async () => {
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'push-diverged', reason: 'x', runAt: new Date().toISOString(), gates: [] });
    expect(await autoReship(deps().d)).toMatchObject({ kind: 'waits', reason: 'the ship stage has a block' });
  });

  it('waits when the ticket is not at ship', async () => {
    setStageCurrent(store, id, 'review');
    expect(await autoReship(deps().d)).toMatchObject({ kind: 'waits', reason: 'the ticket is not at ship' });
  });

  it('waits when there is no autopilot config', async () => {
    expect(await autoReship(deps({ cfg: undefined }).d)).toMatchObject({ kind: 'waits' });
  });

  it('waits when the preview throws', async () => {
    const x = deps({ prev: new Error('git failed') });
    expect(await autoReship(x.d)).toMatchObject({ kind: 'waits' });
    expect(x.ship).not.toHaveBeenCalled();
  });

  it('reports a ship that throws as failed; the mark stays spent', async () => {
    const x = deps({ ship: async () => { throw new Error('guard'); } });
    expect(await autoReship(x.d)).toEqual({ kind: 'failed', reason: 'guard' });
    expect(getCiRoundAt(store, id)).toBeNull();
    expect(x.notes).toHaveLength(1);
  });

  it('waits when a pause lands while the preview is read', async () => {
    const x = deps();
    const slow = { ...x.d, preview: async () => { setAutopilotPaused(store, id, 'auto-fix paused: x'); return preview(repo()); } };
    expect(await autoReship(slow)).toMatchObject({ kind: 'waits' });
    expect(x.ship).not.toHaveBeenCalled();
  });

  it('counts the extra attempts a person approved in the budget max', async () => {
    approveOneMore({ store, ticketId: id, key: 'AP-1', note: () => undefined, debug: () => undefined }, 'karst', 'ci');
    markCiRound(store, id, 1000);
    expect(await autoReship(deps().d)).toEqual({ kind: 'shipped', used: 1, max: 4 });
  });
});

describe('reshipBlocker', () => {
  it('passes when every pushed repo has a PR and an untouched repo has none', () => {
    expect(reshipBlocker(preview(repo(), repo({ repo: 'idle', prNumber: null, commitFiles: [], changedFromBase: false, status: 'nothing-to-commit' })))).toBeNull();
  });
  it('passes a repo whose PR merged and adds nothing', () => {
    expect(reshipBlocker(preview(repo(), repo({ repo: 'old', prNumber: null, status: 'already-merged' })))).toBeNull();
  });
  it('blocks a repo that ship would park, and a failed read', () => {
    expect(reshipBlocker(preview(repo(), repo({ repo: 'b', status: 'blocked' })))).toContain('b');
    expect(reshipBlocker(preview(repo(), repo({ repo: 'e', error: 'boom' })))).toContain('e');
  });
  it('blocks a repo with files to commit and no PR, and a repo with committed work and no PR', () => {
    expect(reshipBlocker(preview(repo(), repo({ repo: 'n', prNumber: null, status: 'will-commit' })))).toContain('n');
    expect(reshipBlocker(preview(repo(), repo({ repo: 'c', prNumber: null, commitFiles: [], status: 'nothing-to-commit', changedFromBase: true })))).toContain('c');
    expect(reshipBlocker(preview(repo(), repo({ repo: 'f', prNumber: null, status: 'nothing-to-commit', changedFromBase: false, commitFiles: ['x'] })))).toContain('f');
  });
  it('blocks an empty preview', () => {
    expect(reshipBlocker(preview())).not.toBeNull();
  });
});

describe('the mark (store)', () => {
  it('clears on a pause, a park reason, an override change, a stop flag and Stop now, and survives a cleared pause and a null stop reason', async () => {
    const check = (fn: () => void | Promise<unknown>) => async () => { markCiRound(store, id, 5); await fn(); return getCiRoundAt(store, id); };
    expect(await check(() => setAutopilotPaused(store, id, 'r'))()).toBeNull();
    expect(await check(() => setAutopilotStopped(store, id, 'r'))()).toBeNull();
    expect(await check(() => setAutopilotOverride(store, id, 'on'))()).toBeNull();
    expect(await check(() => setAutopilotStopAfter(store, id))()).toBeNull();
    expect(await check(() => stopAutopilot({ store, ticketId: id, key: 'AP-1', note: () => undefined, debug: () => undefined, stopSession: async () => true }, 'now'))()).toBeNull();
    expect(await check(() => setAutopilotPaused(store, id, null))()).toBe(5);
    expect(await check(() => setAutopilotStopped(store, id, null))()).toBe(5);
    expect(getAutopilotTicket(store, id).mode).toBe('on');
  });
});

describe('reshipAtShipConfirm', () => {
  const host = (x: ReturnType<typeof deps>, over: Partial<Parameters<typeof reshipAtShipConfirm>[1]> = {}) => {
    const { note: _note, ...rest } = x.d;
    return { ...rest, projectId: () => 1, warn: vi.fn(), error: vi.fn(), ...over };
  };
  const atConfirm = { stage: 'ship', status: 'blocked', reason: 'ship-confirm' };

  it('runs the re-ship with the ship options when the driver stopped at ship-confirm', async () => {
    const x = deps();
    await reshipAtShipConfirm(atConfirm, host(x));
    expect(x.ship).toHaveBeenCalledWith(RESHIP_SHIP_OPTS);
    expect(RESHIP_SHIP_OPTS).toEqual({});
  });

  it.each([
    ['no outcome', null],
    ['another stage', { stage: 'uat', status: 'blocked', reason: 'ship-confirm' }],
    ['no block', { stage: 'ship', status: 'pending', reason: 'ship-confirm' }],
    ['another reason', { stage: 'ship', status: 'blocked', reason: 'awaiting-merge' }],
  ])('does nothing for %s', async (_n, outcome) => {
    const x = deps();
    await reshipAtShipConfirm(outcome, host(x));
    expect(x.ship).not.toHaveBeenCalled();
  });

  it('warns when the ship fails and reports a thrown error without throwing', async () => {
    const warn = vi.fn();
    await reshipAtShipConfirm(atConfirm, host(deps({ ship: async () => { throw new Error('guard'); } }), { warn }));
    expect(warn.mock.calls[0]?.[0]).toMatch(/^\[ship\] autopilot ticket AP-1: re-ship failed/);
    const error = vi.fn();
    const x = deps();
    await reshipAtShipConfirm(atConfirm, host(x, { error, preview: async () => { throw new Error('boom'); } }));
    expect(x.ship).not.toHaveBeenCalled();
  });

  it('posts the bulletin note only when a project exists', async () => {
    const x = deps();
    await reshipAtShipConfirm(atConfirm, host(x, { projectId: () => undefined }));
    expect(x.ship).toHaveBeenCalledTimes(1);
  });
});

describe('autoReship wait reasons and lines', () => {
  const waits = async (x: ReturnType<typeof deps>) => (await autoReship(x.d));

  it('names each wait reason and writes one debug line while the mark is set', async () => {
    const x0 = deps({ cfg: undefined });
    expect(await waits(x0)).toEqual({ kind: 'waits', reason: 'no autopilot config' });
    expect(x0.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: no automatic re-ship, no autopilot config');
    expect(await waits(deps({ controls: false }))).toEqual({ kind: 'waits', reason: 'another window controls the ticket' });
    setStage(store, id, 'ship', { status: 'running' });
    expect(await waits(deps())).toEqual({ kind: 'waits', reason: 'a ship is running' });
  });

  it('waits with the reason of a ship block', async () => {
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'push-diverged', reason: 'x', runAt: new Date().toISOString(), gates: [] });
    expect(await waits(deps())).toEqual({ kind: 'waits', reason: 'the ship stage has a block' });
  });

  it('waits when the ticket is not at ship', async () => {
    setStageCurrent(store, id, 'uat');
    expect(await waits(deps())).toEqual({ kind: 'waits', reason: 'the ticket is not at ship' });
  });

  it('waits on the stop flag, the paused reason, the stopped reason and the pause time, one by one', async () => {
    markCiRound(store, id, 1000);
    setAutopilotPaused(store, id, 'wait');
    markCiRound(store, id, 1000);
    expect(await waits(deps())).toMatchObject({ reason: 'the ticket is paused or stopped' });
    setAutopilotPaused(store, id, null);
    markCiRound(store, id, 1000);
    setAutopilotStopped(store, id, 'x');
    markCiRound(store, id, 1000);
    expect(await waits(deps())).toMatchObject({ reason: 'the ticket is paused or stopped' });
    setAutopilotStopped(store, id, null);
    pauseTicket(store, id);
    markCiRound(store, id, 1000);
    expect(await waits(deps())).toMatchObject({ reason: 'the ticket is paused or stopped' });
  });

  it('waits on the stop flag', async () => {
    setAutopilotStopAfter(store, id);
    markCiRound(store, id, 1000);
    expect(await waits(deps())).toMatchObject({ reason: 'the ticket is paused or stopped' });
  });

  it('writes no debug line when no round was sent, and names that reason', async () => {
    const { d, debug } = deps();
    store.db.prepare('UPDATE autopilot_tickets SET ci_round_at = NULL').run();
    expect(await autoReship(d)).toEqual({ kind: 'waits', reason: 'no ci round was sent' });
    expect(debug).not.toHaveBeenCalled();
  });

  it('keeps the mark and names the reason when the preview fails', async () => {
    expect(await waits(deps({ prev: new Error('gh down') }))).toEqual({ kind: 'waits', reason: 'the ship preview failed (gh down)' });
    expect(getCiRoundAt(store, id)).toBe(1000);
  });

  it('reports a second call of the same ticket while the first runs', async () => {
    let release: () => void = () => undefined;
    const first = deps({ ship: () => new Promise<void>((r) => { release = r; }) });
    const run = autoReship(first.d);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    markCiRound(store, id, 2000);
    expect(await waits(deps())).toEqual({ kind: 'waits', reason: 'an automatic re-ship is running' });
    release();
    await run;
  });

  it('writes the note body and the debug lines of a run and of a failed ship', async () => {
    const x = deps();
    await autoReship(x.d);
    expect(x.notes[0]?.[1]).toBe('AP-1: ship ran without the Confirm click; every PR it pushes to is already open.');
    expect(x.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: re-ship after ci round 1/3');
    markCiRound(store, id, 1000);
    const y = deps({ ship: async () => { throw new Error('guard'); } });
    expect(await autoReship(y.d)).toEqual({ kind: 'failed', reason: 'guard' });
    expect(y.debug).toHaveBeenCalledWith('[ship] autopilot ticket AP-1: re-ship failed: guard');
    markCiRound(store, id, 1000);
    expect(await autoReship(deps({ ship: async () => Promise.reject('plain') }).d)).toEqual({ kind: 'failed', reason: 'plain' });
    markCiRound(store, id, 1000);
    expect(await autoReship(deps({ prev: Object.assign(new Error('x')) }).d)).toMatchObject({ kind: 'waits' });
  });

  it('reports a preview that throws a non-Error value', async () => {
    const x = deps();
    const d = { ...x.d, preview: async () => { throw 'bad'; } };
    expect(await autoReship(d)).toEqual({ kind: 'waits', reason: 'the ship preview failed (bad)' });
  });
});

describe('reshipBlocker reasons', () => {
  it('names each reason and skips untouched and merged repos', () => {
    expect(reshipBlocker(preview(repo({ prNumber: null })))).toBe('no open PR: a first ship needs the Confirm click');
    expect(reshipBlocker(preview(repo(), repo({ repo: 'b', error: 'x' })))).toBe('the ship preview of b failed');
    expect(reshipBlocker(preview(repo(), repo({ repo: 'b', status: 'blocked' })))).toBe('ship would park b');
    const bare: Partial<ShipPreviewRepo> = { prNumber: null, commitFiles: [], changedFromBase: false };
    expect(reshipBlocker(preview(repo(), repo({ repo: 'b', status: 'will-commit', ...bare })))).toBe('b has no open PR: a new PR needs the Confirm click');
    expect(reshipBlocker(preview(repo(), repo({ repo: 'b', status: 'nothing-to-commit', ...bare, commitFiles: ['x'] })))).toBe('b has no open PR: a new PR needs the Confirm click');
    expect(reshipBlocker(preview(repo(), repo({ repo: 'b', status: 'nothing-to-commit', ...bare, changedFromBase: true })))).toBe('b has no open PR: a new PR needs the Confirm click');
    expect(reshipBlocker(preview(repo(), repo({ repo: 'b', status: 'nothing-to-commit', ...bare })))).toBeNull();
    expect(reshipBlocker(preview(repo(), repo({ repo: 'b', status: 'already-merged', ...bare, changedFromBase: true })))).toBeNull();
    // A merged PR is no open PR: a ticket whose only PR is merged is a first ship.
    expect(reshipBlocker(preview(repo({ status: 'already-merged', prNumber: 7 })))).toBe('no open PR: a first ship needs the Confirm click');
    // The preview shows an open PR as skipped: ship would push nothing.
    expect(reshipBlocker(preview(repo({ status: 'already-shipped' })))).toBe('the preview shows the open PR of karst as skipped, so ship would push nothing');
  });
});

describe('reshipAtShipConfirm note', () => {
  it('posts the note only when a project id exists', async () => {
    const x = deps();
    const { note: _n, ...rest } = x.d;
    await reshipAtShipConfirm({ stage: 'ship', status: 'blocked', reason: 'ship-confirm' }, { ...rest, projectId: () => 999999, warn: vi.fn(), error: vi.fn() });
    expect(x.debug.mock.calls.some(([m]) => String(m).startsWith('[ship] autopilot note failed'))).toBe(true);
    markCiRound(store, id, 1000);
    const y = deps();
    const { note: _m, ...rest2 } = y.d;
    await reshipAtShipConfirm({ stage: 'ship', status: 'blocked', reason: 'ship-confirm' }, { ...rest2, projectId: () => undefined, warn: vi.fn(), error: vi.fn() });
    expect(y.debug.mock.calls.some(([m]) => String(m).startsWith('[ship] autopilot note failed'))).toBe(false);
  });

  it('reports an error from the saga seam through error()', async () => {
    const x = deps();
    const { note: _n, ...rest } = x.d;
    const error = vi.fn();
    await reshipAtShipConfirm({ stage: 'ship', status: 'blocked', reason: 'ship-confirm' }, { ...rest, config: () => { throw new Error('cfg'); }, projectId: () => 1, warn: vi.fn(), error });
    expect(error).toHaveBeenCalledWith('autopilot re-ship failed', expect.any(Error));
  });
});

describe('ticket pause', () => {
  it('spends the mark, so a resume does not re-ship', async () => {
    pauseTicket(store, id);
    expect(getCiRoundAt(store, id)).toBeNull();
    unpauseTicket(store, id);
    expect(await autoReship(deps().d)).toMatchObject({ kind: 'waits', reason: 'no ci round was sent' });
  });
});
