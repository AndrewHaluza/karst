import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeSpinReap,
  isInSpinFixtureRoot,
  reapOrphanedSpinServers,
  recordSpinServers,
  removeSpinServerRecords,
} from './spinFixtureOrphans.js';
import type { ProcessFactsSource } from './serverIdentity.js';

const CWD = '/tmp/karst-spin-abc/frontend';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spin-fixture-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const server = { pid: 5001, port: 28689, cwd: CWD };

function facts(over: Partial<Record<'owner' | 'server', boolean>> & { startMs?: number; cwd?: string | null } = {}): ProcessFactsSource {
  return {
    isAlive: (pid) => (pid === 77 ? (over.owner ?? false) : (over.server ?? true)),
    liveCwd: () => (over.cwd === null ? null : { path: over.cwd ?? CWD, deleted: false }),
    processStartMs: () => over.startMs ?? 1_000,
  };
}

async function record(): Promise<void> {
  await recordSpinServers([server], { dir, ownerPid: 77, startTime: async () => 1_000 });
}

describe('isInSpinFixtureRoot', () => {
  it('accepts a path with a karst-spin-* segment and rejects others', () => {
    expect(isInSpinFixtureRoot(CWD)).toBe(true);
    expect(isInSpinFixtureRoot('/var/folders/x/karst-spin-Zz9')).toBe(true);
    expect(isInSpinFixtureRoot('/home/u/karst-spinner/app')).toBe(false);
    expect(isInSpinFixtureRoot('/home/u/project')).toBe(false);
  });
});

describe('recordSpinServers / removeSpinServerRecords', () => {
  it('writes one record per server and skips a server with no start time', async () => {
    await recordSpinServers([server, { pid: 5002, port: 28690, cwd: CWD }], {
      dir,
      ownerPid: 77,
      startTime: async (pid) => (pid === 5001 ? 1_000 : null),
    });
    expect(await readdir(dir)).toEqual(['5001']);
  });
  it('removes the records of the given servers', async () => {
    await record();
    removeSpinServerRecords([server], dir);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('reapOrphanedSpinServers', () => {
  it('kills a group whose owner is dead, start time matches and cwd is a spin root', async () => {
    await record();
    const kill = vi.fn(() => 'killed' as const);
    const reaped = await reapOrphanedSpinServers({ dir, facts: facts(), kill });
    expect(kill).toHaveBeenCalledWith(5001);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.outcome).toBe('killed');
    expect(describeSpinReap(reaped[0]!)).toContain('28689');
    expect(await readdir(dir)).toEqual([]);
  });
  it('does not kill while the owner lives', async () => {
    await record();
    const kill = vi.fn(() => 'killed' as const);
    expect(await reapOrphanedSpinServers({ dir, facts: facts({ owner: true }), kill })).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['5001']);
  });
  it('does not kill a reused pid (start time differs) and drops the record', async () => {
    await record();
    const kill = vi.fn(() => 'killed' as const);
    await reapOrphanedSpinServers({ dir, facts: facts({ startMs: 900_000 }), kill });
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
  it('does not kill a process whose cwd is outside a spin root', async () => {
    await record();
    const kill = vi.fn(() => 'killed' as const);
    await reapOrphanedSpinServers({ dir, facts: facts({ cwd: '/home/u/project' }), kill });
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
  it('keeps the record when the cwd is unreported', async () => {
    await record();
    const kill = vi.fn(() => 'killed' as const);
    await reapOrphanedSpinServers({ dir, facts: facts({ cwd: null }), kill });
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['5001']);
  });
  it('drops the record of a server that already ended', async () => {
    await record();
    const kill = vi.fn(() => 'killed' as const);
    await reapOrphanedSpinServers({ dir, facts: facts({ server: false }), kill });
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
  it('keeps the record when the kill is denied', async () => {
    await record();
    const reaped = await reapOrphanedSpinServers({ dir, facts: facts(), kill: () => 'denied' });
    expect(reaped[0]!.outcome).toBe('kill-failed');
    expect(await readdir(dir)).toEqual(['5001']);
  });
  it('returns nothing when the directory is missing', async () => {
    expect(await reapOrphanedSpinServers({ dir: join(dir, 'none'), facts: facts() })).toEqual([]);
  });
});
