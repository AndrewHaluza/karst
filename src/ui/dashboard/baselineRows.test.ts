import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { manifest, uat as uatConfig } from '../../manifest/fixtures.js';
import { recordBaselineDecisions } from '../../store/baselineDecisions.js';
import type { GitBytesRunner, GitRunner } from '../../integrations/git.js';
import { baselineLabel, isImagePath, loadBaselineRows } from './baselineRows.js';

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

  it('reflects recorded decisions, with the rejection reason', async () => {
    const sha = (await import('node:crypto')).createHash('sha256').update('new').digest('hex');
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
});
