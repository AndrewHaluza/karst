import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupQuarantine,
  commitAllIfDirty,
  compareAndSwapHeadAndIndex,
  describeGitFailure,
  hasChangesFrom,
  headCommit,
  listCommitsFrom,
  prepareCommitInQuarantine,
  promoteQuarantinedObjects,
  pushBranch,
  remoteRefSha,
  runGit,
  runGitEnv,
  workingTreeSummary,
  defaultGitRunner,
  runGitBytes,
  GIT_PUSH_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  type GitRunner,
  type GitRunOptions,
} from './git.js';
import { MAX_DIAGNOSTIC_CHARS } from '../model/diagnosticText.js';

/**
 * A git alias that spawns a node grandchild and records its pid to a file.
 *
 * The FILE, not stdout, is what the tests read: the tree gets killed mid-run,
 * and a kill that lands between the two halves of a stdout write leaves a
 * truncated number that still parses — a valid pid for some other process.
 * Stdout is unreadable anyway until the run has SETTLED, i.e. after the kill
 * already happened. The write is via rename so a reader can never observe half
 * of it.
 *
 * Both process-tree tests need the grandchild DEMONSTRABLY alive before the
 * thing under test (a timeout, an abort) fires, or they race the spawn chain
 * (git → shell alias → node → node). A fixed `setTimeout` stood in for "the
 * tree is up", and on a loaded machine — the gate runs 254 files at once — the
 * chain took longer, so the pid came back NaN. That fails one test and passes
 * the sibling VACUOUSLY: `process.kill(NaN, 0)` throws, which
 * `expectProcessDead` reads as "already dead". The wait below is bounded and
 * its expiry is a failure, never a silent skip.
 */
function hangTreeAlias(pidFile: string): string[] {
  const script =
    `const{spawn}=require('node:child_process');` +
    `const fs=require('node:fs');` +
    `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);` +
    `fs.writeFileSync('${pidFile}.tmp',String(c.pid));` +
    `fs.renameSync('${pidFile}.tmp','${pidFile}');` +
    `setInterval(()=>{},1000)`;
  return ['-c', `alias.hangtree=!${process.execPath} -e "${script}"`, 'hangtree'];
}

/** Resolves once the grandchild has recorded its pid — spawning is not instant. */
async function readPidWhenWritten(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isInteger(pid)) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`grandchild never recorded a pid at ${pidFile}`);
}

