import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGateRunRegistry,
  describeGateReap,
  isInKarstWorktree,
  reapOrphanedGates,
  type GateRunRecord,
} from './gateRuns.js';
import type { ProcessFactsSource } from './serverIdentity.js';

const WT = '/repo/.karst/worktrees/t1';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gate-runs-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const gate = { ticketId: 7, gateName: 'sast', pid: 4242, cwd: WT };

describe('isInKarstWorktree', () => {
  it('accepts a path under .karst/worktrees and rejects others', () => {
    expect(isInKarstWorktree(`${WT}/src`)).toBe(true);
    expect(isInKarstWorktree('/home/u/project')).toBe(false);
    expect(isInKarstWorktree('/x/.karst/worktrees')).toBe(false);
  });
});

describe('createGateRunRegistry', () => {
  const make = () => {
    const kill = vi.fn((_pid: number) => 'killed' as const);
    const registry = createGateRunRegistry({ dir, hostPid: 99, startTime: async () => 1_000, kill });
    return { registry, kill };
  };

  it('writes a record on spawn with the host pid, pgid, start time and ticket', async () => {
    const { registry } = make();
    registry.track(gate);
    await settle();
    const rec = JSON.parse(await readFile(join(dir, '4242'), 'utf8')) as GateRunRecord;
    expect(rec).toEqual({ hostPid: 99, pgid: 4242, startMs: 1_000, ticketId: 7, gateName: 'sast', worktree: WT });
  });

  it.each(['completed', 'timed out', 'stopped'])('removes the record when the gate ends (%s)', async () => {
    const { registry } = make();
    const dispose = registry.track(gate);
    await settle();
    expect(await readdir(dir)).toEqual(['4242']);
    dispose();
    await settle();
    expect(await readdir(dir)).toEqual([]);
  });

  it('writes nothing when the gate ends before the start time answers', async () => {
    const registry = createGateRunRegistry({ dir, hostPid: 1, startTime: async () => 5 });
    registry.track(gate)();
    await settle();
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('writes nothing when the start time is unknown', async () => {
    const debug = vi.fn();
    const registry = createGateRunRegistry({ dir, hostPid: 1, startTime: async () => null, debug });
    registry.track(gate);
    await settle();
    expect(await readdir(dir).catch(() => [])).toEqual([]);
    expect(debug).toHaveBeenCalled();
  });

  it('killAll kills each live group of this host once and drops its record', async () => {
    const { registry, kill } = make();
    registry.track(gate);
    registry.track({ ...gate, pid: 4300, gateName: 'lint' });
    const ended = registry.track({ ...gate, pid: 4400 });
    await settle();
    ended();
    await settle();
    expect(registry.killAll().sort()).toEqual([4242, 4300]);
    expect(kill.mock.calls.map((c) => c[0]).sort()).toEqual([4242, 4300]);
    expect(await readdir(dir)).toEqual([]);
    expect(registry.killAll()).toEqual([]);
  });

  it('killAll survives a kill that throws', () => {
    const debug = vi.fn();
    const registry = createGateRunRegistry({
      dir, hostPid: 1, startTime: async () => 1, debug,
      kill: () => { throw new Error('boom'); },
    });
    registry.track(gate);
    expect(registry.killAll()).toEqual([]);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('reapOrphanedGates', () => {
  const record: GateRunRecord = { hostPid: 1, pgid: 4242, startMs: 10_000, ticketId: 7, gateName: 'sast', worktree: WT };
  const put = (r: GateRunRecord = record) => writeFile(join(dir, String(r.pgid)), JSON.stringify(r));
  const facts = (over: Partial<Record<'host' | 'leader', boolean>> & { start?: number | null; cwd?: string | null } = {}): ProcessFactsSource => ({
    isAlive: (pid) => (pid === record.hostPid ? over.host ?? false : over.leader ?? true),
    processStartMs: () => (over.start === undefined ? 10_000 : over.start),
    liveCwd: () => (over.cwd === null ? null : { path: over.cwd ?? `${WT}/sub`, deleted: false }),
  });
  const run = (f: ProcessFactsSource) => {
    const kill = vi.fn((_pid: number) => 'killed' as const);
    return reapOrphanedGates({ dir, facts: f, kill }).then((reaped) => ({ reaped, kill }));
  };

  it('kills a group with a dead host, matching start time and worktree cwd', async () => {
    await put();
    const { reaped, kill } = await run(facts());
    expect(kill).toHaveBeenCalledWith(4242);
    expect(reaped).toHaveLength(1);
    expect(describeGateReap(reaped[0]!)).toContain('sast');
    expect(describeGateReap(reaped[0]!)).toContain('ticket 7');
    expect(await readdir(dir)).toEqual([]);
  });

  it('skips a reused pid (start time differs) and drops the record', async () => {
    await put();
    const { kill } = await run(facts({ start: 99_000 }));
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('skips a cwd outside a karst worktree', async () => {
    await put();
    const { kill } = await run(facts({ cwd: '/home/u/other' }));
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('skips a live host pid and keeps the record', async () => {
    await put();
    const { kill } = await run(facts({ host: true }));
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['4242']);
  });

  it('removes a record whose leader is dead without a kill', async () => {
    await put();
    const { kill } = await run(facts({ leader: false }));
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not act when start time or cwd cannot be read', async () => {
    await put();
    expect((await run(facts({ start: null }))).kill).not.toHaveBeenCalled();
    expect((await run(facts({ cwd: null }))).kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['4242']);
  });

  it('keeps the record and reports failure when the kill is denied', async () => {
    await put();
    const reaped = await reapOrphanedGates({ dir, facts: facts(), kill: () => 'denied' });
    expect(reaped[0]!.outcome).toBe('kill-failed');
    expect(describeGateReap(reaped[0]!)).toContain('still runs');
    expect(await readdir(dir)).toEqual(['4242']);
  });

  it('drops a malformed record and a missing directory is empty', async () => {
    await writeFile(join(dir, '55'), 'not json');
    const { kill } = await run(facts());
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
    expect(await reapOrphanedGates({ dir: join(dir, 'none'), facts: facts() })).toEqual([]);
  });
});
