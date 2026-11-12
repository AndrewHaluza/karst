import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { createUndeliveredTracker } from './deliverToPrOps.js';
import { conflictRounds, autoDeliverAfterConflict, autoDeliverPhase, beginManualPush, rerunSkippedGates, supersedeRerun } from './autoDeliverOps.js';
import { openDeliverRun, recordDeliverGate, currentDeliverRun, listDeliverResults } from '../../store/deliverRuns.js';
import { autoDeliverAction, shipBaseCheck, deliverBlockedPrompt, deliverToPrAction, headShaOf, refreshUndeliveredForShipTickets, rebaseOnBaseAction, sendCiFailureAction, type CiActionsInput } from './ciActionsWiring.js';

const SHA = 'a'.repeat(40);
let store: Store;
let id: number;
let dir: string;

function seedPr(extra: { checks?: string | null; block?: string | null } = {}): void {
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w/r', 'b');
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref, merge_block, checks) VALUES (?, ?, 5, ?, ?, ?, ?, ?, ?)')
    .run(id, 'r', 'https://github.com/o/r/pull/5', 'open', 'feat/x', 'develop', extra.block ?? 'behind', extra.checks ?? '{"state":"failing","total":1,"passed":0,"failed":1,"pending":0,"failedShown":1,"failing":[{"name":"lint","url":null}]}');
}

function sandbox(unsynced = false): CiActionsInput['sandbox'] {
  return {
    hasUnsynced: vi.fn(async () => unsynced), recreateNoSync: vi.fn(async () => {}),
    cloneRef: vi.fn(async () => null), ensureSynced: vi.fn(async () => ({ ok: true }) as never),
  };
}

/** A git stub whose HEAD moves on each read, so a rebase counts as a move. */
function movingGit(): CiActionsInput['git'] {
  let n = 0;
  return vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? `head${n++}\n` : '', stderr: '', exitCode: 0 }));
}

function input(over: Partial<CiActionsInput> = {}): CiActionsInput {
  return {
    store, ticketId: id, artifactDir: dir,
    gh: vi.fn(async () => ({ stdout: `${SHA}\n`, exitCode: 0 })),
    git: movingGit(),
    sandbox: sandbox(),
    deliver: { runShip: vi.fn(async () => {}), blocked: vi.fn(async () => {}), tracker: createUndeliveredTracker() },
    reprobe: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    info: vi.fn(), error: vi.fn(), logError: vi.fn(), debug: vi.fn(), drive: vi.fn(), handOff: vi.fn(() => null), afterServerChange: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'W-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
  dir = mkdtempSync(join(tmpdir(), 'ci-wiring-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('rebaseOnBaseAction', () => {
  it('tells the user when no PR is behind, and still refreshes', async () => {
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    expect(i.info).toHaveBeenCalledWith(expect.stringMatching(/not available/));
    expect(i.afterServerChange).toHaveBeenCalledOnce();
  });

  it('pushes with a lease on the head sha gh reports, then clears the probe, recreates and re-probes', async () => {
    seedPr();
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    const gitArgs = (i.git as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[]).join(' '));
    expect(gitArgs).toContain(`push --force-with-lease=feat/x:${SHA} origin HEAD:refs/heads/feat/x`);
    expect((i.git as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[1] === '/w/r')).toBe(true);
    expect(i.sandbox.recreateNoSync).toHaveBeenCalledWith(id);
    expect(i.reprobe).toHaveBeenCalledOnce();
    expect(store.db.prepare('SELECT checks, merge_block FROM prs').get()).toEqual({ checks: null, merge_block: null });
    expect(i.error).not.toHaveBeenCalled();
    expect(i.afterServerChange).toHaveBeenCalled();
  });

  it('refuses while the ticket agent is running, touching no git', async () => {
    seedPr();
    store.db.prepare(`UPDATE tickets SET agent_state = 'running' WHERE id = ?`).run(id);
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    expect(i.error).toHaveBeenCalledWith(expect.stringMatching(/agent is working/));
    expect(i.git).not.toHaveBeenCalled();
  });

  it('refuses while the sandbox has unsynced commits', async () => {
    seedPr();
    const i = input({ sandbox: sandbox(true) });
    await rebaseOnBaseAction(i, () => []);
    expect(i.sandbox.hasUnsynced).toHaveBeenCalledWith(id);
    expect(i.error).toHaveBeenCalledWith(expect.stringMatching(/sync or carry/));
    expect(i.git).not.toHaveBeenCalled();
  });

  it('reads the head of the PR by number and rejects a malformed sha before pushing', async () => {
    seedPr();
    const gh = vi.fn(async () => ({ stdout: 'not-a-sha', exitCode: 0 }));
    const i = input({ gh });
    await rebaseOnBaseAction(i, () => []);
    expect((gh.mock.calls as unknown as string[][][])[0]![0]).toEqual(['pr', 'view', '5', '--json', 'headRefOid', '--jq', '.headRefOid']);
    const gitArgs = (i.git as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[])[0]);
    expect(gitArgs).not.toContain('push');
    expect(i.error).toHaveBeenCalled();
    expect(i.sandbox.recreateNoSync).not.toHaveBeenCalled();
  });

  it('a git failure maps to the ops error path and never re-probes', async () => {
    seedPr();
    let n = 0;
    const git = vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? `head${n++}\n` : '', stderr: 'rejected', exitCode: args[0] === 'push' ? 1 : 0 }));
    const i = input({ git });
    await rebaseOnBaseAction(i, () => []);
    expect(i.error).toHaveBeenCalled();
    expect(i.reprobe).not.toHaveBeenCalled();
    expect(i.sandbox.recreateNoSync).not.toHaveBeenCalled();
  });
});

