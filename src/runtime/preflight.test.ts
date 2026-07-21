import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest, RepositoryDef } from '../manifest/types.js';
import {
  manifest as buildManifest,
  repo as bareRepo,
  runnableRepo,
} from '../manifest/fixtures.js';
import { preflightSpin, SpinError } from './preflight.js';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A real git repo on `branch` with one commit. */
function makeRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-pf-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function svc(repoPath: string): RepositoryDef {
  return runnableRepo({ start: 'node server.mjs' }, { repoPath });
}

function manifest(baselineBranch: string, repos: Record<string, RepositoryDef>): Manifest {
  return buildManifest(repos, {
    host: '127.0.0.1',
    portRange: [4000, 4100],
    baselineBranch,
  });
}

describe('preflightSpin', () => {
  const dirs: string[] = [];
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'karst-pf-'));
    dirs.push(d);
    return d;
  };
  const repo = (branch: string): string => {
    const d = makeRepo(branch);
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('passes when every hot repo is a git repo containing the baseline branch', () => {
    const r = repo('develop');
    expect(() =>
      preflightSpin(manifest('develop', { frontend: svc(r) }), '1-frontend', ['frontend']),
    ).not.toThrow();
  });

  it('names the repository, not a service, when it is missing from the manifest', () => {
    expect(() => preflightSpin(manifest('develop', {}), '1-x', ['ghost'])).toThrow(
      /repository 'ghost' is not in the manifest/,
    );
  });

  it('throws SpinError naming the branch + repo when the baseline branch is missing', () => {
    const r = repo('main'); // only main exists
    try {
      preflightSpin(manifest('develop', { frontend: svc(r) }), '1-frontend', ['frontend']);
      throw new Error('expected preflightSpin to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpinError);
      const msg = (err as SpinError).message;
      expect(msg).toContain('develop');
      expect(msg).toContain(r);
    }
  });

  it('throws SpinError "not a git repository" for a non-git directory', () => {
    const d = scratch(); // plain dir, no git init
    try {
      preflightSpin(manifest('develop', { frontend: svc(d) }), '1-frontend', ['frontend']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpinError);
      expect((err as SpinError).message).toContain('not a git repository');
    }
  });

  it('throws (no unhandled error) for a nonexistent repoPath', () => {
    const missing = join(tmpdir(), 'karst-pf-does-not-exist-xyz');
    expect(() =>
      preflightSpin(manifest('develop', { frontend: svc(missing) }), '1-frontend', ['frontend']),
    ).toThrow(SpinError);
  });

  // Two DISTINCT repositories are each checked once — no cross-repo dedup here.
  it('reports each hot repository once', () => {
    const a = repo('main'); // missing develop
    const b = repo('main');
    try {
      preflightSpin(manifest('develop', { api: svc(a), web: svc(b) }), '1-shared', ['api', 'web']);
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as SpinError).message;
      expect(msg.split(a).length - 1).toBe(1);
      expect(msg.split(b).length - 1).toBe(1);
    }
  });

  // Two repository ENTRIES sharing one repoPath (a monorepo with two runnable
  // processes) are checked once, not once per entry — otherwise the same
  // problem is reported twice for what is physically one repository. Restores
  // the dedup 53314d6 added and b7f223d wrongly deleted (it deleted the dedup
  // AND the validation that made shared repoPaths reachable at all — see
  // manifest/validate/graph.ts).
  it('dedupes a repo backing multiple hot repository entries — one problem line, not two', () => {
    const r = repo('main'); // missing develop
    try {
      preflightSpin(manifest('develop', { api: svc(r), web: svc(r) }), '1-shared', ['api', 'web']);
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as SpinError).message;
      // the repo path appears once, not once per repository entry
      expect(msg.split(r).length - 1).toBe(1);
    }
  });

  // The target-check loop (worktree path/branch) dedups the same way: one
  // slug per ticket means two entries sharing a repoPath map to the same
  // worktree path and branch, which is the intended outcome, not a collision.
  it('dedupes the target check for two hot repository entries in one repo (one slug per ticket)', () => {
    const r = repo('develop');
    // Our own worktree at the shared slug path — created once for the repo.
    // With per-entry slugs this would false-flag the second entry; deduped it
    // must pass.
    const ownWt = join(r, '.karst', 'worktrees', '1-shared');
    git(r, 'worktree', 'add', '-q', '-b', 'karst/1-shared', ownWt, 'develop');
    expect(() =>
      preflightSpin(manifest('develop', { api: svc(r), web: svc(r) }), '1-shared', ['api', 'web']),
    ).not.toThrow();
  });

  // A repository with no service still gets a worktree, so its git preconditions
  // matter exactly as much as a runnable one's.
  it('checks a repository that declares no service', () => {
    const r = repo('main'); // missing develop
    const m = manifest('develop', { docs: bareRepo({ repoPath: r }) });
    expect(() => preflightSpin(m, '1-docs', ['docs'])).toThrow(SpinError);
  });

  it('passes a non-runnable repository whose git preconditions are met', () => {
    const r = repo('develop');
    const m = manifest('develop', { docs: bareRepo({ repoPath: r }) });
    expect(() => preflightSpin(m, '1-docs', ['docs'])).not.toThrow();
  });

  it('passes when the target branch exists but is free (recoverable — attach)', () => {
    const r = repo('develop');
    // Plant a leftover branch off develop with no worktree bound to it.
    git(r, 'branch', 'karst/1-frontend', 'develop');
    expect(() =>
      preflightSpin(manifest('develop', { frontend: svc(r) }), '1-frontend', ['frontend']),
    ).not.toThrow();
  });

  it('passes when the target worktree already belongs to this ticket (resumable spin)', () => {
    const r = repo('develop');
    // Our own worktree at the exact target path on our branch — an adoptable retry.
    const ownWt = join(r, '.karst', 'worktrees', '1-frontend');
    git(r, 'worktree', 'add', '-q', '-b', 'karst/1-frontend', ownWt, 'develop');
    expect(() =>
      preflightSpin(manifest('develop', { frontend: svc(r) }), '1-frontend', ['frontend']),
    ).not.toThrow();
  });

  it('throws SpinError when the target branch is checked out by another worktree', () => {
    const r = repo('develop');
    const otherWt = join(r, '.karst', 'worktrees', 'elsewhere');
    git(r, 'worktree', 'add', '-q', '-b', 'karst/1-frontend', otherWt, 'develop');
    try {
      preflightSpin(manifest('develop', { frontend: svc(r) }), '1-frontend', ['frontend']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpinError);
      const msg = (err as SpinError).message;
      expect(msg).toContain('karst/1-frontend');
      expect(msg).toContain(r);
    }
  });

  it('adopts this ticket\'s own worktree across several hot repositories', () => {
    const a = repo('develop');
    const b = repo('develop');
    // One slug per ticket, so each repo has its own worktree at the same slug —
    // both already ours, so this is a resumable spin, not a collision.
    for (const r of [a, b]) {
      git(r, 'worktree', 'add', '-q', '-b', 'karst/1-shared',
          join(r, '.karst', 'worktrees', '1-shared'), 'develop');
    }
    expect(() =>
      preflightSpin(manifest('develop', { api: svc(a), web: svc(b) }), '1-shared', ['api', 'web']),
    ).not.toThrow();
  });

  it('throws SpinError when the target worktree path already exists', () => {
    const r = repo('develop');
    // Occupy the exact target path with a stray dir (no branch involved).
    mkdirSync(join(r, '.karst', 'worktrees', '1-frontend'), { recursive: true });
    try {
      preflightSpin(manifest('develop', { frontend: svc(r) }), '1-frontend', ['frontend']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpinError);
      expect((err as SpinError).message).toContain('already exists');
    }
  });
});
