import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { manifest, uat as uatConfig } from '../../manifest/fixtures.js';
import { recordBaselineDecisions } from '../../store/baselineDecisions.js';
import type { GitBytesRunner, GitRunner } from '../../integrations/git.js';
import { baselineLabel, isImagePath, loadBaselineRows, withBaselines } from './baselineRows.js';
import { removeBaselineReviewDir } from './baselineReviewRetention.js';

describe('baselineLabel / isImagePath', () => {
  it('strips the static directory prefix of the matching glob', () => {
    const globs = ['tests/visual/__baselines__/**', 'tests/visual/layout-known-failures.json'];
    expect(baselineLabel('tests/visual/__baselines__/chromium/settings.png', globs)).toBe('chromium/settings.png');
    expect(baselineLabel('tests/visual/layout-known-failures.json', globs)).toBe('layout-known-failures.json');
    expect(baselineLabel('elsewhere/x.png', globs)).toBe('elsewhere/x.png');
  });
  it('recognises image extensions case-insensitively', () => {
    expect(isImagePath('a/B.PNG')).toBe(true);
    expect(isImagePath('a/ledger.json')).toBe(false);
  });
});

describe('loadBaselineRows', () => {
  let store: Store;
  let ticketId: number;
  let root: string;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'K-1', title: 't' }).id;
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ticketId, '/repo', '/wt', 'b', 'develop', 'inherited');
    root = mkdtempSync(join(tmpdir(), 'karst-br-'));
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const git: GitRunner = async (args) => {
    if (args[0] === 'merge-base') return { stdout: 'mb1\n', stderr: '', exitCode: 0 };
    if (args[0] === 'diff') {
      return {
        stdout: 'M\0tests/visual/__baselines__/a.png\0A\0tests/visual/__baselines__/b.png\0D\0tests/visual/__baselines__/c.png\0M\0tests/visual/ledger.json\0',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const gitBytes: GitBytesRunner = async () => ({
    stdout: Buffer.from('old-image-bytes'), stdoutTruncated: false, stderr: '', exitCode: 0,
  });
  const m = manifest({}, {
    uat: uatConfig({ baselineReview: { paths: ['tests/visual/__baselines__/**', 'tests/visual/ledger.json'] } }),
  });

  it('is empty when the feature is off', async () => {
    const rows = await loadBaselineRows({
      store, manifest: manifest({}), git, gitBytes, ticketId, storageRoot: root, toUri: (p) => `vsc:${p}`,
    });
    expect(rows).toEqual([]);
  });

  it('builds one row per change with old/new sources by status, and materializes old images by hash', async () => {
    const rows = await loadBaselineRows({
      store, manifest: m, git, gitBytes, ticketId, storageRoot: root, toUri: (p) => `vsc:${p}`,
      readFile: async () => Buffer.from('new'),
    });
    expect(rows.map((r) => [r.index, r.label, r.status, r.decision])).toEqual([
      [0, 'a.png', 'modified', 'pending'],
      [1, 'b.png', 'added', 'pending'],
      [2, 'c.png', 'deleted', 'pending'],
      [3, 'ledger.json', 'modified', 'pending'],
    ]);
    const [a, b, c, ledger] = rows;
    expect(a!.oldSrc).toMatch(/^vsc:.*\/[0-9a-f]{64}\.png$/);
    expect(a!.newSrc).toMatch(/^vsc:.*\/[0-9a-f]{64}\.png$/); // copied into storage, not a worktree path
    expect(b!.oldSrc).toBeNull();
    expect(b!.newSrc).not.toBeNull();
    expect(c!.oldSrc).not.toBeNull();
    expect(c!.newSrc).toBeNull();
    expect([ledger!.oldSrc, ledger!.newSrc]).toEqual([null, null]);
    const dir = join(root, String(ticketId));
    const files = readdirSync(dir);
    // old bytes (a, c) and new bytes (a, b) — two content-addressed files, none in a worktree.
    expect(files).toHaveLength(2);
    expect(files.map((f) => readFileSync(join(dir, f), 'utf8')).sort()).toEqual(['new', 'old-image-bytes']);
  });

  // The images are a CACHE (@arch:BASELINE-REVIEW): a parked ticket's rows
  // re-materialize the old image from git on the next render, so removing the
  // folder at archive/delete time never leaves the overlay blank.
  it('re-creates the old image on the next render after the cache folder was removed', async () => {
    // Production shape: `<globalStorage>/baseline-review` is the loader's
    // `storageRoot`, and the sweep/delete take `<globalStorage>` itself.
    const storage = mkdtempSync(join(tmpdir(), 'karst-br-restore-'));
    try {
      const cacheRoot = join(storage, 'baseline-review');
      const load = () =>
        loadBaselineRows({
          store, manifest: m, git, gitBytes, ticketId, storageRoot: cacheRoot, toUri: (p) => p,
          readFile: async () => Buffer.from('new'),
        });
      const first = await load();
      const dir = join(cacheRoot, String(ticketId));
      expect(readdirSync(dir)).toHaveLength(2);

      removeBaselineReviewDir(storage, ticketId);
      expect(existsSync(dir)).toBe(false);

      const again = await load();
      expect(again).toEqual(first);
      expect(again.find((r) => r.label === 'a.png')!.oldSrc).toMatch(/[0-9a-f]{64}\.png$/);
      expect(readdirSync(dir)).toHaveLength(2);
    } finally {
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it('reflects recorded decisions, with the rejection reason', async () => {
    const sha = createHash('sha256').update('new').digest('hex');
    recordBaselineDecisions(store, ticketId, [
      { repo: '/repo', path: 'tests/visual/__baselines__/a.png', sha256: sha, decision: 'approved', reason: null },
      { repo: '/repo', path: 'tests/visual/__baselines__/b.png', sha256: sha, decision: 'rejected', reason: 'wrong colour' },
    ], '2026-01-01T00:00:00Z');
    const rows = await loadBaselineRows({
      store, manifest: m, git, gitBytes, ticketId, storageRoot: root, toUri: (p) => p,
      readFile: async () => Buffer.from('new'),
    });
    expect(rows.map((r) => [r.decision, r.reason])).toEqual([
      ['approved', null],
      ['rejected', 'wrong colour'],
      ['pending', null],
      ['pending', null],
    ]);
  });

  describe('priorRejection', () => {
    const sha = createHash('sha256').update('new').digest('hex');
    const load = () =>
      loadBaselineRows({
        store, manifest: m, git, gitBytes, ticketId, storageRoot: root, toUri: (p) => p,
        readFile: async () => Buffer.from('new'),
      });
    const rejectA = (atSha: string, reason: string | null): void => {
      recordBaselineDecisions(store, ticketId, [
        { repo: '/repo', path: 'tests/visual/__baselines__/a.png', sha256: atSha, decision: 'rejected', reason },
      ], '2026-01-01T00:00:00Z');
    };

    it('marks a pending entry whose latest rejection is at an older sha, with the old reason', async () => {
      rejectA('older-sha', 'button is clipped');
      const [a] = await load();
      expect(a).toMatchObject({ decision: 'pending', priorRejection: 'button is clipped' });
    });

    it('does not mark a rejection at the current sha: the entry is rejected, not pending', async () => {
      rejectA(sha, 'button is clipped');
      const [a] = await load();
      expect(a).toMatchObject({ decision: 'rejected', priorRejection: null });
    });

    it('does not mark an approval at an older sha', async () => {
      recordBaselineDecisions(store, ticketId, [
        { repo: '/repo', path: 'tests/visual/__baselines__/a.png', sha256: 'older-sha', decision: 'approved', reason: null },
      ], '2026-01-01T00:00:00Z');
      const [a] = await load();
      expect(a).toMatchObject({ decision: 'pending', priorRejection: null });
    });

    it('uses the empty string for an earlier rejection with no reason', async () => {
      rejectA('older-sha', null);
      const [a] = await load();
      expect(a).toMatchObject({ decision: 'pending', priorRejection: '' });
    });
  });

  it('keeps the field out of the uat-report artifact list, which stays a read list', async () => {
    recordBaselineDecisions(store, ticketId, [
      { repo: '/repo', path: 'tests/visual/__baselines__/a.png', sha256: 'older-sha', decision: 'rejected', reason: 'clipped' },
    ], '2026-01-01T00:00:00Z');
    const rows = await loadBaselineRows({
      store, manifest: m, git, gitBytes, ticketId, storageRoot: root, toUri: (p) => p,
      readFile: async () => Buffer.from('new'),
    });
    const state = withBaselines({ artifacts: [{ id: 'uat-report' }, { id: 'plan' }] }, rows);
    const report = state.artifacts.find((a) => a.id === 'uat-report') as unknown as { baselines?: Array<Record<string, unknown>> };
    expect(report.baselines).toHaveLength(4);
    for (const item of report.baselines ?? []) expect(Object.keys(item)).not.toContain('priorRejection');
    expect(Object.keys(report.baselines?.[0] ?? {}).sort()).toEqual(['decision', 'path', 'reason', 'status']);
  });
});