function seedSecondPr(): void {
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r2', '/w/r2', 'b2');
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref, merge_block, checks) VALUES (?, ?, 6, ?, ?, ?, ?, ?, ?)')
    .run(id, 'r2', 'https://github.com/o/r2/pull/6', 'open', 'feat/y', 'develop', 'behind', null);
}

const pushedRepos = (i: CiActionsInput): string[] =>
  (i.git as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[0] as string[])[0] === 'push').map((c) => c[1] as string);

describe('rebaseOnBaseAction result and autopilot mode (T1081)', () => {
  it('returns false and says why when the action is not available', async () => {
    const i = input();
    expect(await rebaseOnBaseAction(i, () => [])).toBe(false);
    expect(i.info).toHaveBeenCalledWith('Rebase on base is not available: no open pull request is behind its base.');
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r']) })).toBe(false);
  });

  it('returns true after a user rebase that pushed', async () => {
    seedPr();
    expect(await rebaseOnBaseAction(input(), () => [])).toBe(true);
  });

  it('returns false when the push is rejected', async () => {
    seedPr();
    let n = 0;
    const git = vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? `head${n++}\n` : '', stderr: 'rejected', exitCode: args[0] === 'push' ? 1 : 0 }));
    expect(await rebaseOnBaseAction(input({ git }), () => [])).toBe(false);
  });

  it('autopilot mode never asks for a confirm and returns true after the push', async () => {
    seedPr();
    const i = input({ confirm: vi.fn(async () => false) });
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r']) })).toBe(true);
    expect(i.confirm).not.toHaveBeenCalled();
    expect(pushedRepos(i)).toEqual(['/w/r']);
  });

  it('user mode still declines when the user declines', async () => {
    seedPr();
    const i = input({ confirm: vi.fn(async () => false) });
    await rebaseOnBaseAction(i, () => []);
    expect(i.confirm).toHaveBeenCalledWith('Rebase on base?', expect.any(String), 'Rebase and push');
    expect(pushedRepos(i)).toEqual([]);
  });

  it('user mode: a declined confirm on one PR does not stop the next PR', async () => {
    seedPr();
    seedSecondPr();
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const i = input({ confirm });
    await rebaseOnBaseAction(i, () => []);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(pushedRepos(i)).toEqual(['/w/r2']);
  });

  it('autopilot mode: a refusal on the first PR stops the next PR', async () => {
    seedPr();
    seedSecondPr();
    const i = input({ sandbox: { ...input().sandbox, hasUnsynced: vi.fn(async () => true) } });
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r', 'r2']) })).toBe(false);
    expect(pushedRepos(i)).toEqual([]);
  });

  it('autopilot mode rebases a PR whose probe is not behind (a failing check hides it), user mode does not', async () => {
    seedPr();
    store.db.prepare("UPDATE prs SET merge_block = 'ci' WHERE ticket_id = ?").run(id);
    const user = input();
    expect(await rebaseOnBaseAction(user, () => [])).toBe(false);
    expect(pushedRepos(user)).toEqual([]);
    const i = input();
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r']) })).toBe(true);
    expect(pushedRepos(i)).toEqual(['/w/r']);
  });

  it('autopilot mode pushes nothing and returns false when the branch is already current', async () => {
    seedPr();
    const git = vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? 'same\n' : '', stderr: '', exitCode: 0 }));
    const i = input({ git });
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r']) })).toBe(false);
    expect(pushedRepos(i)).toEqual([]);
  });

  it('autopilot mode rebases only the named repos', async () => {
    seedPr();
    seedSecondPr();
    const i = input();
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r2']) })).toBe(true);
    expect(pushedRepos(i)).toEqual(['/w/r2']);
  });

  it('user mode rebases every behind repo', async () => {
    seedPr();
    seedSecondPr();
    const i = input();
    expect(await rebaseOnBaseAction(i, () => [])).toBe(true);
    expect(pushedRepos(i)).toEqual(['/w/r', '/w/r2']);
  });

  it('autopilot mode returns false and touches no git when no named repo is behind', async () => {
    seedPr();
    const i = input();
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['other']) })).toBe(false);
    expect(i.git).not.toHaveBeenCalled();
    expect(i.afterServerChange).toHaveBeenCalledOnce();
  });

  it('the first failing repo stops the rest and the result is false', async () => {
    seedPr();
    seedSecondPr();
    let n = 0;
    const git = vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? `head${n++}\n` : '', stderr: 'rejected', exitCode: args[0] === 'push' ? 1 : 0 }));
    const i = input({ git });
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r', 'r2']) })).toBe(false);
    expect(pushedRepos(i)).toEqual(['/w/r']);
  });

  it('autopilot mode shows no toast: every message goes to the debug log', async () => {
    seedPr();
    let n = 0;
    const gitFail = vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? `head${n++}\n` : '', stderr: 'rejected', exitCode: args[0] === 'push' ? 1 : 0 }));
    const i = input({ git: gitFail });
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r']) })).toBe(false);
    expect(i.error).not.toHaveBeenCalled();
    expect(i.info).not.toHaveBeenCalled();
    expect(i.debug).toHaveBeenCalledWith(expect.stringMatching(/^\[ship\] autopilot rebase on base: Rebase on base: push rejected/));
    const none = input();
    store.db.prepare('DELETE FROM prs').run();
    await rebaseOnBaseAction(none, () => [], { repos: new Set(['r']) });
    expect(none.info).not.toHaveBeenCalled();
    expect(none.debug).toHaveBeenCalledWith('[ship] autopilot rebase on base: Rebase on base is not available: no open pull request is behind its base.');
  });

  it('a sandbox error after the push still counts as pushed', async () => {
    seedPr();
    const sb = sandbox();
    sb.recreateNoSync = vi.fn(async () => { throw new Error('no docker'); });
    const i = input({ sandbox: sb });
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r']) })).toBe(true);
  });

  it('a busy agent gives false with the error reported', async () => {
    seedPr();
    store.db.prepare(`UPDATE tickets SET agent_state = 'running' WHERE id = ?`).run(id);
    const i = input();
    expect(await rebaseOnBaseAction(i, () => [], { repos: new Set(['r']) })).toBe(false);
    expect(i.debug).toHaveBeenCalledWith(expect.stringMatching(/agent is working/));
    expect(i.error).not.toHaveBeenCalled();
  });
});

