// Single-commit snapshot of a task's baseSha, so the agent sees no history, no remote, no tags,
// and so cannot read the upstream fix from `git log`. Layout under the mounted task dir
// (/task in the container, D290):
//   <task>/repo  the snapshot repository (one commit, branch `main`)
//   <task>/wt    a worktree of it, where karst works (its path is relative-linked so the same
//                tree resolves on the host and at /task)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Top-level paths a task checkout must not contain (they would leak eval material). */
export const FORBIDDEN_TOP = ['evals', 'eval-results', 'hidden'];

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@localhost', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

export function git(cwd, args, { input, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, env: { ...process.env, ...GIT_ENV }, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').trim().slice(0, 500)}`);
  return r;
}

/** Paths a unified diff writes to (the `+++ b/<path>` side). */
export function patchFiles(patch) {
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
}

/**
 * Refuses a checkout that is not a clean base: a top-level evals/, eval-results/ or hidden/ path,
 * more than one commit reachable, or the test patch already applied. Pure over a git directory.
 */
export function assertCleanSnapshot(repoDir, testPatch) {
  const top = readdirSync(repoDir).filter((n) => FORBIDDEN_TOP.includes(n));
  if (top.length > 0) throw new Error(`snapshot refused: contains ${top.join(', ')}/`);
  const count = git(repoDir, ['rev-list', '--all', '--count']).stdout.trim();
  if (count !== '1') throw new Error(`snapshot refused: ${count} commits reachable, want exactly 1`);
  if (git(repoDir, ['tag', '-l']).stdout.trim() !== '') throw new Error('snapshot refused: tags present');
  if (git(repoDir, ['remote']).stdout.trim() !== '') throw new Error('snapshot refused: a remote is configured');
  if (testPatch.trim() !== '') {
    // The reverse of the test patch applying means its changes are already in the tree.
    const rev = git(repoDir, ['apply', '--check', '--reverse', '-'], { input: testPatch, allowFail: true });
    if (rev.status === 0) throw new Error('snapshot refused: test patch is already applied in the checkout');
  }
}

/**
 * Builds `<taskDir>/repo` from `repoUrl` at `baseSha`: fetch ONLY that sha, export the tree, re-init
 * as one commit. Returns {repoDir, baseCommit} where baseCommit is the snapshot commit (it is NOT
 * baseSha: the upstream sha is deliberately absent). `fetchTree(dest)` is injectable for tests.
 */
export function buildSnapshot({ taskDir, repoUrl, baseSha, testPatch, fetchTree = fetchTreeFromRemote }) {
  const repoDir = join(taskDir, 'repo');
  if (existsSync(repoDir)) throw new Error(`snapshot: ${repoDir} already exists`);
  mkdirSync(repoDir, { recursive: true });
  fetchTree({ repoUrl, baseSha, dest: repoDir });
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.name', 'eval']);
  git(repoDir, ['config', 'user.email', 'eval@localhost']);
  writeFileSync(join(repoDir, '.git', 'info', 'exclude'), 'node_modules/\n/.eval-wt/\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'task snapshot']);
  assertCleanSnapshot(repoDir, testPatch);
  return { repoDir, baseCommit: git(repoDir, ['rev-parse', 'HEAD']).stdout.trim() };
}

/** Fetch of only `baseSha` (depth 1) into a scratch repo, then `git archive` the tree into dest. No history is copied. */
function fetchTreeFromRemote({ repoUrl, baseSha, dest }) {
  const scratch = mkdtempSync(join(tmpdir(), 'eval-fetch-'));
  try {
    git(scratch, ['init', '-q']);
    git(scratch, ['fetch', '-q', '--depth', '1', '--no-tags', repoUrl, baseSha]);
    const archive = spawnSync('git', ['archive', '--format=tar', 'FETCH_HEAD'], { cwd: scratch, maxBuffer: 1024 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(`git archive failed: ${String(archive.stderr).slice(0, 300)}`);
    const x = spawnSync('tar', ['-x', '-C', dest], { input: archive.stdout });
    if (x.status !== 0) throw new Error(`tar extract failed: ${String(x.stderr).slice(0, 300)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Test helper / local-source variant: copy a directory tree as the base tree. */
export const copyTreeFetcher = (srcDir) => ({ dest }) => cpSync(srcDir, dest, { recursive: true });

/** `<taskDir>/wt`: the worktree karst works in. Relative links keep it valid at /task in the container. */
export function addWorktree({ taskDir }) {
  const repoDir = join(taskDir, 'repo');
  const wt = join(taskDir, 'wt');
  git(repoDir, ['-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '--relative-paths', '-q', '-b', 'eval/task', wt]);
  return wt;
}

/**
 * The agent's patch: everything in the worktree vs the snapshot commit, uncommitted and new files
 * included (`add -A` into the index first; node_modules is excluded via info/exclude).
 */
export function worktreePatch(wt, baseCommit) {
  git(wt, ['add', '-A']);
  return git(wt, ['diff', '--cached', '--binary', baseCommit]).stdout;
}
