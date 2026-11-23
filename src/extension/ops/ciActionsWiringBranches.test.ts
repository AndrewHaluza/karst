import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { armForcePushLease } from '../../store/worktrees.js';
import { clearOpenPrProbe } from '../../store/prs.js';
import { rebaseOnBase } from './rebaseOnBaseOps.js';
import { checkBaseMoved } from './baseMovedCheck.js';
import { remedyBaseMoved } from './baseMovedRemedy.js';
import { readLastGreenBase, seedMergedState } from './baseMovedHost.js';
import { runShipGates, runShipGatesReport } from './shipGatesOps.js';
import { autoDeliverAfterConflict, conflictRounds, verifyMergeResolved } from './autoDeliverOps.js';
import { sendCiFailureToAgent } from './ciFailureOps.js';
import { OPEN_SYNC_DIFF } from './sandboxLifecycleOps.js';
import { sendGateFailureToAgent } from './baseMovedFailureOps.js';
import { refreshUndelivered } from './deliverToPrOps.js';
import { latestBaseMovedFailedGates } from '../../workflow/baseMovedFailure.js';
import {
  autoDeliverAction, baseMovedFailure, deliverBlockedPrompt, headShaOf, rebaseOnBaseAction, refreshUndeliveredForShipTickets,
  sendCiFailureAction, sendGateFailureAction, shipBaseCheck, shipBaseRemedy, type CiActionsInput,
} from './ciActionsWiring.js';

vi.mock('./rebaseOnBaseOps.js', () => ({ rebaseOnBase: vi.fn(async () => true) }));
vi.mock('./baseMovedCheck.js', () => ({ checkBaseMoved: vi.fn() }));
vi.mock('./baseMovedRemedy.js', () => ({ remedyBaseMoved: vi.fn() }));
vi.mock('./baseMovedHost.js', async (orig) => ({ ...(await orig<typeof import('./baseMovedHost.js')>()), readLastGreenBase: vi.fn(), seedMergedState: vi.fn() }));
vi.mock('./shipGatesOps.js', async (orig) => ({ ...(await orig<typeof import('./shipGatesOps.js')>()), runShipGates: vi.fn(), runShipGatesReport: vi.fn() }));
vi.mock('./autoDeliverOps.js', async (orig) => ({ ...(await orig<typeof import('./autoDeliverOps.js')>()), autoDeliverAfterConflict: vi.fn(), verifyMergeResolved: vi.fn() }));
vi.mock('./ciFailureOps.js', async (orig) => ({ ...(await orig<typeof import('./ciFailureOps.js')>()), sendCiFailureToAgent: vi.fn() }));
vi.mock('./baseMovedFailureOps.js', async (orig) => ({ ...(await orig<typeof import('./baseMovedFailureOps.js')>()), sendGateFailureToAgent: vi.fn() }));
vi.mock('./deliverToPrOps.js', async (orig) => ({ ...(await orig<typeof import('./deliverToPrOps.js')>()), refreshUndelivered: vi.fn(async () => {}) }));
vi.mock('../../store/worktrees.js', async (orig) => {
  const actual = await orig<typeof import('../../store/worktrees.js')>();
  return { ...actual, armForcePushLease: vi.fn(actual.armForcePushLease) };
});
vi.mock('../../store/prs.js', async (orig) => {
  const actual = await orig<typeof import('../../store/prs.js')>();
  return { ...actual, clearOpenPrProbe: vi.fn(actual.clearOpenPrProbe) };
});
vi.mock('../../workflow/baseMovedFailure.js', async (orig) => ({ ...(await orig<typeof import('../../workflow/baseMovedFailure.js')>()), latestBaseMovedFailedGates: vi.fn(() => []) }));

const SHA = 'a'.repeat(40);
let store: Store;
let id: number;
let dir: string;

function seedPr(over: { number?: number | null } = {}): void {
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w/r', 'b');
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref, merge_block, checks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'r', over.number === undefined ? 5 : over.number, 'https://github.com/o/r/pull/5', 'open', 'feat/x', 'develop', 'behind', null);
}