describe('sendCiFailureAction', () => {
  it('writes the log into the artifact dir and sends the ticket back with its path', async () => {
    seedPr({ block: null });
    const i = input();
    await sendCiFailureAction(i);
    const files = readFileSync(join(dir, `ci-failure-5.log`), 'utf8');
    expect(files).toContain('lint');
    expect(i.confirm).toHaveBeenCalledWith('Send CI failure to the agent?', expect.any(String), 'Send to agent');
    expect(i.handOff).toHaveBeenCalled();
  });
});

describe('deliverToPrAction takes over an auto-deliver (T1018)', () => {
  it('stops the gate run, disarms the round, pushes once, writes the note and the auto-deliver never pushes', async () => {
    seedPr();
    const gateRun = openDeliverRun(store, { ticketId: id, headSha: SHA, gates: ['unit', 'visual'], pid: 1, now: 'T0' });
    recordDeliverGate(store, gateRun, { gateName: 'unit', repo: 'r', exitCode: 1, summary: 'boom', startedAt: null, endedAt: null });
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const autoShip = vi.fn(async () => {});
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'W-1', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: (_p, signal) => new Promise((resolve) => { if (signal.aborted) resolve('r: gate run was stopped'); else signal.addEventListener('abort', () => resolve('r: gate run was stopped')); }),
      blocked: async () => {}, runShip: autoShip, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    const i = input();
    await deliverToPrAction(i);
    await auto;
    expect(i.deliver.runShip).toHaveBeenCalledOnce();
    expect(autoShip).not.toHaveBeenCalled();
    expect(conflictRounds.armed(id)).toBeNull();
    expect(currentDeliverRun(store, id)?.state).toBe('taken-over');
    const notes = (store.db.prepare('SELECT title FROM bulletin_notes').all() as Array<{ title: string }>).map((n) => n.title);
    expect(notes).toContain('Autopilot: delivery taken over by a manual Deliver; failed: unit; skipped: visual');
  });
});

describe('deliverToPrAction re-runs the skipped gates after a take-over push (D540)', () => {
  it('runs exactly the skipped gates on the pushed head, records an after-take-over run and writes one note', async () => {
    seedPr();
    openDeliverRun(store, { ticketId: id, headSha: SHA, gates: ['unit', 'lint', 'types'], pid: 1, now: 'T0' });
    recordDeliverGate(store, currentDeliverRun(store, id)!.id, { gateName: 'unit', repo: 'r', exitCode: 0, summary: null, startedAt: null, endedAt: null });
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'W-1', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: (_p, signal) => new Promise((resolve) => { if (signal.aborted) resolve('stopped'); else signal.addEventListener('abort', () => resolve('stopped')); }),
      blocked: async () => {}, runShip: async () => {}, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    const cwd = mkdtempSync(join(tmpdir(), 'rerun-'));
    const ran: string[] = [];
    const uat = { gates: ['unit', 'lint', 'types'].map((name) => ({ name, kind: 'command', command: name })), repositories: {} } as never;
    const settled = vi.fn();
    const i = input({ git: vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? `${SHA}\n` : '', stderr: '', exitCode: 0 })) });
    store.db.prepare('UPDATE worktrees SET path = ? WHERE ticket_id = ?').run(cwd, id);
    const done = new Promise<void>((resolve) => { settled.mockImplementation(resolve); });
    await deliverToPrAction({ ...i, deliver: { ...i.deliver, shipGates: () => ({ settled, deps: { uat, runProcess: async (cmd: string) => { ran.push(cmd); return { kind: 'completed', exitCode: cmd === 'types' ? 2 : 0, output: 'x' }; } } }) } });
    await auto;
    await done;
    expect(ran).toEqual(['lint', 'types']);
    const run = currentDeliverRun(store, id)!;
    expect(run).toMatchObject({ kind: 'after-take-over', state: 'failed', gates: ['lint', 'types'] });
    expect(listDeliverResults(store, id).filter((r) => r.runId === run.id).map((r) => [r.gateName, r.exitCode, r.headSha])).toEqual([['lint', 0, SHA], ['types', 2, SHA]]);
    const notes = (store.db.prepare('SELECT title FROM bulletin_notes').all() as Array<{ title: string }>).map((n) => n.title);
    expect(notes).toContain(`Autopilot: the gates skipped by the manual Deliver ran on ${SHA.slice(0, 9)}: failed: types`);
  });
});

