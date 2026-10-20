import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostHeadFileFor, recordHostHead } from '../hostHead.js';
import { bridgePaths, ensureBridgeDir, listBridgeTicketIds, removeBridgeDir, sandboxHookChannel } from './bridgeDir.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bridge-')); });
afterEach(() => rm(root, { recursive: true, force: true }));

describe('bridgeDir', () => {
  it('derives host and in-sandbox paths from the ticket id only', () => {
    expect(bridgePaths('/g', 7)).toEqual({
      dir: '/g/events/7', eventsFile: '/g/events/7/events.ndjson', stateFile: '/g/state/7.json',
      resultsDir: '/g/events/7/results', inboxDir: '/g/events/7/inbox', pendingFile: '/g/state/7.marker.json', handledFile: '/g/state/7.handled.json', runDir: '/karst-bridge/7',
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
  it('enforces sticky 1777 dir and 0666 events file regardless of umask or a pre-existing file', async () => {
    const p = bridgePaths(root, 9);
    await mkdir(p.dir, { recursive: true });
    await writeFile(p.eventsFile, '', { mode: 0o644 });
    await ensureBridgeDir(p);
    expect((await stat(p.dir)).mode & 0o1777).toBe(0o1777);
    expect((await stat(p.eventsFile)).mode & 0o777).toBe(0o666);
  });
  it('refuses a pre-planted symlink at the events file and leaves its target mode alone', async () => {
    const p = bridgePaths(root, 5);
    await mkdir(p.dir, { recursive: true });
    const target = join(root, 'host-file');
    await writeFile(target, 'host', { mode: 0o600 });
    await symlink(target, p.eventsFile);
    await expect(ensureBridgeDir(p)).rejects.toThrow(/symlink|regular file/);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });
  it('remove deletes dir and state, tolerating absence', async () => {
    const p = bridgePaths(root, 7);
    await ensureBridgeDir(p);
    await removeBridgeDir(p);
    await removeBridgeDir(p);
    await expect(stat(p.dir)).rejects.toThrow();
  });
  it('remove also deletes the host-head record, which lives outside the mount', async () => {
    const p = bridgePaths(root, 8);
    await ensureBridgeDir(p);
    const file = hostHeadFileFor(p.dir);
    await recordHostHead(file, '/wt', 'a'.repeat(40));
    await removeBridgeDir(p);
    await expect(stat(file)).rejects.toThrow();
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

describe('sandboxHookChannel', () => {
  const paths = bridgePaths('/root', 7);
  it('names the runner run dir in the endpoint and the host dir as configDir', () => {
    expect(sandboxHookChannel(paths, 'L1', '/karst-bridge/7')).toEqual({
      endpointUrl: 'file:///karst-bridge/7/events.ndjson',
      configDir: paths.dir,
      runDir: '/karst-bridge/7',
      launchId: 'L1',
    });
  });
  it('omits launchId when the launch has none', () => {
    expect('launchId' in sandboxHookChannel(paths, undefined, paths.dir)).toBe(false);
  });
});
