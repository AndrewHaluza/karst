import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_SBX_PROCESS } from '../../agent/sbx/sbxProcess.js';
import { removeTempDir } from '../../runtime/fixtures.js';
import { classifyDivergence, nodeGit } from './sandboxRewrite.js';
import { carryCommits } from './sandboxCarry.js';
import { carrySandboxOp } from './sandboxCarryOp.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

/** A host repo whose ticket branch the "sandbox" (a plain clone) then extends, and the host then rebases. */
function scenario(root: string) {
  const host = join(root, 'host');
  execFileSync('git', ['init', '-q', '-b', 'main', host]);
  writeFileSync(join(host, 'a.txt'), 'a\n');
  git(host, 'add', '.'); git(host, 'commit', '-qm', 'base');
  git(host, 'checkout', '-qb', 'feat');
  writeFileSync(join(host, 'f.txt'), 'f\n');
  git(host, 'add', '.'); git(host, 'commit', '-qm', 'host feat');
  const recorded = git(host, 'rev-parse', 'HEAD');
  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '-q', '--branch', 'feat', host, clone]);
  writeFileSync(join(clone, 'agent.txt'), 'agent\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'agent one');
  writeFileSync(join(clone, 'agent2.txt'), 'agent2\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'agent two');
  // The host moves main on, then rebases feat onto it.
  git(host, 'checkout', '-q', 'main');
  writeFileSync(join(host, 'm.txt'), 'm\n');
  git(host, 'add', '.'); git(host, 'commit', '-qm', 'main moves');
  git(host, 'checkout', '-q', 'feat');
  git(host, 'rebase', '-q', 'main');
  // What the runner's fetch leaves behind.
  git(host, 'fetch', '-q', '--no-write-fetch-head', clone, '+refs/heads/feat:refs/karst/sandbox/feat');
  return { host, clone, recorded, cloneHead: git(clone, 'rev-parse', 'HEAD') };
}

describe('rewrite classification and carry (real git)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-rw-'));
    vi.stubEnv('GIT_COMMITTER_NAME', 't'); vi.stubEnv('GIT_COMMITTER_EMAIL', 't@t');
  });
  afterEach(() => { vi.unstubAllEnvs(); removeTempDir(root); });
  const run = nodeGit(NODE_SBX_PROCESS);

  it('rewritten: the recorded head is in the clone and not in the rebased host branch', async () => {
    const s = scenario(root);
    const out = await classifyDivergence(run, { worktree: s.host, branch: 'feat', recorded: s.recorded });
    expect(out).toEqual({ kind: 'rewritten', recorded: s.recorded, cloneHead: s.cloneHead });
  });

  it('an unrelated fetch that truncates FETCH_HEAD does not change the verdict', async () => {
    const s = scenario(root);
    git(s.host, 'fetch', '-q', s.clone, 'refs/heads/feat'); // rewrites the shared FETCH_HEAD
    const out = await classifyDivergence(run, { worktree: s.host, branch: 'feat', recorded: s.recorded });
    expect(out).toEqual({ kind: 'rewritten', recorded: s.recorded, cloneHead: s.cloneHead });
  });

  it('true divergence: the host has its own new commit on the recorded head', async () => {
    const s = scenario(root);
    git(s.host, 'reset', '-q', '--hard', s.recorded);
    writeFileSync(join(s.host, 'own.txt'), 'x\n');
    git(s.host, 'add', '.'); git(s.host, 'commit', '-qm', 'host own');
    const out = await classifyDivergence(run, { worktree: s.host, branch: 'feat', recorded: s.recorded });
    expect(out).toEqual({ kind: 'diverged' });
  });

  it('no record: finds the old head in the host reflog', async () => {
    const s = scenario(root);
    const out = await classifyDivergence(run, { worktree: s.host, branch: 'feat', recorded: undefined });
    expect(out).toEqual({ kind: 'rewritten', recorded: s.recorded, cloneHead: s.cloneHead });
  });

  it('no record and no usable reflog: true divergence, never guessed', async () => {
    const s = scenario(root);
    git(s.host, 'reflog', 'expire', '--expire=now', '--all');
    const out = await classifyDivergence(run, { worktree: s.host, branch: 'feat', recorded: undefined });
    expect(out).toEqual({ kind: 'diverged' });
  });

  it('carries the sandbox commits onto the rebased host branch with a clean apply', async () => {
    const s = scenario(root);
    const out = await carryCommits(run, { worktree: s.host, recorded: s.recorded, cloneHead: s.cloneHead, scratch: root });
    expect(out).toEqual({ ok: true, carried: 2 });
    expect(git(s.host, 'log', '--format=%s', '-3')).toBe('agent two\nagent one\nhost feat');
    expect(existsSync(join(s.host, 'm.txt'))).toBe(true);
    expect(git(s.host, 'status', '--porcelain')).toBe('');
  });

  it('a conflict stops, lists the paths and leaves the am state for the user', async () => {
    const s = scenario(root);
    writeFileSync(join(s.host, 'agent.txt'), 'host wrote the same file\n');
    git(s.host, 'add', '.'); git(s.host, 'commit', '-qm', 'host collides');
    const out = await carryCommits(run, { worktree: s.host, recorded: s.recorded, cloneHead: s.cloneHead, scratch: root });
    expect(out).toEqual({ ok: false, reason: 'conflict', paths: ['agent.txt'] });
    expect(existsSync(join(s.host, '.git')) ? git(s.host, 'rev-parse', '--git-path', 'rebase-apply') : '').toBeTruthy();
    expect(existsSync(join(git(s.host, 'rev-parse', '--absolute-git-dir'), 'rebase-apply'))).toBe(true);
  });

  it('refuses a dirty host worktree without starting an am', async () => {
    const s = scenario(root);
    writeFileSync(join(s.host, 'wip.txt'), 'wip\n');
    git(s.host, 'add', 'wip.txt');
    const out = await carryCommits(run, { worktree: s.host, recorded: s.recorded, cloneHead: s.cloneHead, scratch: root });
    expect(out).toMatchObject({ ok: false, reason: 'dirty' });
    expect(existsSync(join(git(s.host, 'rev-parse', '--absolute-git-dir'), 'rebase-apply'))).toBe(false);
  });
  it('carry op: recreates the clone without the pre-remove sync, then the next sync fast-forwards', async () => {
    const s = scenario(root);
    let clone = s.clone;
    const runner = { fetchClone: async () => { git(s.host, 'fetch', '-q', '--no-write-fetch-head', clone, '+refs/heads/feat:refs/karst/sandbox/feat'); return { ok: true as const }; } } as unknown as SessionRunner;
    const errors: string[] = [];
    const reopen = vi.fn(async () => {
      // The recreated clone starts from the carried host branch.
      clone = join(root, 'clone2');
      execFileSync('git', ['clone', '-q', '--branch', 'feat', s.host, clone]);
    });
    const remove = vi.fn(async () => true);
    const deps = {
      notify: { info: vi.fn(), warn: vi.fn(), error: (m: string) => { errors.push(m); return Promise.resolve(); } },
      projectRoot: root, choose: vi.fn(), owns: () => true, openSyncDiff: vi.fn(), reopen, remove, runner, scratch: root,
    };
    const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: s.host, branch: 'feat' } };
    await expect(carrySandboxOp(deps, target)).resolves.toBe(true);
    expect(errors).toEqual([]);
    expect(remove).toHaveBeenCalledWith(deps, target, { skipSync: true });
    expect(reopen).toHaveBeenCalledWith(7);
    writeFileSync(join(clone, 'later.txt'), 'later\n');
    git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'agent three');
    git(s.host, 'fetch', '-q', '--no-write-fetch-head', clone, '+refs/heads/feat:refs/karst/sandbox/feat');
    git(s.host, 'merge', '--ff-only', 'refs/karst/sandbox/feat');
    expect(git(s.host, 'log', '--format=%s', '-1')).toBe('agent three');
  });

  it('carry op: commits the agent made after the fetch keep the sandbox (no remove, no reopen)', async () => {
    const s = scenario(root);
    let n = 0;
    const runner = { fetchClone: async () => {
      if (n++ === 1) { writeFileSync(join(s.clone, 'late.txt'), 'late\n'); git(s.clone, 'add', '.'); git(s.clone, 'commit', '-qm', 'late'); }
      git(s.host, 'fetch', '-q', '--no-write-fetch-head', s.clone, '+refs/heads/feat:refs/karst/sandbox/feat');
      return { ok: true as const };
    } } as unknown as SessionRunner;
    const errors: string[] = [];
    const remove = vi.fn(async () => true);
    const reopen = vi.fn(async () => {});
    const deps = {
      notify: { info: vi.fn(), warn: vi.fn(), error: (m: string) => { errors.push(m); return Promise.resolve(); } },
      projectRoot: root, choose: vi.fn(), owns: () => true, openSyncDiff: vi.fn(), reopen, remove, runner, scratch: root,
    };
    await expect(carrySandboxOp(deps, { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: s.host, branch: 'feat' } })).resolves.toBe(false);
    expect(errors).toEqual([expect.stringContaining('newer commits')]);
    expect(remove).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });

  it('carry op: a conflict keeps the sandbox (no remove, no reopen) and names the paths', async () => {
    const s = scenario(root);
    writeFileSync(join(s.host, 'agent.txt'), 'host wrote the same file\n');
    git(s.host, 'add', '.'); git(s.host, 'commit', '-qm', 'host collides');
    const runner = { fetchClone: async () => ({ ok: true as const }) } as unknown as SessionRunner;
    const errors: string[] = [];
    const remove = vi.fn(async () => true);
    const reopen = vi.fn(async () => {});
    const deps = {
      notify: { info: vi.fn(), warn: vi.fn(), error: (m: string) => { errors.push(m); return Promise.resolve(); } },
      projectRoot: root, choose: vi.fn(), owns: () => true, openSyncDiff: vi.fn(), reopen, remove, runner, scratch: root,
    };
    await expect(carrySandboxOp(deps, { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: s.host, branch: 'feat' } })).resolves.toBe(false);
    expect(errors).toEqual([expect.stringContaining('conflicts in agent.txt')]);
    expect(remove).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });
});