describe('the re-run after a take-over: edges (D540)', () => {
  const titles = (): string[] => (store.db.prepare('SELECT title FROM bulletin_notes').all() as Array<{ title: string }>).map((n) => n.title);
  const rerunTitles = (): string[] => titles().filter((t) => t.includes('skipped by the manual Deliver ran'));

  /** A running auto-deliver the manual Deliver takes over; `exit` is the exit code each re-run gate returns. */
  async function takeOver(opts: { exit?: (cmd: string) => number; shipGates?: boolean; over?: Partial<CiActionsInput>; seam?: () => { deps: never; settled?: () => void } } = {}) {
    seedPr();
    openDeliverRun(store, { ticketId: id, headSha: SHA, gates: ['unit', 'lint'], pid: 1, now: 'T0' });
    recordDeliverGate(store, currentDeliverRun(store, id)!.id, { gateName: 'unit', repo: 'r', exitCode: 0, summary: null, startedAt: null, endedAt: null });
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'W-1', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: (_p, signal) => new Promise((resolve) => { if (signal.aborted) resolve('stopped'); else signal.addEventListener('abort', () => resolve('stopped')); }),
      blocked: async () => {}, runShip: async () => {}, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    const cwd = mkdtempSync(join(tmpdir(), 'rerun-'));
    store.db.prepare('UPDATE worktrees SET path = ? WHERE ticket_id = ?').run(cwd, id);
    const uat = { gates: ['unit', 'lint'].map((name) => ({ name, kind: 'command', command: name })), repositories: {} } as never;
    const settled = vi.fn();
    const ran: string[] = [];
    const base = input({ git: vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? `${SHA}\n` : '', stderr: '', exitCode: 0 })), ...opts.over });
    const shipGates = vi.fn(() => ({ settled, deps: { uat, runProcess: async (cmd: string) => { ran.push(cmd); return { kind: 'completed', exitCode: (opts.exit ?? (() => 0))(cmd), output: 'x' }; } } }));
    const i: CiActionsInput = opts.shipGates === false ? base : { ...base, deliver: { ...base.deliver, shipGates: opts.seam ? (opts.seam as never) : (shipGates as never) } };
    return { i, auto, ran, settled, shipGates };
  }

  it('a passed re-run writes the passed note, settles the console and tells the dashboard', async () => {
    const { i, auto, ran, settled } = await takeOver();
    const done = new Promise<void>((r) => { settled.mockImplementation(r); });
    await deliverToPrAction(i);
    await auto;
    await done;
    expect(ran).toEqual(['lint']);
    expect(currentDeliverRun(store, id)).toMatchObject({ kind: 'after-take-over', state: 'passed' });
    expect(rerunTitles()).toEqual([`Autopilot: the gates skipped by the manual Deliver ran on ${SHA.slice(0, 9)}: passed`]);
    expect(i.afterServerChange).toHaveBeenCalled();
    expect(i.logError).not.toHaveBeenCalled();
  });

  it('a manual Deliver with no auto-deliver to take over runs no gate', async () => {
    seedPr();
    const shipGates = vi.fn(() => ({ deps: {} as never }));
    const base = input();
    await deliverToPrAction({ ...base, deliver: { ...base.deliver, shipGates } });
    expect(shipGates).not.toHaveBeenCalled();
    expect(rerunTitles()).toEqual([]);
  });

  it('a push that did not deliver runs no gate', async () => {
    const t = await takeOver({ over: {} });
    store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(id);
    await deliverToPrAction(t.i);
    await t.auto;
    expect(t.shipGates).not.toHaveBeenCalled();
    expect(t.i.deliver.runShip).not.toHaveBeenCalled();
  });

  it('without a ship-gates seam nothing runs and nothing is logged as an error', async () => {
    const { i, auto } = await takeOver({ shipGates: false });
    await deliverToPrAction(i);
    await auto;
    await new Promise((r) => { setTimeout(r, 20); });
    expect(i.logError).not.toHaveBeenCalled();
    expect(rerunTitles()).toEqual([]);
    expect(currentDeliverRun(store, id)?.kind).toBe('auto');
  });

  it('refuses the re-run while an agent turn runs and logs why', async () => {
    const { i, auto, ran, settled } = await takeOver();
    const refused = new Promise<void>((r) => { settled.mockImplementation(r); });
    const realDeliver = i.deliver.runShip as ReturnType<typeof vi.fn>;
    realDeliver.mockImplementation(async () => { store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(id); });
    await deliverToPrAction(i);
    await auto;
    await refused;
    expect(ran).toEqual([]);
    expect(i.debug).toHaveBeenCalledWith('[ship] ticket W-1 skipped-gate re-run not started: an agent turn is active');
  });

  it('a re-run whose targets vanish records no failure and writes a stopped note', async () => {
    const { i, auto, ran, settled } = await takeOver();
    const done = new Promise<void>((r) => { settled.mockImplementation(r); });
    (i.deliver.runShip as ReturnType<typeof vi.fn>).mockImplementation(async () => { store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(id); });
    await deliverToPrAction(i);
    await auto;
    await done;
    await new Promise((r) => { setTimeout(r, 20); });
    expect(ran).toEqual([]);
    expect(rerunTitles()).toEqual([expect.stringMatching(/: stopped$/)]);
    expect(i.logError).not.toHaveBeenCalled();
    expect(i.debug).toHaveBeenCalledWith('[ship] ticket W-1 skipped-gate re-run: stopped');
    expect(currentDeliverRun(store, id)?.kind).toBe('auto');
  });

  const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 20); });

  it('the failed note names only the gates of this re-run, not an older failure', async () => {
    const { i, auto, settled } = await takeOver({
      exit: (cmd) => {
        // a gate cut by the UI-path rule leaves a result with no exit code; it is not a failure
        recordDeliverGate(store, currentDeliverRun(store, id)!.id, { gateName: 'visual', repo: 'r', exitCode: null, summary: 'no UI change', startedAt: null, endedAt: null });
        return cmd === 'lint' ? 3 : 0;
      },
    });
    store.db.prepare("UPDATE deliver_gate_results SET exit_code = 1 WHERE gate_name = 'unit'").run();
    const done = new Promise<void>((r) => { settled.mockImplementation(r); });
    await deliverToPrAction(i);
    await auto;
    await done;
    expect(rerunTitles()).toEqual([`Autopilot: the gates skipped by the manual Deliver ran on ${SHA.slice(0, 9)}: failed: lint`]);
  });

  it('a newer push during the re-run records it as stopped and writes no failed note', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { i, auto, settled } = await takeOver();
    const seamOf = (settledFn: () => void) => () => ({ settled: settledFn, deps: { uat: { gates: [{ name: 'lint', kind: 'command', command: 'lint' }, { name: 'unit', kind: 'command', command: 'unit' }], repositories: {} }, runProcess: async () => { await gate; return { kind: 'completed', exitCode: 1, output: 'x' }; } } });
    const done = new Promise<void>((r) => { settled.mockImplementation(r); });
    const withGate: CiActionsInput = { ...i, deliver: { ...i.deliver, shipGates: seamOf(settled) as never } };
    await deliverToPrAction(withGate);
    await auto;
    await vi.waitFor(() => expect(currentDeliverRun(store, id)?.kind).toBe('after-take-over'));
    void supersedeRerun(id);
    release();
    await done;
    expect(currentDeliverRun(store, id)?.state).not.toBe('failed');
    expect(rerunTitles()).toEqual([`Autopilot: the gates skipped by the manual Deliver ran on ${SHA.slice(0, 9)}: superseded by a newer push`]);
    expect(i.debug).toHaveBeenCalledWith('[ship] ticket W-1 skipped-gate re-run: superseded');
  });

  it('a seam without a settled hook still ends cleanly and refreshes the dashboard once more', async () => {
    const { i, auto } = await takeOver({ seam: () => ({ deps: { uat: { gates: [{ name: 'lint', kind: 'command', command: 'lint' }], repositories: {} }, runProcess: async () => ({ kind: 'completed', exitCode: 0, output: 'x' }) } as never }) });
    await deliverToPrAction(i);
    await auto;
    await vi.waitFor(() => expect(i.debug).toHaveBeenCalledWith(expect.stringContaining('skipped-gate re-run')));
    const before = (i.afterServerChange as ReturnType<typeof vi.fn>).mock.calls.length;
    await tick();
    expect(i.logError).not.toHaveBeenCalled();
    expect((i.afterServerChange as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(before);
    expect(before).toBeGreaterThan(0);
  });

  it('the final dashboard refresh comes after the console settles', async () => {
    const { i, auto, settled } = await takeOver();
    const order: string[] = [];
    settled.mockImplementation(() => { order.push('settled'); });
    (i.afterServerChange as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('refresh'); });
    await deliverToPrAction(i);
    await auto;
    await vi.waitFor(() => expect(order).toContain('settled'));
    await tick();
    expect(order.slice(order.indexOf('settled'))).toEqual(['settled', 'refresh']);
  });

  it('a take-over with no recorded run has no skipped gate: nothing runs', async () => {
    seedPr();
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'W-1', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: (_p, signal) => new Promise((resolve) => { if (signal.aborted) resolve('stopped'); else signal.addEventListener('abort', () => resolve('stopped')); }),
      blocked: async () => {}, runShip: async () => {}, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    const base = input();
    const settled = vi.fn();
    const runProcess = vi.fn(async () => ({ kind: 'completed', exitCode: 0, output: 'x' }));
    await deliverToPrAction({ ...base, deliver: { ...base.deliver, shipGates: (() => ({ settled, deps: { uat: { gates: [], repositories: {} }, runProcess } })) as never } });
    await auto;
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    expect(runProcess).not.toHaveBeenCalled();
    expect(rerunTitles()).toEqual([]);
    expect(base.logError).not.toHaveBeenCalled();
  });

  it('words the note from the run it opened, not from a newer run of the ticket', async () => {
    const { i, auto, settled } = await takeOver({
      exit: () => {
        openDeliverRun(store, { ticketId: id, headSha: 'f'.repeat(40), gates: ['unit'], pid: 1, now: 'T9' });
        return 0;
      },
    });
    const done = new Promise<void>((r) => { settled.mockImplementation(r); });
    await deliverToPrAction(i);
    await auto;
    await done;
    expect(rerunTitles()).toEqual([`Autopilot: the gates skipped by the manual Deliver ran on ${SHA.slice(0, 9)}: passed`]);
  });

  it('a second Deliver click that pushes nothing leaves a running re-run alone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { i, auto, settled } = await takeOver();
    const seam = () => ({ settled, deps: { uat: { gates: [{ name: 'lint', kind: 'command', command: 'lint' }, { name: 'unit', kind: 'command', command: 'unit' }], repositories: {} }, runProcess: async () => { await gate; return { kind: 'completed', exitCode: 0, output: 'x' }; } } });
    const done = new Promise<void>((r) => { settled.mockImplementation(r); });
    await deliverToPrAction({ ...i, deliver: { ...i.deliver, shipGates: seam as never } });
    await auto;
    await vi.waitFor(() => expect(currentDeliverRun(store, id)?.kind).toBe('after-take-over'));
    store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(id);
    await deliverToPrAction(i);
    store.db.prepare("UPDATE tickets SET agent_state = 'idle' WHERE id = ?").run(id);
    release();
    await done;
    expect(rerunTitles()).toEqual([`Autopilot: the gates skipped by the manual Deliver ran on ${SHA.slice(0, 9)}: passed`]);
  });

  it('tells the user when the re-run is refused', async () => {
    const { i, auto, settled } = await takeOver();
    const refused = new Promise<void>((r) => { settled.mockImplementation(r); });
    (i.deliver.runShip as ReturnType<typeof vi.fn>).mockImplementation(async () => { store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(id); });
    await deliverToPrAction(i);
    await auto;
    await refused;
    expect(i.info).toHaveBeenCalledWith('Deliver to PR: the skipped gates did not run after the push: an agent turn is active.');
  });

  it('a gate that cannot be resolved names its reason in the note, with the head from git', async () => {
    const { i, auto, settled } = await takeOver({ seam: () => ({ deps: { uat: { gates: [], repositories: {} } } as never }) });
    const done = new Promise<void>((r) => { settled.mockImplementation(r); });
    const cwd = (store.db.prepare('SELECT path FROM worktrees WHERE ticket_id = ?').get(id) as { path: string }).path;
    mkdirSync(join(cwd, 'package.json')); // an unreadable package.json: the gates cannot be resolved
    await deliverToPrAction(i);
    await auto;
    await vi.waitFor(() => expect(rerunTitles()).toHaveLength(1));
    expect(rerunTitles()[0]).toMatch(new RegExp(`ran on ${SHA.slice(0, 9)}: failed: .+`));
    expect(rerunTitles()[0]).not.toContain('unknown');
    expect(rerunTitles()[0]).not.toContain('failed: none');
    expect(rerunTitles()[0]).toContain('failed: r: cannot read package.json');
    void done;
  });

  it('a throwing ship-gates seam is logged, not thrown', async () => {
    const { i, auto } = await takeOver({ seam: () => { throw new Error('no console'); } });
    await deliverToPrAction(i);
    await auto;
    await vi.waitFor(() => expect(i.logError).toHaveBeenCalledWith('skipped-gate re-run after a take-over failed', expect.any(Error)));
  });

  it('the auto-deliver already pushing says so, tells the dashboard and does not block a later re-run', async () => {
    seedPr();
    const entry = conflictRounds;
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    entry.arm(id, { repo: 'r', baseSha: null, files: [] });
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'W-1', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: async () => null, blocked: async () => {}, runShip: () => hold, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    await vi.waitFor(() => expect(autoDeliverPhase(id)).toBe('pushing'));
    const i = input();
    await deliverToPrAction(i);
    expect(i.info).toHaveBeenCalledWith('Deliver to PR: the auto-deliver pushes now; nothing more to do.');
    expect(i.afterServerChange).toHaveBeenCalledOnce();
    release();
    await auto;
    const deps = { ticketId: id, key: 'W-1', skipped: ['lint'], agentActive: () => false, note: () => {}, log: () => {}, runGates: async () => ({ kind: 'passed', headSha: null }) as const };
    expect(await rerunSkippedGates(deps)).toBe('passed');
    beginManualPush(id)();
  });
});

