import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgePaths, type BridgePaths } from './bridgeDir.js';
import { writeMarkerReply } from './markerReply.js';

let root: string;
let paths: BridgePaths;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reply-'));
  paths = bridgePaths(root, 7);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('writeMarkerReply', () => {
  it('writes <seq>.json and leaves no temp file behind', async () => {
    await writeMarkerReply(paths, 'abc-1', { v: 1, stage: 'impl', ok: true, retrying: false, reason: '' });
    expect(await readdir(paths.resultsDir)).toEqual(['abc-1.json']);
    expect(JSON.parse(await readFile(join(paths.resultsDir, 'abc-1.json'), 'utf8'))).toEqual({ v: 1, stage: 'impl', ok: true, retrying: false, reason: '' });
  });
  it('refuses a seq that is not a plain token (path traversal)', async () => {
    await expect(writeMarkerReply(paths, '../x', { v: 1, stage: 'impl', ok: true, retrying: false, reason: '' })).rejects.toThrow(/seq/);
  });
});