function input(over: Partial<CiActionsInput> = {}): CiActionsInput {
  return {
    store, ticketId: id, artifactDir: dir,
    gh: vi.fn(async () => ({ stdout: `${SHA}\n`, exitCode: 0 })) as never,
    git: vi.fn(async () => ({ stdout: `${SHA}\n`, stderr: '', exitCode: 0 })) as never,
    sandbox: {
      hasUnsynced: vi.fn(async () => false), recreateNoSync: vi.fn(async () => {}), cloneRef: vi.fn(async () => null),
      hasSandbox: vi.fn(async () => false), ensureSynced: vi.fn(async () => ({ ok: true }) as never),
    },
    deliver: { runShip: vi.fn(async () => {}), blocked: vi.fn(async () => {}), tracker: new Map() as never },
    reprobe: vi.fn(async () => {}), confirm: vi.fn(async () => true),
    info: vi.fn(), error: vi.fn(), logError: vi.fn(), debug: vi.fn(), drive: vi.fn(), handOff: vi.fn(() => null), afterServerChange: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rebaseOnBase).mockResolvedValue(true);
  store = openStore(':memory:');
  id = createTicket(store, { key: 'W-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
  dir = mkdtempSync(join(tmpdir(), 'ci-branches-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Deps = Parameters<typeof rebaseOnBase>[0];
const rebaseDeps = (): Deps => vi.mocked(rebaseOnBase).mock.calls.at(-1)![0];

describe('the log writers of the two send actions', () => {
  it.each([
    ['CI failure', sendCiFailureAction, sendCiFailureToAgent, 'Send CI failure to the agent?'],
    ['gate failure', sendGateFailureAction, sendGateFailureToAgent, 'Send gate failure to the agent?'],
  ] as const)('%s: writes the log under a new artifact dir and asks the confirm with its title', async (_n, action, target, title) => {
    const nested = join(dir, 'deep', 'er');
    const i = input({ artifactDir: nested });
    await action(i);
    const deps = (vi.mocked(target as (d: never) => Promise<void>).mock.calls[0]![0] as unknown) as { writeLog: (n: string, t: string) => string; confirm: (d: string) => Promise<boolean>; debug: unknown; implRunsGraph?: unknown };
    const path = deps.writeLog('x.log', 'hello');
    expect(path).toBe(join(nested, 'x.log'));
    expect(readFileSync(path, 'utf8')).toBe('hello');
    await expect(deps.confirm('detail')).resolves.toBe(true);
    expect(i.confirm).toHaveBeenCalledWith(title, 'detail', 'Send to agent');
    expect(deps.debug).toBe(i.debug);
    expect(deps).not.toHaveProperty('implRunsGraph');
  });
});

describe('the rebase deps (D558)', () => {
  it('reads the PR head over gh, and rejects a sha that is not 40 to 64 hex digits whole', async () => {
    seedPr();
    const gh = vi.fn();
    await rebaseOnBaseAction(input({ gh: gh as never }), () => []);
    const read = async (stdout: string, exitCode = 0): Promise<string> => { gh.mockResolvedValueOnce({ stdout, exitCode }); return rebaseDeps().prHeadSha!(); };
    await expect(read(`${'b'.repeat(64)}\n`)).resolves.toBe('b'.repeat(64));
    await expect(read('c'.repeat(40))).resolves.toBe('c'.repeat(40));
    for (const bad of ['d'.repeat(39), 'd'.repeat(65), `x${SHA}`, `${SHA}x`, '', 'G'.repeat(40)]) await expect(read(bad)).rejects.toThrow('gh could not read the head of PR #5');
    await expect(read(SHA, 1)).rejects.toThrow('gh could not read the head of PR #5');
    expect(gh).toHaveBeenLastCalledWith(['pr', 'view', '5', '--json', 'headRefOid', '--jq', '.headRefOid'], '/w/r');
  });

  it('arms the push lease only for a PR that has a number', async () => {
    seedPr();
    await rebaseOnBaseAction(input(), () => []);
    expect(rebaseDeps().armLease).toBeTypeOf('function');
    rebaseDeps().armLease!();
    expect(armForcePushLease).toHaveBeenCalledWith(store, id, 'r');
  });

  it('passes the repo, branch and base, and wires the sandbox and snapshot seams', async () => {
    seedPr();
    const retake = vi.fn(async () => {});
    const i = input({ retakeGateSnapshot: retake });
    const regenerate = vi.fn(() => [{ command: 'gen', paths: ['a'] }] as never);
    await rebaseOnBaseAction(i, regenerate);
    const d = rebaseDeps();
    expect(d).toMatchObject({ repo: 'r', cwd: '/w/r', branch: 'feat/x', baseRef: 'develop', preShip: false, onRebased: retake });
    expect(regenerate).toHaveBeenCalledWith('r');
    expect(d.regenerate).toHaveLength(1);
    await d.removeSandbox();
    expect(i.sandbox.recreateNoSync).toHaveBeenCalledWith(id);
    await expect(d.sandboxUnsynced()).resolves.toBe(false);
    expect(i.sandbox.hasUnsynced).toHaveBeenCalledWith(id);
    expect(d.agentActive()).toBe(false);
    store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(id);
    expect(d.agentActive()).toBe(true);
    await d.reopenSandbox();
    expect(() => d.afterServerChange()).not.toThrow();
    expect(i.afterServerChange).toHaveBeenCalledTimes(1); // only the final refresh of the action
  });

  it('git maps the runner result to code, stdout and stderr, in the given cwd', async () => {
    seedPr();
    const git = vi.fn(async () => ({ stdout: 'o', stderr: 'e', exitCode: 3 }));
    await rebaseOnBaseAction(input({ git: git as never }), () => []);
    await expect(rebaseDeps().git('/c', ['status'])).resolves.toEqual({ code: 3, stdout: 'o', stderr: 'e' });
    expect(git).toHaveBeenCalledWith(['status'], '/c');
  });

  it('runs a repo script through the shell', async () => {
    seedPr();
    await rebaseOnBaseAction(input(), () => []);
    await expect(rebaseDeps().runScript(dir, 'exit 3')).resolves.toMatchObject({ code: 3 });
    await expect(rebaseDeps().runScript(dir, 'echo oops 1>&2')).resolves.toEqual({ code: 0, stderr: 'oops\n' });
    await expect(rebaseDeps().runScript(dir, 'kill -9 $$')).resolves.toMatchObject({ code: 1 });
  });

  it('re-probes after a rebase: clears the probe of a PR with a number, and not before the ship', async () => {
    seedPr();
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    await rebaseDeps().reprobe();
    expect(clearOpenPrProbe).toHaveBeenCalledWith(store, id, 'r');
    expect(i.reprobe).toHaveBeenCalledOnce();
  });

  it('the user mode shows the messages and asks the confirm', async () => {
    seedPr();
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    const d = rebaseDeps();
    await d.confirm('why');
    expect(i.confirm).toHaveBeenCalledWith('Rebase on base?', 'why', 'Rebase and push');
    expect(d.requireMove).toBe(false);
    expect(d.info).toBe(i.info);
    expect(d.logError).toBe(i.logError);
  });
});

describe('the autopilot rebase mode (T1081)', () => {
  const auto = { repos: new Set(['r']) };

  it('writes each message to the debug log with the autopilot prefix, and needs a move', async () => {
    seedPr();
    const i = input();
    await rebaseOnBaseAction(i, () => [], auto);
    const d = rebaseDeps();
    expect(d.requireMove).toBe(true);
    await expect(d.confirm('x')).resolves.toBe(true);
    d.info('a');
    d.error('b');
    d.logError('c', new Error('boom'));
    d.logError('d', 'plain');
    expect(i.debug).toHaveBeenCalledWith('[ship] autopilot rebase on base: a');
    expect(i.debug).toHaveBeenCalledWith('[ship] autopilot rebase on base: b');
    expect(i.debug).toHaveBeenCalledWith('[ship] autopilot rebase on base: c: boom');
    expect(i.debug).toHaveBeenCalledWith('[ship] autopilot rebase on base: d: plain');
    expect(i.info).not.toHaveBeenCalled();
    expect(i.logError).not.toHaveBeenCalled();
  });

  it('says why nothing can run, with the reason in brackets unless no PR is behind', async () => {
    const i = input();
    await expect(rebaseOnBaseAction(i, () => [], auto)).resolves.toBe(false);
    expect(i.debug).toHaveBeenCalledWith(expect.stringMatching(/Rebase on base is not available/));
    seedPr({ number: null });
    store.db.prepare("UPDATE prs SET status = 'merged'").run();
    const j = input();
    await rebaseOnBaseAction(j, () => [], auto);
    expect(j.debug).toHaveBeenCalled();
  });

  it('a not-behind refusal gets its own sentence, any other reason is named', async () => {
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    expect(i.info).toHaveBeenCalledWith('Rebase on base is not available: no open pull request is behind its base.');
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w/r', 'b');
    store.db.prepare('UPDATE tickets SET agent_state = ? WHERE id = ?').run('running', id);
  });

  it('an error flagged by the rebase stops autopilot even when the push is claimed', async () => {
    seedPr();
    vi.mocked(rebaseOnBase).mockImplementationOnce(async (d) => { d.error('refused'); return true; });
    await expect(rebaseOnBaseAction(input(), () => [], auto)).resolves.toBe(true);
    vi.mocked(rebaseOnBase).mockImplementationOnce(async (d) => { d.error('refused'); return true; });
    await expect(rebaseOnBaseAction(input(), () => [])).resolves.toBe(false);
  });
});

describe('baseMovedFailure', () => {
  const gate = { gateEnv: () => ({ baseRef: 'develop' }) } as never;
  const pr = { repo: 'r', number: null, branch: 'b', cwd: '/w/r' };
  const signal = new AbortController().signal;
  const gitDirs = (ticket: { stdout: string; exitCode: number }, merged: { stdout: string; exitCode: number }): CiActionsInput['git'] =>
    vi.fn(async (_a: readonly string[], cwd: string) => ({ stderr: '', ...(cwd === '/w/r' ? ticket : merged) })) as never;
  const checkInput = (): Parameters<typeof checkBaseMoved>[0] => vi.mocked(checkBaseMoved).mock.calls.at(-1)![0];

  it('reads the last green base from the git dir, and none when the git dir is unreadable or empty', async () => {
    vi.mocked(checkBaseMoved).mockResolvedValue({ kind: 'passed' } as never);
    vi.mocked(readLastGreenBase).mockResolvedValue('G' as never);
    await baseMovedFailure(input({ git: gitDirs({ stdout: ' /g \n', exitCode: 0 }, { stdout: '', exitCode: 0 }) }), gate, pr, signal);
    await expect(checkInput().lastGreenBase!("/w/r")).resolves.toBe('G');
    expect(readLastGreenBase).toHaveBeenCalledWith('/g');
    vi.mocked(readLastGreenBase).mockClear();
    await baseMovedFailure(input({ git: gitDirs({ stdout: '/g', exitCode: 1 }, { stdout: '', exitCode: 0 }) }), gate, pr, signal);
    await expect(checkInput().lastGreenBase!("/w/r")).resolves.toBeNull();
    await baseMovedFailure(input({ git: gitDirs({ stdout: '  ', exitCode: 0 }, { stdout: '', exitCode: 0 }) }), gate, pr, signal);
    await expect(checkInput().lastGreenBase!("/w/r")).resolves.toBeNull();
    expect(readLastGreenBase).not.toHaveBeenCalled();
  });

  it('seeds the merged git dir only when both git dirs are known', async () => {
    vi.mocked(checkBaseMoved).mockResolvedValue({ kind: 'passed' } as never);
    const seed = async (ticket: { stdout: string; exitCode: number }, merged: { stdout: string; exitCode: number }): Promise<void> => {
      await baseMovedFailure(input({ git: gitDirs(ticket, merged) }), gate, pr, signal);
      await checkInput().seedState!({ mergedCwd: '/m', baseSha: 'B' } as never);
    };
    await seed({ stdout: '/g\n', exitCode: 0 }, { stdout: ' /mg \n', exitCode: 0 });
    expect(seedMergedState).toHaveBeenCalledWith('/g', '/mg', 'B');
    vi.mocked(seedMergedState).mockClear();
    await seed({ stdout: '/g', exitCode: 2 }, { stdout: '/mg', exitCode: 0 });
    await seed({ stdout: '', exitCode: 0 }, { stdout: '/mg', exitCode: 0 });
    await seed({ stdout: '/g', exitCode: 0 }, { stdout: '/mg', exitCode: 2 });
    await seed({ stdout: '/g', exitCode: 0 }, { stdout: '  ', exitCode: 0 });
    expect(seedMergedState).not.toHaveBeenCalled();
  });

  it('runs the gates on the merged cwd, with the ticket head and the merge facts', async () => {
    vi.mocked(checkBaseMoved).mockResolvedValue({ kind: 'passed' } as never);
    vi.mocked(runShipGates).mockResolvedValue(null);
    const i = input();
    await baseMovedFailure(i, gate, pr, signal);
    expect(checkInput()).toMatchObject({ cwd: '/w/r', baseRef: 'develop' });
    checkInput().debug!('dbg');
    expect(i.debug).toHaveBeenCalledWith('dbg');
    await checkInput().runGates({ cwd: '/merged', uiChanged: true, uiSkipReason: 'why', baseSha: 'BB' } as never);
    const [prs, deps] = vi.mocked(runShipGates).mock.calls[0]! as unknown as [unknown[], Record<string, unknown>];
    expect(prs).toEqual([{ ...pr, cwd: '/merged' }]);
    expect(deps).toMatchObject({ signal, uiChanged: true, uiSkipReason: 'why', mergedBaseSha: 'BB', kind: 'base-moved', onProgress: i.afterServerChange, evidence: { store, ticketId: id } });
    await expect((deps.headSha as () => Promise<string | null>)()).resolves.toBe(SHA);
    expect(i.git).toHaveBeenLastCalledWith(['rev-parse', 'HEAD'], '/w/r');
  });

  it('returns the failed reason, logs an unknown one, and is silent on other outcomes', async () => {
    const i = input();
    vi.mocked(checkBaseMoved).mockResolvedValueOnce({ kind: 'failed', reason: 'CI says no' } as never);
    await expect(baseMovedFailure(i, gate, pr, signal)).resolves.toBe('CI says no');
    vi.mocked(checkBaseMoved).mockResolvedValueOnce({ kind: 'unknown', reason: 'no fetch' } as never);
    await expect(baseMovedFailure(i, gate, pr, signal)).resolves.toBeNull();
    expect(i.debug).toHaveBeenCalledWith('[ship] base-moved check not run: no fetch');
    vi.mocked(i.debug).mockClear();
    vi.mocked(checkBaseMoved).mockResolvedValueOnce({ kind: 'passed' } as never);
    await expect(baseMovedFailure(i, gate, pr, signal)).resolves.toBeNull();
    expect(i.debug).not.toHaveBeenCalled();
  });

  it('a sandbox with a clone, or an unreadable sandbox list, skips the check and says why', async () => {
    const i = input();
    vi.mocked(i.sandbox.hasSandbox).mockResolvedValueOnce(true);
    await expect(baseMovedFailure(i, gate, pr, signal)).resolves.toBeNull();
    expect(i.debug).toHaveBeenCalledWith('[ship] base-moved check not run: the ticket has a sandbox, whose gates cannot see the merged worktree');
    vi.mocked(i.sandbox.hasSandbox).mockRejectedValueOnce(new Error('list broke'));
    await baseMovedFailure(i, gate, pr, signal);
    expect(i.debug).toHaveBeenCalledWith('[ship] sandbox lookup failed: list broke');
    vi.mocked(i.sandbox.hasSandbox).mockRejectedValueOnce('plain');
    await baseMovedFailure(i, gate, pr, signal);
    expect(i.debug).toHaveBeenCalledWith('[ship] sandbox lookup failed: plain');
    expect(checkBaseMoved).not.toHaveBeenCalled();
  });
});

describe('shipBaseCheck', () => {
  it('flushes the console when the check throws, and passes the throw on', async () => {
    const settled = vi.fn();
    const i = input();
    vi.mocked(checkBaseMoved).mockRejectedValue(new Error('check broke'));
    await expect(shipBaseCheck(i, { gateEnv: () => ({ baseRef: 'develop' }) } as never, settled)({ repo: 'r', cwd: '/w', branch: 'b' })).rejects.toThrow();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('hands the check a live signal and the repo, branch and cwd of the push', async () => {
    const gateEnv = vi.fn(() => ({ baseRef: 'develop' }));
    vi.mocked(checkBaseMoved).mockResolvedValue({ kind: 'failed', reason: 'R' } as never);
    const settled = vi.fn();
    await expect(shipBaseCheck(input(), { gateEnv } as never, settled)({ repo: 'r', cwd: '/w', branch: 'b' })).resolves.toBe('R');
    expect(gateEnv).toHaveBeenCalledWith({ repo: 'r', number: null, branch: 'b', cwd: '/w' });
    expect(settled).toHaveBeenCalledOnce();
  });
});

describe('shipBaseRemedy (T1169)', () => {
  const target = { repo: 'r', cwd: '/w/r', branch: 'feat' };
  const gateWith = (baseRef: string | undefined) => ({ gateEnv: baseRef === undefined ? undefined : vi.fn(() => ({ baseRef })) }) as never;
  const remedyDeps = (): Parameters<typeof remedyBaseMoved>[0] => vi.mocked(remedyBaseMoved).mock.calls.at(-1)![0];
  const headGit = (shas: Array<string | null>): CiActionsInput['git'] => {
    let n = 0;
    return vi.fn(async () => {
      const sha = shas[n++ % shas.length];
      return sha === null ? { stdout: '', stderr: '', exitCode: 1 } : { stdout: `${sha}\n`, stderr: '', exitCode: 0 };
    }) as never;
  };
  const S1 = '1'.repeat(40);
  const S2 = '2'.repeat(40);

  it('asks the gate env for the base of the target, and returns what the remedy returns', async () => {
    vi.mocked(remedyBaseMoved).mockResolvedValue({ kind: 'rebased', detail: 'd' });
    const gate = gateWith('develop');
    await expect(shipBaseRemedy(input(), gate, () => [])(target)).resolves.toEqual({ kind: 'rebased', detail: 'd' });
    expect((gate as { gateEnv: ReturnType<typeof vi.fn> }).gateEnv).toHaveBeenCalledWith({ repo: 'r', number: null, branch: 'feat', cwd: '/w/r' });
  });

  it('reads the failed gates of the repo and logs through debug', async () => {
    const i = input();
    await shipBaseRemedy(i, gateWith('develop'), () => [])(target);
    remedyDeps().failedGates();
    expect(latestBaseMovedFailedGates).toHaveBeenCalledWith(store, id, 'r');
    remedyDeps().debug('m');
    expect(i.debug).toHaveBeenCalledWith('m');
  });

  it('refuses the rebase when the base is unknown', async () => {
    await shipBaseRemedy(input(), gateWith(undefined), () => [])(target);
    await expect(remedyDeps().rebase()).resolves.toEqual({ moved: false, error: 'the base branch is unknown' });
    expect(rebaseOnBase).not.toHaveBeenCalled();
  });

  it('rebases a pre-ship branch without a PR number, and arms the lease when the head moved cleanly', async () => {
    const i = input({ git: headGit([S1, S2]) });
    await shipBaseRemedy(i, gateWith('develop'), () => [])(target);
    await expect(remedyDeps().rebase()).resolves.toEqual({ moved: true, error: null });
    const d = rebaseDeps();
    expect(d).toMatchObject({ repo: 'r', cwd: '/w/r', branch: 'feat', baseRef: 'develop', preShip: true });
    expect(d.armLease).toBeUndefined();
    await expect(d.confirm('q')).resolves.toBe(true);
    await expect(d.prHeadSha!()).rejects.toThrow('no pull request to read');
    await d.reprobe();
    expect(clearOpenPrProbe).not.toHaveBeenCalled();
    expect(armForcePushLease).toHaveBeenCalledWith(store, id, 'r');
  });

  it('does not arm the lease when the head stays, when a head is unreadable or when the rebase reported an error', async () => {
    for (const shas of [[S1, S1], [null, S2], [S1, null]]) {
      await shipBaseRemedy(input({ git: headGit(shas) }), gateWith('develop'), () => [])(target);
      await expect(remedyDeps().rebase()).resolves.toEqual({ moved: false, error: null });
    }
    vi.mocked(rebaseOnBase).mockImplementationOnce(async (d) => { d.error('one'); d.error('two'); return false; });
    await shipBaseRemedy(input({ git: headGit([S1, S2]) }), gateWith('develop'), () => [])(target);
    await expect(remedyDeps().rebase()).resolves.toEqual({ moved: true, error: 'one two' });
    expect(armForcePushLease).not.toHaveBeenCalled();
  });

  it('writes the rebase messages to the debug log with the remedy prefix', async () => {
    const i = input({ git: headGit([S1, S1]) });
    vi.mocked(rebaseOnBase).mockImplementationOnce(async (d) => { d.info('i'); d.logError('l', new Error('e')); d.logError('p', 'plain'); return true; });
    await shipBaseRemedy(i, gateWith('develop'), () => [])(target);
    await remedyDeps().rebase();
    expect(i.debug).toHaveBeenCalledWith('[ship] base-moved remedy: i');
    expect(i.debug).toHaveBeenCalledWith('[ship] base-moved remedy: l: e');
    expect(i.debug).toHaveBeenCalledWith('[ship] base-moved remedy: p: plain');
  });

  it('runs the ship gates on the rebased head with a live signal', async () => {
    vi.mocked(runShipGates).mockResolvedValue(null);
    const i = input();
    await shipBaseRemedy(i, gateWith('develop'), () => [])(target);
    await remedyDeps().gates();
    const [prs, deps] = vi.mocked(runShipGates).mock.calls[0]! as unknown as [unknown[], { signal: AbortSignal; evidence: unknown; onProgress: unknown; headSha: (c: string) => Promise<string | null> }];
    expect(prs).toEqual([{ repo: 'r', number: null, branch: 'feat', cwd: '/w/r' }]);
    expect(deps.signal.aborted).toBe(false);
    expect(deps.evidence).toEqual({ store, ticketId: id });
    expect(deps.onProgress).toBe(i.afterServerChange);
    await expect(deps.headSha('/x')).resolves.toBe(SHA);
    expect(i.git).toHaveBeenLastCalledWith(['rev-parse', 'HEAD'], '/x');
  });
});

describe('autoDeliverAction wiring', () => {
  const extra = { key: 'K', status: vi.fn(), log: vi.fn(), gate: { gateEnv: () => ({ baseRef: 'develop' }) } } as never;
  const deps = (): Parameters<typeof autoDeliverAfterConflict>[0] => vi.mocked(autoDeliverAfterConflict).mock.calls.at(-1)![0];

  it('passes the ticket seams and the host seams through', async () => {
    const i = input();
    await autoDeliverAction(i, extra);
    const d = deps();
    expect(d).toMatchObject({ ticketId: id, key: 'K', rounds: conflictRounds, blocked: i.deliver.blocked, runShip: i.deliver.runShip, info: i.info, error: i.error, logError: i.logError, afterServerChange: i.afterServerChange });
    expect(d.agentActive()).toBe(false);
    await d.ensureSynced();
    expect(i.sandbox.ensureSynced).toHaveBeenCalledWith(id);
    expect(d.targets()).toEqual({ available: false, reason: expect.any(String) });
  });

  it('runs the gates with the merged signal and the ticket evidence', async () => {
    const i = input();
    await autoDeliverAction(i, extra);
    const signal = new AbortController().signal;
    await deps().runGates([{ cwd: '/w' }] as never, signal);
    const [prs, g] = vi.mocked(runShipGatesReport).mock.calls[0]! as unknown as [unknown[], Record<string, unknown>];
    expect(prs).toEqual([{ cwd: '/w' }]);
    expect(g).toMatchObject({ signal, onProgress: i.afterServerChange, evidence: { store, ticketId: id } });
    expect(g.only).toBeUndefined();
    await expect((g.headSha as (c: string) => Promise<string | null>)('/w')).resolves.toBe(SHA);
    // The merge commit the refusal names is the merged HEAD of the PR worktree (T1315).
    await expect(deps().mergeSha!({ repo: 'r', number: null, branch: 'b', cwd: '/w' } as never)).resolves.toBe(SHA);
  });

  it('re-runs only the named gates when the environment re-run asks for them', async () => {
    const i = input();
    await autoDeliverAction(i, extra);
    await deps().runGates([{ cwd: '/w' }] as never, new AbortController().signal, ['unit']);
    const [, g] = vi.mocked(runShipGatesReport).mock.calls[0]! as unknown as [unknown[], Record<string, unknown>];
    expect(g.only).toEqual(['unit']);
  });

  it('checks the base and verifies the merge through the shared helpers', async () => {
    const i = input();
    vi.mocked(checkBaseMoved).mockResolvedValue({ kind: 'failed', reason: 'R' } as never);
    await autoDeliverAction(i, extra);
    await expect(deps().checkBase!({ repo: 'r', number: null, branch: 'b', cwd: '/w' } as never, new AbortController().signal)).resolves.toBe('R');
    vi.mocked(verifyMergeResolved).mockResolvedValue('V' as never);
    await expect(deps().verifyMerge!({ cwd: '/w' } as never, 2 as never)).resolves.toBe('V');
    expect(vi.mocked(verifyMergeResolved).mock.calls[0]![1]).toBe('/w');
    expect(vi.mocked(verifyMergeResolved).mock.calls[0]![2]).toBe(2);
  });

  it('re-probes, then refreshes the undelivered counts of its own ticket', async () => {
    const i = input();
    const order: string[] = [];
    vi.mocked(i.reprobe).mockImplementation(async () => { order.push('reprobe'); });
    vi.mocked(refreshUndelivered).mockImplementation(async () => { order.push('refresh'); });
    await autoDeliverAction(i, extra);
    await deps().reprobe();
    expect(order).toEqual(['reprobe', 'refresh']);
    expect(vi.mocked(refreshUndelivered).mock.calls[0]![0]).toBe(i.deliver.tracker);
    expect(vi.mocked(refreshUndelivered).mock.calls[0]![1]).toBe(id);
  });
});

describe('refreshUndeliveredForShipTickets', () => {
  let pid = 0;
  beforeEach(() => { pid = upsertProject(store, { slug: 'pp' }).id; });
  const mk = (key: string, stage: string, archived = false, projectId?: number): number => {
    const t = createTicket(store, { key, title: key, projectId: projectId ?? pid }).id;
    store.db.prepare('UPDATE tickets SET stage_current = ?, archived_at = ? WHERE id = ?').run(stage, archived ? '2026-01-01T00:00:00Z' : null, t);
    return t;
  };
  const tracker = (values: Map<number, unknown>) => ({ get: (k: number) => values.get(k) }) as never;

  it('measures only the ship tickets that are not archived', async () => {
    const ship = mk('S', 'ship');
    mk('A', 'ship', true);
    mk('I', 'impl');
    const base = input();
    await refreshUndeliveredForShipTickets({ store, git: base.git, sandbox: base.sandbox, projectId: pid, logError: vi.fn() }, tracker(new Map()));
    expect(vi.mocked(refreshUndelivered).mock.calls.map((c) => c[1])).toEqual([ship]);
  });

  it('reports a change only when a tracked count differs before and after', async () => {
    const ship = mk('S', 'ship');
    const base = input();
    const values = new Map<number, unknown>();
    const run = (): Promise<boolean> => refreshUndeliveredForShipTickets({ store, git: base.git, sandbox: base.sandbox, projectId: pid, logError: vi.fn() }, tracker(values));
    await expect(run()).resolves.toBe(false);
    vi.mocked(refreshUndelivered).mockImplementationOnce(async () => { values.set(ship, { n: 1 }); });
    await expect(run()).resolves.toBe(true);
    await expect(run()).resolves.toBe(false);
  });

  it('logs a failing measure with the count message and still returns what moved before it', async () => {
    mk('S', 'ship');
    const base = input();
    const logError = vi.fn();
    const err = new Error('git gone');
    vi.mocked(refreshUndelivered).mockRejectedValueOnce(err);
    await expect(refreshUndeliveredForShipTickets({ store, git: base.git, sandbox: base.sandbox, projectId: pid, logError }, tracker(new Map()))).resolves.toBe(false);
    expect(logError).toHaveBeenCalledWith('karst: undelivered-commit count failed', err);
  });

  it('reads the project of the tickets it measures', async () => {
    const other99 = upsertProject(store, { slug: 'qq' }).id;
    const other = mk('O', 'ship', false, other99);
    const base = input();
    await refreshUndeliveredForShipTickets({ store, git: base.git, sandbox: base.sandbox, projectId: other99, logError: vi.fn() }, tracker(new Map()));
    expect(vi.mocked(refreshUndelivered).mock.calls.map((c) => c[1])).toEqual([other]);
  });
});

describe('headShaOf and the blocked prompt', () => {
  it('headShaOf accepts a 64-digit sha and nothing longer', async () => {
    const mkGit = (stdout: string) => ({ git: vi.fn(async () => ({ stdout, stderr: '', exitCode: 0 })) }) as never;
    await expect(headShaOf(mkGit('f'.repeat(64)), '/w')).resolves.toBe('f'.repeat(64));
    await expect(headShaOf(mkGit('f'.repeat(65)), '/w')).resolves.toBeNull();
    await expect(headShaOf(mkGit('f'.repeat(39)), '/w')).resolves.toBeNull();
    await expect(headShaOf(mkGit(`x${'f'.repeat(40)}`), '/w')).resolves.toBeNull();
  });

  it('words the stopped message exactly, with or without the carry hint', async () => {
    const warn = vi.fn(async () => undefined);
    const prompt = deliverBlockedPrompt(warn, vi.fn(async () => {}));
    await prompt('R', false);
    expect(warn).toHaveBeenLastCalledWith('Deliver to PR pushed nothing: the sandbox is not in sync (R).', OPEN_SYNC_DIFF);
    await prompt('R', true);
    expect(warn).toHaveBeenLastCalledWith('Deliver to PR pushed nothing: the sandbox is not in sync (R). Use "Carry sandbox commits onto host branch" on the dashboard.', OPEN_SYNC_DIFF);
    await prompt('R', true, true);
    expect(warn).toHaveBeenLastCalledWith('Deliver to PR pushed nothing. R Start VS Code from a shell that has the sandbox CLI on its PATH, then retry.');
  });
});