describe('headShaOf (T1018)', () => {
  const git = (stdout: string, exitCode = 0) => ({ git: vi.fn(async () => ({ stdout, stderr: '', exitCode })) });
  it('returns a full sha, trimmed, and asks git for HEAD in the worktree', async () => {
    const g = git(`${SHA}\n`);
    expect(await headShaOf(g, '/w/r')).toBe(SHA);
    expect(g.git).toHaveBeenCalledWith(['rev-parse', 'HEAD'], '/w/r');
  });
  it('returns null when git fails, even when it printed a sha', async () => {
    expect(await headShaOf(git(SHA, 128), '/w/r')).toBeNull();
  });
  it('returns null for output that is not a full sha', async () => {
    expect(await headShaOf(git('abc123'), '/w/r')).toBeNull();
    expect(await headShaOf(git(`${SHA}x`), '/w/r')).toBeNull();
    expect(await headShaOf(git(`x${SHA}`), '/w/r')).toBeNull();
    expect(await headShaOf(git(''), '/w/r')).toBeNull();
  });
});

describe('autoDeliverAction records its gate run (T1018)', () => {
  const gates = { gates: [{ name: 'unit', kind: 'command', command: 'u', args: [] }, { name: 'docs', kind: 'command', command: 'd', args: [] }], repositories: {} } as never;

  const run = async (exit: number) => {
    seedPr();
    store.db.prepare('UPDATE worktrees SET path = ? WHERE ticket_id = ?').run(dir, id);
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const i = input({
      git: vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? `${SHA}\n` : '', stderr: '', exitCode: 0 })),
    });
    const seen: Array<string | null | undefined> = [];
    const runProcess = async () => { seen.push(currentDeliverRun(store, id)?.currentGate); return { kind: 'completed' as const, exitCode: exit, output: exit === 0 ? 'ok' : 'boom: broke' }; };
    await autoDeliverAction(i, { key: 'W-1', status: () => {}, log: () => {}, gate: { uat: gates, runProcess } });
    return { i, seen };
  };

  it('opens a run, writes a result per gate with the head sha, pushes once and tells the dashboard', async () => {
    const { i, seen } = await run(0);
    expect(seen).toEqual(['unit', 'docs']);
    expect(listDeliverResults(store, id).map((r) => [r.gateName, r.exitCode, r.headSha])).toEqual([['unit', 0, SHA], ['docs', 0, SHA]]);
    expect(currentDeliverRun(store, id)?.state).toBe('passed');
    expect(i.deliver.runShip).toHaveBeenCalledOnce();
    expect(i.afterServerChange).toHaveBeenCalled();
  });

  it('keeps the failure on record and does not push when a gate fails', async () => {
    const { i } = await run(2);
    expect(currentDeliverRun(store, id)?.state).toBe('failed');
    expect(listDeliverResults(store, id)[0]).toMatchObject({ gateName: 'unit', exitCode: 2, headSha: SHA, summary: 'boom: broke' });
    expect(i.deliver.runShip).not.toHaveBeenCalled();
  });

  it('refuses to deliver while the agent runs', async () => {
    seedPr();
    store.db.prepare('UPDATE worktrees SET path = ? WHERE ticket_id = ?').run(dir, id);
    store.db.prepare(`UPDATE tickets SET agent_state = 'running' WHERE id = ?`).run(id);
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const i = input({ git: vi.fn(async () => ({ stdout: `${SHA}\n`, stderr: '', exitCode: 0 })) });
    await autoDeliverAction(i, { key: 'W-1', status: () => {}, log: () => {}, gate: { uat: gates } });
    expect(i.deliver.runShip).not.toHaveBeenCalled();
    expect(currentDeliverRun(store, id)).toBeNull();
  });
});

