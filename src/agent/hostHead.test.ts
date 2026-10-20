import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostHeadFileFor, readHostHead, recordHostHead } from './hostHead.js';

describe('host head record', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'karst-hh-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('lives in <root>/state, outside the mounted events dir', () => {
    expect(hostHeadFileFor(join('/g', 'events', '7'))).toBe(join('/g', 'state', '7.host-head.json'));
  });

  it('round-trips one head per worktree and keeps the others', async () => {
    const file = join(root, 'state', '7.host-head.json');
    await recordHostHead(file, '/wt/a', 'a'.repeat(40));
    await recordHostHead(file, '/wt/b', 'b'.repeat(40));
    await recordHostHead(file, '/wt/a', 'c'.repeat(40));
    expect(await readHostHead(file, '/wt/a')).toBe('c'.repeat(40));
    expect(await readHostHead(file, '/wt/b')).toBe('b'.repeat(40));
    expect(await readFile(file, 'utf8')).toContain('/wt/b');
  });

  it('reads undefined for a missing, corrupt or non-sha record', async () => {
    const file = join(root, 'state', '7.host-head.json');
    expect(await readHostHead(file, '/wt/a')).toBeUndefined();
    await recordHostHead(file, '/wt/a', 'not-a-sha');
    expect(await readHostHead(file, '/wt/a')).toBeUndefined();
  });
});