/** Leaves no stray `node -e setInterval` behind when an assertion fails early. */
function reapGrandchild(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

async function expectProcessDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

/** Runner whose reply is keyed by the git subcommand; succeeds silently otherwise. */
function scriptedGit(
  replies: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>,
): { git: GitRunner; seen: { args: string[]; cwd: string }[] } {
  const seen: { args: string[]; cwd: string }[] = [];
  const git: GitRunner = async (args, cwd) => {
    seen.push({ args, cwd });
    const r = replies[args[0]!] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { git, seen };
}

describe('commitAllIfDirty', () => {
  it('stages and commits everything when the worktree is dirty', async () => {
    const { git, seen } = scriptedGit({ status: { stdout: ' M src/a.ts\n?? src/b.ts\n' } });
    const committed = await commitAllIfDirty(git, '/wt/fe', 'chore: add search');
    expect(committed).toBe(true);
    expect(seen.map((s) => s.args)).toEqual([
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'chore: add search'],
    ]);
    for (const s of seen) expect(s.cwd).toBe('/wt/fe');
  });

  it('does nothing when the worktree is clean', async () => {
    const { git, seen } = scriptedGit({ status: { stdout: '' } });
    expect(await commitAllIfDirty(git, '/wt/fe', 'chore: add search')).toBe(false);
    expect(seen.map((s) => s.args)).toEqual([['status', '--porcelain']]);
  });

  it('throws with git’s own reason when status fails', async () => {
    const { git } = scriptedGit({ status: { stderr: 'fatal: not a git repository', exitCode: 128 } });
    await expect(commitAllIfDirty(git, '/wt/fe', 'm')).rejects.toThrow(
      /git status failed in \/wt\/fe: fatal: not a git repository/,
    );
  });

  it('throws when the commit itself fails', async () => {
    const { git } = scriptedGit({
      status: { stdout: ' M a\n' },
      commit: { stderr: 'error: gpg failed to sign the data', exitCode: 1 },
    });
    await expect(commitAllIfDirty(git, '/wt/fe', 'm')).rejects.toThrow(
      /git commit failed in \/wt\/fe: error: gpg failed to sign the data/,
    );
  });

  it('throws when staging fails', async () => {
    const { git } = scriptedGit({
      status: { stdout: ' M a\n' },
      add: { stderr: 'fatal: pathspec did not match', exitCode: 128 },
    });
    await expect(commitAllIfDirty(git, '/wt/fe', 'm')).rejects.toThrow(/git add failed in \/wt\/fe/);
  });
});

describe('hasChangesFrom', () => {
  /** A runner keyed by verb, with `fetch` keyed by the ref it is fetching. */
  function runner(
    replies: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>,
  ): { git: GitRunner; seen: string[][] } {
    const seen: string[][] = [];
    const git: GitRunner = async (args) => {
      seen.push(args);
      const key = args[0] === 'fetch' ? `fetch:${args[2]}` : args[0]!;
      const r = replies[key] ?? {};
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
    };
    return { git, seen };
  }

  it('diffs the remote base against the remote branch when both fetches succeed', async () => {
    const { git, seen } = runner({ diff: { exitCode: 1 } });
    expect(await hasChangesFrom(git, '/wt/fe', 'develop', 'karst/x')).toBe(true);
    expect(seen).toContainEqual(['diff', '--quiet', 'origin/develop...origin/karst/x']);
  });

  // fu1: an unreachable remote is not a verdict. Reading it as "assume changes"
  // ships a branch that carries none — the push then spends its whole timeout on
  // the same unreachable remote. The local base ref answers this offline.
  it('falls back to the LOCAL base ref when the base fetch fails, and answers no changes', async () => {
    const { git, seen } = runner({
      'fetch:develop': { stderr: 'could not resolve host', exitCode: 128 },
      'fetch:karst/x': { stderr: 'could not resolve host', exitCode: 128 },
      'rev-parse': { stdout: 'abc123\n' },
      diff: { exitCode: 0 },
    });
    expect(await hasChangesFrom(git, '/wt/fe', 'develop', 'karst/x')).toBe(false);
    expect(seen).toContainEqual(['diff', '--quiet', 'develop...karst/x']);
  });

  it('still reports changes when the base fetch fails and no local base ref resolves', async () => {
    const { git, seen } = runner({
      'fetch:develop': { exitCode: 128 },
      'rev-parse': { stderr: 'unknown revision', exitCode: 128 },
    });
    expect(await hasChangesFrom(git, '/wt/fe', 'develop', 'karst/x')).toBe(true);
    expect(seen.some((args) => args[0] === 'diff')).toBe(false);
  });
});

describe('describeGitFailure', () => {
  it('names the command, the exit code, and the collapsed stderr', () => {
    const msg = describeGitFailure('git status --porcelain', {
      exitCode: 128,
      stderr: 'fatal: not a git repository',
      stdout: '',
    });
    expect(msg).toBe('git status --porcelain failed (exit 128): fatal: not a git repository');
  });

  it('collapses multi-line prose to one line and caps unbounded stderr', () => {
    const blob = `fatal: line one\nfatal: line two\n${'x'.repeat(10_000)}`;
    const msg = describeGitFailure('git status --porcelain', {
      exitCode: 1,
      stderr: blob,
      stdout: '',
    });
    expect(msg).not.toContain('\n');
    expect(msg.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + 64);
  });

  it('falls back to stdout, and to a plain statement when git said nothing', () => {
    expect(
      describeGitFailure('git status --porcelain', { exitCode: 128, stderr: '', stdout: 'boom' }),
    ).toContain('boom');
    expect(
      describeGitFailure('git status --porcelain', { exitCode: 128, stderr: '', stdout: '' }),
    ).toContain('no output');
  });
});

describe('pushBranch', () => {
  it('publishes HEAD with an upstream, which is what gh reads to find the head branch', async () => {
    const seen: { args: string[]; cwd: string }[] = [];
    const git: GitRunner = async (args, cwd) => {
      seen.push({ args, cwd });
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await pushBranch(git, '/wt/fe');
    expect(seen).toEqual([{ args: ['push', '-u', 'origin', 'HEAD'], cwd: '/wt/fe' }]);
  });

  it('throws with git’s own reason, and says which worktree', async () => {
    const git: GitRunner = async () => ({
      stdout: '',
      stderr: "fatal: 'origin' does not appear to be a git repository",
      exitCode: 128,
    });
    await expect(pushBranch(git, '/wt/fe')).rejects.toThrow(
      /git push failed in \/wt\/fe: fatal: 'origin' does not appear to be a git repository/,
    );
  });

  it('falls back to the exit code when git said nothing at all', async () => {
    const git: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });
    await expect(pushBranch(git, '/wt/fe')).rejects.toThrow(/git exit 1/);
  });

  // Defect 2: the generic 60s timeout (GIT_TIMEOUT_MS) killed a real network
  // push before it finished — production logs showed repeated
  // `git timed out after 60000ms: git push -u origin HEAD` failures. Push is
  // network-bound, unlike local reads, so it gets its own, much longer budget.
  it('runs with the longer push timeout, not the generic 60s one', async () => {
    let seenOptions: GitRunOptions | undefined;
    const git: GitRunner = async (_args, _cwd, options) => {
      seenOptions = options;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await pushBranch(git, '/wt/fe');
    expect(seenOptions?.timeoutMs).toBe(GIT_PUSH_TIMEOUT_MS);
    expect(GIT_PUSH_TIMEOUT_MS).toBeGreaterThan(GIT_TIMEOUT_MS);
  });

  it('pushes ordinarily when no lease is given', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await pushBranch(git, '/wt');
    expect(calls).toEqual([['push', '-u', 'origin', 'HEAD']]);
  });

  it('force-pushes with an explicit lease value, never a bare force', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await pushBranch(git, '/wt', {
      forceWithLease: { ref: 'karst/feat/x', expected: 'abc123' },
    });
    expect(calls).toEqual([
      ['push', '-u', '--force-with-lease=karst/feat/x:abc123', 'origin', 'HEAD'],
    ]);
    expect(calls[0]).not.toContain('--force');
  });

  it('reports a rejected lease as a push failure', async () => {
    const git: GitRunner = async () => ({
      stdout: '',
      stderr: '! [rejected] karst/feat/x -> karst/feat/x (stale info)',
      exitCode: 1,
    });
    await expect(
      pushBranch(git, '/wt', { forceWithLease: { ref: 'karst/feat/x', expected: 'abc123' } }),
    ).rejects.toThrow(/stale info/);
  });
});

