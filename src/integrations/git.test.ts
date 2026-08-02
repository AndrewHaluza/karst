import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitAllIfDirty,
  pushBranch,
  defaultGitRunner,
  runGit,
  runGitBytes,
  type GitRunner,
} from './git.js';

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
    const timer = setInterval(() => (ticks += 1), 10);
    await runGit(['log', '--oneline', '-n', '200'], process.cwd());
    clearInterval(timer);
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