describe('takeover note limits (T1018)', () => {
  it('a manual Deliver while the auto-deliver pushes does nothing more and says so', async () => {
    seedPr();
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    let release: () => void = () => {};
    const pushing = new Promise<void>((r) => { release = r; });
    let started: () => void = () => {};
    const inPush = new Promise<void>((r) => { started = r; });
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'W-1', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: async () => null,
      blocked: async () => {}, runShip: async () => { started(); await pushing; }, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    await inPush;
    const i = input();
    await deliverToPrAction(i);
    expect(i.info).toHaveBeenCalledWith('Deliver to PR: the auto-deliver pushes now; nothing more to do.');
    expect(i.afterServerChange).toHaveBeenCalled();
    expect(i.deliver.runShip).not.toHaveBeenCalled();
    release();
    await auto;
  });

  it('keeps a note title of exactly the limit unclipped', async () => {
    seedPr();
    const name = 'g'.repeat(120 - 'Autopilot: delivery taken over by a manual Deliver; failed: none; skipped: '.length);
    openDeliverRun(store, { ticketId: id, headSha: SHA, gates: [name], pid: 1, now: 'T0' });
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'W-1', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: (_p, signal) => new Promise((resolve) => { if (signal.aborted) resolve('stopped'); else signal.addEventListener('abort', () => resolve('stopped')); }),
      blocked: async () => {}, runShip: async () => {}, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    await deliverToPrAction(input());
    await auto;
    const titles = (store.db.prepare('SELECT title FROM bulletin_notes').all() as Array<{ title: string }>).map((n) => n.title);
    expect(titles[0]!).toBe(`Autopilot: delivery taken over by a manual Deliver; failed: none; skipped: ${name}`);
    expect(titles[0]!).toHaveLength(120);
  });

  it('clips a long gate list to the bulletin title limit with an ellipsis', async () => {
    seedPr();
    const run = openDeliverRun(store, { ticketId: id, headSha: SHA, gates: ['g'.repeat(200)], pid: 1, now: 'T0' });
    expect(run).toBeGreaterThan(0);
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'W-1', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: (_p, signal) => new Promise((resolve) => { if (signal.aborted) resolve('stopped'); else signal.addEventListener('abort', () => resolve('stopped')); }),
      blocked: async () => {}, runShip: async () => {}, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    await deliverToPrAction(input());
    await auto;
    const titles = (store.db.prepare('SELECT title FROM bulletin_notes').all() as Array<{ title: string }>).map((n) => n.title);
    expect(titles).toHaveLength(1);
    expect(titles[0]!).toHaveLength(120);
    expect(titles[0]!.endsWith('\u2026')).toBe(true);
  });

  it('uses the ticket id as the key when the ticket has none', async () => {
    seedPr();
    store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(id);
    conflictRounds.arm(id, { repo: 'r', baseSha: null, files: [] });
    const auto = autoDeliverAfterConflict({
      ticketId: id, key: 'x', rounds: conflictRounds,
      targets: () => ({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] }),
      agentActive: () => false, ensureSynced: async () => ({ ok: true }) as never, verifyMerge: async () => null,
      runGates: (_p, signal) => new Promise((resolve) => { if (signal.aborted) resolve('stopped'); else signal.addEventListener('abort', () => resolve('stopped')); }),
      blocked: async () => {}, runShip: async () => {}, reprobe: async () => {}, status: () => {}, log: () => {},
      info: () => {}, error: () => {}, logError: () => {}, afterServerChange: () => {},
    });
    await deliverToPrAction(input());
    await auto;
    expect(conflictRounds.armed(id)).toBeNull();
    const bodies = (store.db.prepare('SELECT body FROM bulletin_notes').all() as Array<{ body: string }>).map((n) => n.body);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^T\d+: delivery taken over/);
  });
});

