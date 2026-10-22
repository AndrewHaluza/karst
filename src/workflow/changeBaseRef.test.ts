import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, setAgentState } from '../store/tickets.js';
import { manifest, stack } from '../manifest/fixtures.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import type { GitRunner } from '../integrations/git.js';
import { changeBaseRef, describeChangeBaseRef } from './changeBaseRef.js';

function fixtureManifest() {
  return manifest(stack());
}

function seed(baseRef = 'develop') {
  const store = openStore(':memory:');
  const m = fixtureManifest();
  const repoPath = m.repositories.backend!.repoPath;
  const ticket = createTicket(store, { key: 'C-1', title: 't' });
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, '/wt', 'karst/feat/c-1', ?, 'inherited')`,
    )
    .run(ticket.id, repoPath, baseRef);
  return { store, manifest: m, ticketId: ticket.id, repoPath };
}

const cleanGit: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });

describe('changeBaseRef', () => {
  it('rebases, then stores the new base', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    const r = await changeBaseRef({
      store,
      manifest: m,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      git: cleanGit,
    });
    expect(r.ok).toBe(true);
    expect(r.fromBase).toBe('develop');
    expect(r.rebase!.outcome).toBe('rebased');
    const row = store.db
      .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
      .get(ticketId, repoPath) as { base_ref: string };
    expect(row.base_ref).toBe('epic/checkout');
  });

  it('does NOT store the new base when the rebase conflicts', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    const git: GitRunner = async (args) =>
      args[0] === 'rebase' && args[1] !== '--abort'
        ? { stdout: '', stderr: 'CONFLICT (content): Merge conflict in a.ts', exitCode: 1 }
        : { stdout: '', stderr: '', exitCode: 0 };

    const r = await changeBaseRef({
      store,
      manifest: m,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      git,
    });
    expect(r.ok).toBe(false);
    expect(r.rebase!.outcome).toBe('conflict');
    const row = store.db
      .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
      .get(ticketId, repoPath) as { base_ref: string };
    expect(row.base_ref).toBe('develop');
  });

  it('stores the new base without rebasing when rebase is off', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const r = await changeBaseRef({
      store,
      manifest: m,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      rebase: false,
      git,
    });
    expect(r.ok).toBe(true);
    expect(r.rebase).toBeNull();
    expect(calls.some((a) => a[0] === 'rebase')).toBe(false);
  });

  it('re-targets an open PR and reports gh’s refusal without failing the change', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status)
         VALUES (?, ?, 7, 'https://example/7', 'open')`,
      )
      .run(ticketId, repoPath);
    const gh = async () => ({ stdout: '', stderr: 'no write access', exitCode: 1 });
    const r = await changeBaseRef({
      store,
      manifest: m,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      git: cleanGit,
      gh,
    });
    expect(r.ok).toBe(true);
    expect(r.prRetarget).toEqual({ ok: false, reason: 'no write access', number: 7 });
  });

  it('clears the now-stale merge check', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    setMergeCheck(store, {
      ticketId,
      repo: repoPath,
      state: 'clean',
      files: [],
      reason: null,
      headSha: 'aaa1111',
      baseSha: 'bbb2222',
      baseRef: 'develop',
      checkedAt: '2026-07-21T10:00:00.000Z',
    });
    const before = store.db
      .prepare('SELECT COUNT(*) as n FROM merge_checks WHERE ticket_id = ? AND repo = ?')
      .get(ticketId, repoPath) as { n: number };
    expect(before.n).toBe(1);

    const r = await changeBaseRef({
      store,
      manifest: m,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      git: cleanGit,
    });
    expect(r.ok).toBe(true);

    const after = store.db
      .prepare('SELECT COUNT(*) as n FROM merge_checks WHERE ticket_id = ? AND repo = ?')
      .get(ticketId, repoPath) as { n: number };
    expect(after.n).toBe(0);
  });

  it('arms the force push when — and only when — the branch was rewritten', async () => {
    const armed = async (rebase: boolean) => {
      const { store, manifest: m, ticketId, repoPath } = seed();
      await changeBaseRef({
        store,
        manifest: m,
        ticketId,
        repoPath,
        toBase: 'epic/checkout',
        rebase,
        git: cleanGit,
      });
      const row = store.db
        .prepare('SELECT needs_force_push FROM worktrees WHERE ticket_id = ? AND repo = ?')
        .get(ticketId, repoPath) as { needs_force_push: number | null };
      return row.needs_force_push;
    };
    expect(await armed(true)).toBe(1);
    // Re-targeting alone rewrites nothing — an ordinary push still fast-forwards.
    expect(await armed(false)).toBeFalsy();
  });

  // A crash between two separate UPDATEs would leave the branch moved (git
  // already rebased) with the rewrite unrecorded — the next push then gets
  // rejected as a non-fast-forward with no `needs_force_push` flag to explain
  // why. Both columns must land in ONE statement.
  it('writes base_ref and needs_force_push in a single UPDATE statement', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    const realPrepare = store.db.prepare.bind(store.db);
    const worktreeUpdates: string[] = [];
    (store.db as { prepare: typeof store.db.prepare }).prepare = ((sql: string) => {
      if (/UPDATE\s+worktrees\s+SET/i.test(sql)) worktreeUpdates.push(sql);
      return realPrepare(sql);
    }) as typeof store.db.prepare;

    await changeBaseRef({
      store,
      manifest: m,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      git: cleanGit,
    });

    (store.db as { prepare: typeof store.db.prepare }).prepare = realPrepare;

    expect(worktreeUpdates).toHaveLength(1);
    expect(worktreeUpdates[0]).toMatch(/base_ref/);
    expect(worktreeUpdates[0]).toMatch(/needs_force_push/);
  });
});

