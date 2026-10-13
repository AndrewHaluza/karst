import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgePaths, ensureBridgeDir, listBridgeTicketIds, removeBridgeDir } from './bridgeDir.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bridge-')); });
afterEach(() => rm(root, { recursive: true, force: true }));

describe('bridgeDir', () => {
  it('derives host and in-sandbox paths from the ticket id only', () => {
    expect(bridgePaths('/g', 7)).toEqual({
      dir: '/g/events/7', eventsFile: '/g/events/7/events.ndjson', stateFile: '/g/state/7.json', runDir: '/karst-bridge/7',
    });
  });
  it('rejects a non-integer ticket id (path traversal guard)', () => {
    expect(() => bridgePaths('/g', 1.5)).toThrow();
    expect(() => bridgePaths('/g', -1)).toThrow();
  });
  it('ensure creates the dir with an empty events file, idempotently', async () => {
    const p = bridgePaths(root, 7);
    await ensureBridgeDir(p);
    await ensureBridgeDir(p);
    expect(await readFile(p.eventsFile, 'utf8')).toBe('');
    expect((await stat(p.stateFile.replace(/7\.json$/, ''))).isDirectory()).toBe(true);
  });
  it('remove deletes dir and state, tolerating absence', async () => {
    const p = bridgePaths(root, 7);
    await ensureBridgeDir(p);
    await removeBridgeDir(p);
    await removeBridgeDir(p);
    await expect(stat(p.dir)).rejects.toThrow();
  });
  it('lists numeric ticket dirs only', async () => {
    await ensureBridgeDir(bridgePaths(root, 3));
    await ensureBridgeDir(bridgePaths(root, 12));
    await symlink('/', join(root, 'events', 'evil'));
    expect((await listBridgeTicketIds(root)).sort((a, b) => a - b)).toEqual([3, 12]);
  });
  it('lists nothing when the root has no events dir', async () => {
    expect(await listBridgeTicketIds(join(root, 'nope'))).toEqual([]);
  });
});