describe('deliverToPrAction', () => {
  it('syncs, ships with the delivery flag seam, re-probes and refreshes the counts', async () => {
    seedPr();
    const i = input();
    const order: string[] = [];
    (i.sandbox.ensureSynced as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('sync'); return { ok: true }; });
    (i.deliver.runShip as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('ship'); });
    (i.reprobe as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('probe'); });
    await deliverToPrAction(i);
    expect(order).toEqual(['sync', 'ship', 'probe']);
    expect(i.afterServerChange).toHaveBeenCalled();
  });

  it('refuses while the agent runs, touching nothing', async () => {
    seedPr();
    store.db.prepare(`UPDATE tickets SET agent_state = 'running' WHERE id = ?`).run(id);
    const i = input();
    await deliverToPrAction(i);
    expect(i.error).toHaveBeenCalledWith(expect.stringMatching(/agent is working/));
    expect(i.sandbox.ensureSynced).not.toHaveBeenCalled();
    expect(i.deliver.runShip).not.toHaveBeenCalled();
  });
});

function projectOf(ticketId: number): number {
  const p = store.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number } | undefined;
  const pid = p?.id ?? Number(store.db.prepare(`INSERT INTO projects (name, slug) VALUES ('p', 'p')`).run().lastInsertRowid);
  store.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(pid, ticketId);
  return pid;
}