describe('defaultGitRunner', () => {
  it('returns git’s stdout and a zero exit for a command that succeeds', async () => {
    const r = await defaultGitRunner(['--version'], process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^git version /);
  });

  it('reports the exit code and stderr rather than throwing, so the caller decides', async () => {
    const r = await defaultGitRunner(['rev-parse', 'definitely-not-a-ref'], process.cwd());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.trim()).not.toBe('');
  });

  it('leaves the event loop free while git runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    // A git command that takes a while — a shell alias that sleeps — so a
    // blocking (spawnSync) runner would starve the interval while the async
    // runner lets it keep ticking. Plain `git log` finishes in a few ms on a
    // warm checkout, which is too fast to observe the free loop on a fast
    // machine (ticks === 0) — the sleep makes the property actually testable.
    const r = await runGit(['-c', 'alias.linger=!sleep 0.3', 'linger'], process.cwd());
    clearInterval(timer);
    expect(r.exitCode).toBe(0);
    expect(ticks).toBeGreaterThan(0);
  });

  it('kills a hung git and answers with a nonzero exit and a timeout reason', async () => {
    const r = await runGit(['-c', 'alias.hang=!sleep 5', 'hang'], process.cwd(), 150);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/timed out/i);
  });

  it.runIf(process.platform !== 'win32')(
    'waits for close and terminates descendants after timeout',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'karst-git-'));
      const pidFile = join(dir, 'pid');
      try {
        // The timeout is the SUBJECT here, so this test cannot wait for the
        // grandchild before arming it — it gets a budget wide enough for the
        // spawn chain instead. At 100ms a loaded machine reaped git before its
        // own child had spawned, and the test failed on an empty pid rather
        // than on the descendant it means to check.
        const r = await runGit(hangTreeAlias(pidFile), process.cwd(), 2000, 1024, 500);

        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain('timed out after 2000ms');
        await expectProcessDead(await readPidWhenWritten(pidFile));
      } finally {
        reapGrandchild(pidFile);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'aborts a detached git process tree and settles with an abort reason',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'karst-git-'));
      const pidFile = join(dir, 'pid');
      try {
        const controller = new AbortController();
        const pending = runGit(
          hangTreeAlias(pidFile),
          process.cwd(),
          10_000,
          1024,
          500,
          controller.signal,
        );

        // Abort once the tree demonstrably EXISTS, never on a fixed delay: the
        // claim is that abort kills a live descendant, and a delay that expires
        // first races the spawn it is supposed to interrupt — it tears down an
        // empty tree while looking like it passed.
        const grandchildPid = await readPidWhenWritten(pidFile);
        controller.abort();

        const result = await pending;
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/aborted/i);
        await expectProcessDead(grandchildPid);
      } finally {
        reapGrandchild(pidFile);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('answers with a reason when git itself cannot be spawned', async () => {
    const r = await runGit(['--version'], '/nonexistent-directory-for-karst-test');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.trim()).not.toBe('');
  });

  it.runIf(process.platform !== 'win32')(
    'bounds stdout and stderr while preserving a successful exit',
    async () => {
    const marker = '\n[output truncated]\n';
    const script =
      `process.stdout.write('s'.repeat(200));` +
      `process.stderr.write('e'.repeat(200));`;
    const result = await runGit(
      ['-c', `alias.noisy=!${process.execPath} -e "${script}"`, 'noisy'],
      process.cwd(),
      2_000,
      24,
    );
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(24 + Buffer.byteLength(marker));
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(24 + Buffer.byteLength(marker));
    expect(result.stdout.split(marker)).toHaveLength(2);
    expect(result.stderr.split(marker)).toHaveLength(2);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'preserves the exact retained stdout bytes and reports truncation',
    async () => {
      const script = `process.stdout.write(Buffer.from([255,0,97,98,99]))`;
      const result = await runGitBytes(
        ['-c', `alias.raw=!${process.execPath} -e "${script}"`, 'raw'],
        process.cwd(),
        2_000,
        4,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual(Buffer.from([255, 0, 97, 98]));
      expect(result.stdoutTruncated).toBe(true);
    },
  );
});

