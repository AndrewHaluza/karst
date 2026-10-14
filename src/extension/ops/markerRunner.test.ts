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
  it('returns a non-zero exit with its stderr', async () => {
    const spawn: MarkerSpawn = async () => ({ stdout: 'x', stderr: 'no such ticket', exitCode: 2 });
    expect(await createMarkerRunner(facts, spawn)('fix')).toEqual({ code: 2, stderr: 'no such ticket' });
  });
});