describe('changeBaseRef — same base', () => {
  function gitWithHeads(before: string, after: string): GitRunner {
    let rebased = false;
    return async (args) => {
      if (args[0] === 'rebase') rebased = true;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: rebased ? after : before, stderr: '', exitCode: 0 };
      }
      return { stdout: args[0] === 'status' ? '' : 'abc', stderr: '', exitCode: 0 };
    };
  }

  it('rebases onto the latest base and arms the force push', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    let recreated = 0;
    const r = await changeBaseRef({
      store, manifest: m, ticketId, repoPath, toBase: 'develop',
      git: gitWithHeads('h1', 'h2'),
      afterRewrite: async () => { recreated++; },
    });
    expect(r.ok).toBe(true);
    expect(r.rebase!.outcome).toBe('rebased');
    expect(r.prRetarget).toBeNull();
    expect(recreated).toBe(1);
    expect(describeChangeBaseRef(r)).toBe('Rebased onto the latest develop.');
    const row = store.db
      .prepare('SELECT base_ref, needs_force_push FROM worktrees WHERE ticket_id = ?')
      .get(ticketId) as { base_ref: string; needs_force_push: number };
    expect(row).toEqual({ base_ref: 'develop', needs_force_push: 1 });
  });

  it('still re-targets the PR and words the note when the sandbox recreate fails after a base change', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status)
         VALUES (?, ?, 7, 'https://example/7', 'open')`,
      )
      .run(ticketId, repoPath);
    const gh = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const r = await changeBaseRef({
      store, manifest: m, ticketId, repoPath, toBase: 'epic/checkout',
      git: gitWithHeads('h1', 'h2'), gh,
      afterRewrite: async () => { throw new Error('docker down'); },
    });
    expect(r.ok).toBe(true);
    expect(r.prRetarget).toMatchObject({ ok: true, number: 7 });
    expect(r.reason).toBe('rebased, but recreating the sandbox failed: docker down');
    expect(describeChangeBaseRef(r)).toContain('PR #7 re-targeted.');
    expect(describeChangeBaseRef(r)).toContain('recreating the sandbox failed: docker down.');
  });

  it('reports already up to date when nothing moved', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    let recreated = 0;
    const r = await changeBaseRef({
      store, manifest: m, ticketId, repoPath, toBase: 'develop',
      git: gitWithHeads('h1', 'h1'),
      afterRewrite: async () => { recreated++; },
    });
    expect(r.ok).toBe(true);
    expect(r.rebase!.outcome).toBe('already-based');
    expect(recreated).toBe(0);
    expect(describeChangeBaseRef(r)).toBe('Already up to date with develop.');
  });

  it('says base unchanged when rebase is off', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    const r = await changeBaseRef({
      store, manifest: m, ticketId, repoPath, toBase: 'develop', rebase: false, git: cleanGit,
    });
    expect(r.ok).toBe(true);
    expect(r.rebase).toBeNull();
    expect(describeChangeBaseRef(r)).toBe('Base unchanged (develop).');
  });

  it('refuses while an agent is running', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    setAgentState(store, ticketId, 'running');
    const r = await changeBaseRef({
      store, manifest: m, ticketId, repoPath, toBase: 'develop', git: gitWithHeads('h1', 'h2'),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/agent is working/);
  });

  it('refuses when the sandbox holds unsynced commits', async () => {
    const { store, manifest: m, ticketId, repoPath } = seed();
    const r = await changeBaseRef({
      store, manifest: m, ticketId, repoPath, toBase: 'develop', git: cleanGit,
      sandboxUnsynced: async () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/sandbox has commits/);
  });
});