/**
 * Ship quarantine machinery. These build REAL repos in temp dirs: the claim is
 * about what git actually does to the index/refs/object db, which no scripted
 * runner can stand in for.
 */
const KEY = '11111111-2222-3333-4444-555555555555';

async function freshRepo(tag: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `karst-ship-${tag}-`));
  const init = await runGit(['init', '-b', 'main'], dir);
  expect(init.exitCode).toBe(0);
  await runGit(['config', 'user.name', 'Test'], dir);
  await runGit(['config', 'user.email', 'test@example.com'], dir);
  await runGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

async function writeAndCommit(dir: string, file: string, content: string, msg: string): Promise<void> {
  writeFileSync(join(dir, file), content);
  const add = await runGit(['add', '-A'], dir);
  expect(add.exitCode).toBe(0);
  const commit = await runGit(['commit', '-m', msg], dir);
  expect(commit.exitCode).toBe(0);
}

describe('ship quarantine commit primitives', () => {
  it('prepares in quarantine without touching live HEAD/index, then lands the exact commit', async () => {
    const dir = await freshRepo('prepare');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const preHead = (await headCommit(defaultGitRunner, dir))!;
      const preIndexTree = (await runGit(['write-tree'], dir)).stdout.trim();

      writeFileSync(join(dir, 'a.txt'), 'b');
      writeFileSync(join(dir, 'b.txt'), 'new');
      const fingerprint = (await workingTreeSummary(defaultGitRunner, dir)).fingerprint;

      const prepared = await prepareCommitInQuarantine(defaultGitRunner, dir, KEY, {
        preHead,
        message: 'chore: ship the work',
        author: { name: 'Author', email: 'author@example.com', at: '2026-08-08T10:00:00+02:00' },
        committer: {
          name: 'Committer',
          email: 'committer@example.com',
          at: '2026-08-08T11:00:00+02:00',
        },
      });

      expect(prepared.expectedHead).toMatch(/^[0-9a-f]{40}$/);
      expect(prepared.intendedTree).toMatch(/^[0-9a-f]{40}$/);
      expect(await headCommit(defaultGitRunner, dir)).toBe(preHead);
      expect((await runGit(['write-tree'], dir)).stdout.trim()).toBe(preIndexTree);
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('b');

      await promoteQuarantineTwice(dir);
      const cas = await compareAndSwapHeadAndIndex(defaultGitRunner, dir, {
        preHead,
        expectedHead: prepared.expectedHead,
        intendedTree: prepared.intendedTree,
        preIndexTree,
        expectedFingerprint: fingerprint,
        quarantineKey: KEY,
      });
      expect(cas).toEqual({ ok: true });

      expect(await headCommit(defaultGitRunner, dir)).toBe(prepared.expectedHead);
      expect((await runGit(['write-tree'], dir)).stdout.trim()).toBe(prepared.intendedTree);
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('b');
      expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('new');

      const log = await runGit(
        ['log', '-1', '--format=%an|%ae|%aI|%cn|%ce|%cI'],
        dir,
      );
      expect(log.stdout.trim()).toBe(
        'Author|author@example.com|2026-08-08T10:00:00+02:00|Committer|committer@example.com|2026-08-08T11:00:00+02:00',
      );

      const own = await runGit(['log', '-1', '--format=%s'], dir);
      expect(own.stdout.trim()).toBe('chore: ship the work');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepares and lands the commit from a LINKED worktree, alternating the common object db', async () => {
    const dir = await freshRepo('linked-wt');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const preHead = (await headCommit(defaultGitRunner, dir))!;

      // Cut a linked worktree the way karst does. Its git dir is an admin dir
      // WITHOUT an objects dir — the regression this test pins: quarantine
      // preparation must alternate the COMMON object db, never a per-worktree
      // one that does not exist (the failing ship read-tree on 869efpayd).
      const wt = join(dir, 'wt');
      const add = await runGit(['worktree', 'add', '-b', 'karst/wt/linked', wt, preHead], dir);
      expect(add.exitCode).toBe(0);
      const adminDir = (await runGit(['rev-parse', '--absolute-git-dir'], wt)).stdout.trim();
      expect(existsSync(join(adminDir, 'objects'))).toBe(false);

      writeFileSync(join(wt, 'a.txt'), 'b');
      writeFileSync(join(wt, 'b.txt'), 'new');
      const fingerprint = (await workingTreeSummary(defaultGitRunner, wt)).fingerprint;
      const preIndexTree = (await runGit(['write-tree'], wt)).stdout.trim();

      const prepared = await prepareCommitInQuarantine(defaultGitRunner, wt, KEY, {
        preHead,
        message: 'chore: ship the work',
        author: { name: 'Author', email: 'author@example.com', at: '2026-08-08T10:00:00+02:00' },
        committer: {
          name: 'Committer',
          email: 'committer@example.com',
          at: '2026-08-08T11:00:00+02:00',
        },
      });
      expect(prepared.expectedHead).toMatch(/^[0-9a-f]{40}$/);

      // The quarantined tree materializes the base tree PLUS the staged
      // content — an empty quarantine object dir proves the base was read
      // through the alternate. The tree object lives ONLY in the quarantine
      // until promotion, so read it back with the quarantine env: `write-tree`
      // wrote the new tree into `GIT_OBJECT_DIRECTORY`, so the main repo
      // cannot resolve it without the env (a main-repo read before promotion
      // fails: the object is not there yet). The alternate names the COMMON
      // object db directly — a linked worktree's admin dir has no objects dir,
      // and its nesting depth must not be walked to find the main repo's.
      const qObjects = join(adminDir, 'karst-quarantine', KEY, 'objects');
      const quarantineEnv = {
        GIT_OBJECT_DIRECTORY: qObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(dir, '.git', 'objects'),
      };
      const tree = await runGitEnv(
        ['ls-tree', '-r', '--name-only', prepared.intendedTree],
        wt,
        quarantineEnv,
      );
      expect(tree.stdout.trim().split('\n').sort()).toEqual(['a.txt', 'b.txt']);
      const baseContent = await runGitEnv(
        ['show', `${prepared.intendedTree}:a.txt`],
        wt,
        quarantineEnv,
      );
      expect(baseContent.stdout).toBe('b');
      expect(await headCommit(defaultGitRunner, wt)).toBe(preHead);

      await promoteQuarantineTwice(wt);
      // Promoted objects must be reachable from the MAIN repo (the common
      // object db) — a per-worktree copy would be invisible here.
      expect((await runGit(['cat-file', '-e', prepared.expectedHead], dir)).exitCode).toBe(0);

      const cas = await compareAndSwapHeadAndIndex(defaultGitRunner, wt, {
        preHead,
        expectedHead: prepared.expectedHead,
        intendedTree: prepared.intendedTree,
        preIndexTree,
        expectedFingerprint: fingerprint,
        quarantineKey: KEY,
      });
      expect(cas).toEqual({ ok: true });
      expect(await headCommit(defaultGitRunner, wt)).toBe(prepared.expectedHead);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses every divergence without touching HEAD or the index', async () => {
    const dir = await freshRepo('cas');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const preHead = (await headCommit(defaultGitRunner, dir))!;
      const preIndexTree = (await runGit(['write-tree'], dir)).stdout.trim();
      writeFileSync(join(dir, 'a.txt'), 'b');
      const fingerprint = (await workingTreeSummary(defaultGitRunner, dir)).fingerprint;
      const prepared = await prepareCommitInQuarantine(defaultGitRunner, dir, KEY, {
        preHead,
        message: 'm',
        author: { name: 'A', email: 'a@e', at: '2026-08-08T10:00:00+02:00' },
        committer: { name: 'A', email: 'a@e', at: '2026-08-08T10:00:00+02:00' },
      });
      const input = {
        preHead,
        expectedHead: prepared.expectedHead,
        intendedTree: prepared.intendedTree,
        preIndexTree,
        expectedFingerprint: fingerprint,
        quarantineKey: KEY,
      };
      const expectRefusal = async (reason: string, after = preHead) => {
        const outcome = await compareAndSwapHeadAndIndex(defaultGitRunner, dir, input);
        expect(outcome).toEqual({ ok: false, reason });
        expect(await headCommit(defaultGitRunner, dir)).toBe(after);
      };

      await writeAndCommit(dir, 'c.txt', 'human', 'human commit');
      const humanHead = (await headCommit(defaultGitRunner, dir))!;
      await expectRefusal('third-head', humanHead);
      await runGit(['reset', '--hard', preHead], dir);

      writeFileSync(join(dir, 'a.txt'), 'b');
      await runGit(['add', '-A'], dir);
      await expectRefusal('index-diverged');
      await runGit(['reset', '--hard', preHead], dir);

      writeFileSync(join(dir, 'a.txt'), 'b');
      writeFileSync(join(dir, 'u.txt'), 'untracked');
      await expectRefusal('worktree-diverged');
      rmSync(join(dir, 'u.txt'), { force: true });

      const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], dir)).stdout.trim();
      const lock = join(gitDir, 'karst-index-lock');
      writeFileSync(lock, prepared.intendedTree);
      await expectRefusal('lock-exists');
      await expectRefusal('lock-exists');
      rmSync(lock, { force: true });

      rmSync(join(gitDir, 'karst-quarantine', KEY), { recursive: true, force: true });
      await expectRefusal('quarantine-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('headCommit, listCommitsFrom and remoteRefSha answer for a real repo', async () => {
    const dir = await freshRepo('probes');
    const bare = mkdtempSync(join(tmpdir(), 'karst-ship-remote-'));
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'one');
      const first = (await headCommit(defaultGitRunner, dir))!;
      await writeAndCommit(dir, 'a.txt', 'b', 'two');
      const second = (await headCommit(defaultGitRunner, dir))!;

      expect(await headCommit(defaultGitRunner, dir)).toBe(second);
      expect(await listCommitsFrom(defaultGitRunner, dir, null)).toEqual([first, second]);
      expect(await listCommitsFrom(defaultGitRunner, dir, first)).toEqual([second]);

      await runGit(['init', '--bare'], bare);
      await runGit(['remote', 'add', 'origin', bare], dir);
      await runGit(['push', '-u', 'origin', 'main'], dir);
      expect(await remoteRefSha(defaultGitRunner, dir, 'origin', 'main')).toBe(second);
      expect(await remoteRefSha(defaultGitRunner, dir, 'origin', 'nope')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('listCommitsFrom throws a bounded diagnostic when the bound does not resolve', async () => {
    const dir = await freshRepo('revlist-bound');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'one');
      let message = '';
      await listCommitsFrom(defaultGitRunner, dir, 'no-such-ref').catch((err: Error) => {
        message = err.message;
      });
      expect(message).toMatch(/git rev-list no-such-ref\.\.HEAD failed \(exit 128\)/);
      // Bounded: the raw multi-line fatal prose is collapsed to one line.
      expect(message.split('\n')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listCommitsFrom accepts a branch-name bound — the shape ship provenance uses', async () => {
    const dir = await freshRepo('revlist-branch');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const base = (await headCommit(defaultGitRunner, dir))!;
      await runGit(['branch', 'develop'], dir);
      await writeAndCommit(dir, 'a.txt', 'b', 'ticket');
      const head = (await headCommit(defaultGitRunner, dir))!;

      // A branch name bounds exactly like the sha it names: `develop..HEAD`,
      // which is what ship passes when the persisted worktree baseline is a
      // branch. The two answers must never disagree.
      expect(await listCommitsFrom(defaultGitRunner, dir, 'develop')).toEqual([head]);
      expect(await listCommitsFrom(defaultGitRunner, dir, base)).toEqual([head]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('workingTreeSummary changes on tracked edits and untracked files, and is stable when clean', async () => {
    const dir = await freshRepo('fingerprint');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const clean = (await workingTreeSummary(defaultGitRunner, dir)).fingerprint;
      expect((await workingTreeSummary(defaultGitRunner, dir)).fingerprint).toBe(clean);

      writeFileSync(join(dir, 'a.txt'), 'edited');
      const edited = (await workingTreeSummary(defaultGitRunner, dir)).fingerprint;
      expect(edited).not.toBe(clean);

      await runGit(['add', '-A'], dir);
      expect((await workingTreeSummary(defaultGitRunner, dir)).fingerprint).not.toBe(clean);

      await runGit(['commit', '-m', 'edit'], dir);
      const committed = (await workingTreeSummary(defaultGitRunner, dir)).fingerprint;
      expect(committed).not.toBe(edited);

      writeFileSync(join(dir, 'u.txt'), 'untracked');
      const untracked = (await workingTreeSummary(defaultGitRunner, dir)).fingerprint;
      expect(untracked).not.toBe(committed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleanupQuarantine removes only its own keyed directory and rejects foreign keys', async () => {
    const dir = await freshRepo('cleanup');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const preHead = (await headCommit(defaultGitRunner, dir))!;
      await prepareCommitInQuarantine(defaultGitRunner, dir, KEY, {
        preHead,
        message: 'm',
        author: { name: 'A', email: 'a@e', at: '2026-08-08T10:00:00+02:00' },
        committer: { name: 'A', email: 'a@e', at: '2026-08-08T10:00:00+02:00' },
      });

      await cleanupQuarantine(defaultGitRunner, dir, KEY);
      await expect(cleanupQuarantine(defaultGitRunner, dir, KEY)).resolves.toBeUndefined();
      await expect(cleanupQuarantine(defaultGitRunner, dir, '../evil')).rejects.toThrow(
        /invalid quarantine key/,
      );
      await expect(cleanupQuarantine(defaultGitRunner, dir, 'a/b')).rejects.toThrow(
        /invalid quarantine key/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Promotion is idempotent; run it twice to prove it, keeping the second call's claim honest. */
async function promoteQuarantineTwice(dir: string): Promise<void> {
  await promoteQuarantinedObjects(defaultGitRunner, dir, KEY);
  const again = await promoteQuarantinedObjects(defaultGitRunner, dir, KEY);
  expect(typeof again).toBe('boolean');
}