describe('refreshUndeliveredForShipTickets', () => {
  it('measures ship tickets with an open PR and reports a change once', async () => {
    seedPr();
    const tracker = createUndeliveredTracker();
    const i = {
      store, projectId: 1, sandbox: { ...sandbox(), cloneRef: vi.fn(async () => 'FETCH_HEAD') },
      logError: vi.fn(),
      git: vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-list' ? '2\n' : '', stderr: '', exitCode: 0 })),
    };
    const pid = projectOf(id);
    expect(await refreshUndeliveredForShipTickets({ ...i, projectId: pid }, tracker)).toBe(true);
    expect(tracker.get(id)).toEqual({ hostAhead: 2, sandboxAhead: 2 });
    expect(await refreshUndeliveredForShipTickets({ ...i, projectId: pid }, tracker)).toBe(false);
  });

  it('logs and survives a failing read', async () => {
    seedPr();
    const logError = vi.fn();
    const pid = projectOf(id);
    const bad = { ...sandbox(), cloneRef: vi.fn(async () => { throw new Error('boom'); }) };
    expect(await refreshUndeliveredForShipTickets({ store, projectId: pid, sandbox: bad, logError, git: vi.fn() }, createUndeliveredTracker())).toBe(false);
    expect(logError).toHaveBeenCalled();
  });
});

describe('deliverBlockedPrompt', () => {
  it('opens the sync diff only when picked, naming the carry action for a rewritten clone', async () => {
    const open = vi.fn(async () => {});
    const warn = vi.fn(async (_m: string, ..._a: string[]) => 'Open sync diff' as string | undefined);
    await deliverBlockedPrompt(warn, open)('diverged', true);
    expect(warn.mock.calls[0]![0]).toMatch(/Nothing was pushed.*Carry sandbox commits/);
    expect(open).toHaveBeenCalledOnce();
    open.mockClear();
    await deliverBlockedPrompt(async () => undefined, open)('diverged', false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('deliverBlockedPrompt: sandbox CLI unknown (arch:AC-39)', () => {
  it('names the PATH problem and offers no sync diff', async () => {
    const open = vi.fn(async () => {});
    const warn = vi.fn(async (_m: string, ..._a: string[]) => 'Open sync diff' as string | undefined);
    await deliverBlockedPrompt(warn, open)('sbx CLI not runnable from the extension host: x.', false, true);
    expect(warn.mock.calls[0]![0]).toMatch(/sbx CLI not runnable.*PATH.*Nothing was pushed/);
    expect(warn.mock.calls[0]!.slice(1)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('shipBaseCheck (D541)', () => {
  const gate = { runProcess: undefined, debug: () => {}, gateEnv: () => ({ prBody: '', baseRef: 'develop' }) } as never;
  const target = { repo: 'r', cwd: '/w/r', branch: 'b' };

  it('lets the push run (null) and flushes the gate console when the check cannot run', async () => {
    const git = vi.fn(async () => ({ stdout: '', stderr: 'no remote', exitCode: 128 })) as CiActionsInput['git'];
    const settled = vi.fn();
    const i = input({ git });
    expect(await shipBaseCheck(i, gate, settled)(target)).toBeNull();
    expect(settled).toHaveBeenCalledOnce();
    expect(i.debug).toHaveBeenCalledWith(expect.stringMatching(/base-moved check not run/));
  });

  it('runs nothing for a sandboxed ticket: its gates cannot see the merged worktree, so no verdict is claimed', async () => {
    const git = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) as CiActionsInput['git'];
    const sb = { ...sandbox(), cloneRef: vi.fn(async () => 'FETCH_HEAD') };
    const i = input({ git, sandbox: sb });
    expect(await shipBaseCheck(i, gate, vi.fn())(target)).toBeNull();
    expect(sb.cloneRef).toHaveBeenCalledWith(id, '/w/r');
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(['merge-tree']), expect.anything());
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(['worktree', 'add']), expect.anything());
    expect(i.debug).toHaveBeenCalledWith(expect.stringMatching(/base-moved check not run.*sandbox/));
  });

  it('runs nothing when the gate env names no base', async () => {
    const git = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) as CiActionsInput['git'];
    const noBase = { debug: () => {}, gateEnv: () => ({ prBody: '' }) } as never;
    expect(await shipBaseCheck(input({ git }), noBase, vi.fn())(target)).toBeNull();
    expect(git).not.toHaveBeenCalled();
  });
});
