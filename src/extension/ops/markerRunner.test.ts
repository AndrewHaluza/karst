import { describe, expect, it, vi } from 'vitest';
import { createMarkerRunner, type MarkerSpawn } from './markerRunner.js';

const facts = { nodePath: '/bin/node', cliEntry: '/ext/cli.js', dbPath: '/g/karst.db', manifestPath: '/r/karst.yml', ticketKey: 'KAR-7', cwd: '/wt/t7' };

describe('createMarkerRunner', () => {
  it('spawns the stage pass CLI with the host db, manifest and ticket', async () => {
    const spawn = vi.fn<MarkerSpawn>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const result = await createMarkerRunner(facts, spawn)('impl');
    expect(spawn).toHaveBeenCalledWith(
      '/bin/node',
      ['/ext/cli.js', 'stage', 'impl', 'pass', '--db', '/g/karst.db', '--manifest', '/r/karst.yml', '--ticket', 'KAR-7'],
      '/wt/t7',
    );
    expect(result).toEqual({ code: 0, stderr: '' });
  });
  it('syncs BEFORE the stage CLI for a sandboxed ticket (T700)', async () => {
    const order: string[] = [];
    const spawn: MarkerSpawn = async () => { order.push('cli'); return { stdout: '', stderr: '', exitCode: 0 }; };
    const result = await createMarkerRunner({ ...facts, ensureSynced: async () => { order.push('sync'); return { ok: true }; } }, spawn)('impl');
    expect(order).toEqual(['sync', 'cli']);
    expect(result.code).toBe(0);
  });
  it('a failed sync never reaches the CLI and is transient', async () => {
    const spawn = vi.fn<MarkerSpawn>();
    const result = await createMarkerRunner({ ...facts, ensureSynced: async () => ({ ok: false, reason: 'sbx down', diverged: false }) }, spawn)('impl');
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ code: 1, stderr: 'sbx down', transient: true, diverged: false });
  });
  it('a diverged branch is not transient', async () => {
    const result = await createMarkerRunner({ ...facts, ensureSynced: async () => ({ ok: false, reason: 'not a fast-forward', diverged: true }) }, vi.fn())('impl');
    expect(result).toMatchObject({ transient: false, diverged: true });
  });
  it('a host ticket (no ensureSynced) runs the CLI directly', async () => {
    const spawn = vi.fn<MarkerSpawn>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await createMarkerRunner(facts, spawn)('impl');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('the empty-work guard refusal is permanent; an unrecognised CLI failure is transient', async () => {
    const refuse: MarkerSpawn = async () => ({ stdout: '', stderr: 'karst: cannot mark this stage done: no repository has changes', exitCode: 1 });
    const busy: MarkerSpawn = async () => ({ stdout: '', stderr: 'SQLITE_BUSY: database is locked', exitCode: 1 });
    expect(await createMarkerRunner(facts, refuse)('impl')).toMatchObject({ transient: false });
    expect(await createMarkerRunner(facts, busy)('impl')).toMatchObject({ transient: true });
  });
  it('returns a non-zero exit with its stderr', async () => {
    const spawn: MarkerSpawn = async () => ({ stdout: 'x', stderr: 'no such ticket', exitCode: 2 });
    expect(await createMarkerRunner(facts, spawn)('fix')).toMatchObject({ code: 2, stderr: 'no such ticket' });
  });
});
