import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArtifactStore, ticketStoreDir, type ArtifactStore } from './store.js';

let root: string;
let src: string;
let store: ArtifactStore;
let clock: Date;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'art-store-'));
  src = join(root, 'src');
  mkdirSync(src);
  clock = new Date('2026-01-01T00:00:00Z');
  store = createArtifactStore({ artifactsRoot: join(root, 'artifacts'), projectId: 7, maxBytes: 1000, now: () => clock });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (name: string, body: string): string => {
  const p = join(src, name);
  writeFileSync(p, body);
  return p;
};
const rev = (name: string, extra = {}) => ({
  ticketId: 1, repo: 'app', relPath: name, sourcePath: join(src, name), ...extra,
});

describe('artifact store', () => {
  it('commits, lists, shows, diffs and carries trailers', async () => {
    put('plan.md', 'v1');
    const a = await store.commitRevision(rev('plan.md', { trailers: { session: 's1', kind: 'plan' } }));
    put('plan.md', 'v2');
    const b = await store.commitRevision(rev('plan.md'));
    expect(a).toMatch(/^[0-9a-f]{40}/);
    expect(b).not.toBe(a);
    expect(await store.listArtifacts(1)).toEqual([{ path: 'app/plan.md', revisions: 2, latestSha: b }]);
    expect((await store.show(1, a!, 'app/plan.md')).toString()).toBe('v1');
    expect(await store.diff(1, a!, b!, 'app/plan.md')).toContain('+v2');
    const h = await store.history(1, 'app/plan.md');
    expect(h.map((r) => r.sha)).toEqual([b, a]);
    expect(h[1]!.trailers).toEqual({ session: 's1', kind: 'plan' });
  });

  it('is a no-op for identical content', async () => {
    put('a.md', 'same');
    expect(await store.commitRevision(rev('a.md'))).not.toBeNull();
    expect(await store.commitRevision(rev('a.md'))).toBeNull();
    expect((await store.listArtifacts(1))[0]!.revisions).toBe(1);
  });

  it('records deletions as commits and ignores deleting the unknown', async () => {
    put('a.md', 'x');
    await store.commitRevision(rev('a.md'));
    expect(await store.commitRevision({ ticketId: 1, repo: 'app', relPath: 'nope.md', deleted: true })).toBeNull();
    const del = await store.commitRevision({ ticketId: 1, repo: 'app', relPath: 'a.md', deleted: true });
    expect(del).not.toBeNull();
    expect(await store.listArtifacts(1)).toEqual([]);
    expect((await store.history(1, 'app/a.md')).length).toBe(2);
  });

  it('skips secrets, oversize, symlink, hardlink, FIFO and bad paths with recorded reasons', async () => {
    put('.env', 'K=1');
    put('big.md', 'x'.repeat(2000));
    put('real.md', 'r');
    symlinkSync(join(src, 'real.md'), join(src, 'link.md'));
    linkSync(join(src, 'real.md'), join(src, 'hard.md'));
    execFileSync('mkfifo', [join(src, 'pipe.md')]);
    for (const n of ['.env', 'big.md', 'link.md', 'hard.md', 'pipe.md']) {
      expect(await store.commitRevision(rev(n))).toBeNull();
    }
    expect(await store.commitRevision(rev('../x.md', { sourcePath: join(src, 'real.md') }))).toBeNull();
    const reasons = store.listSkips(1).map((s) => `${s.path}|${s.reason.split(':')[0]}`);
    expect(reasons).toEqual([
      'app/.env|secret-pattern', 'app/big.md|oversize', 'app/link.md|not-regular',
      'app/hard.md|hardlinked', 'app/pipe.md|not-regular', 'app/../x.md|unsafe-path',
    ]);
    expect(await store.listArtifacts(1)).toEqual([]);
  });

  it('serializes concurrent commits into a linear history', async () => {
    const shas = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        put(`f${i}.md`, `c${i}`);
        return store.commitRevision(rev(`f${i}.md`));
      }),
    );
    expect(new Set(shas).size).toBe(8);
    expect((await store.listArtifacts(1)).length).toBe(8);
  });

  it('purges one ticket only, and purges stale stores by age', async () => {
    put('a.md', 'x');
    await store.commitRevision(rev('a.md'));
    await store.commitRevision(rev('a.md', { ticketId: 2 }));
    await store.purgeArtifacts(1);
    expect(existsSync(ticketStoreDir(join(root, 'artifacts'), 7, 1))).toBe(false);
    expect((await store.listArtifacts(2)).length).toBe(1);
    clock = new Date('2026-03-01T00:00:00Z');
    expect(await store.purgeStale(90)).toEqual([]);
    expect(await store.purgeStale(30)).toEqual([2]);
    expect(await store.listArtifacts(2)).toEqual([]);
  });
});
