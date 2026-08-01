import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
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
 * Both process-tree tests need a grandchild that is DEMONSTRABLY alive before
 * the thing under test (a timeout, an abort) fires — otherwise they race the
 * spawn chain (git → shell alias → node → node) and the whole point is lost.
 *
 * Reading that pid off the run's stdout cannot give them this: stdout is only
 * readable once the run has SETTLED, i.e. after the kill already happened. A
 * fixed `setTimeout(abort, 100)` was standing in for "the tree is up", and on a
 * loaded machine — the gate runs 254 files at once — the chain takes longer
 * than that, so the abort landed before anything was printed, `parseInt('')`
 * returned NaN, and the test failed on `Number.isInteger`. Worse, the sibling
 * timeout test passes VACUOUSLY in that case: `process.kill(NaN, 0)` throws,
 * which `expectProcessDead` reads as "already dead".
 *
 * The pid goes to a file instead, and the test waits for the file. The wait is
 * bounded and its expiry is a failure, not a silent skip.
 */
function pidFilePath(name: string): string {
  return join(tmpdir(), `karst-git-${name}-${process.pid}-${randomUUID()}.pid`);
}

/** A git alias body that spawns a detached child, records its pid, and hangs. */
function hangTreeScript(pidFile: string): string {
  return (
    `const{spawn}=require('node:child_process');` +
    `const{writeFileSync}=require('node:fs');` +
    `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);` +
    `writeFileSync('${pidFile}',String(c.pid));` +
    `process.stdout.write(String(c.pid)+'\\\\n');setInterval(()=>{},1000)`
  );
}

async function readPidWhenSpawned(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      if (Number.isInteger(pid)) return pid;
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect.fail(`the git process tree never recorded a pid in ${pidFile}`);
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
      const pidFile = pidFilePath('timeout');
      try {
        // The timeout is the SUBJECT here, so it cannot be deferred until the
        // tree is up — it is given enough room for the spawn chain instead. At
        // 100ms a loaded machine reaped git before its own child had spawned,
        // and the test then asserted a NaN pid was dead, which it always is.
        const r = await runGit(
          ['-c', `alias.hangtree=!${process.execPath} -e "${hangTreeScript(pidFile)}"`, 'hangtree'],
          process.cwd(),
          2_000,
          1024,
          500,
        );
        const grandchildPid = await readPidWhenSpawned(pidFile);

        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain('timed out after 2000ms');
        expect(Number.isInteger(grandchildPid)).toBe(true);
        await expectProcessDead(grandchildPid);
      } finally {
        rmSync(pidFile, { force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'aborts a detached git process tree and settles with an abort reason',
    async () => {
      const controller = new AbortController();
      const pidFile = pidFilePath('abort');
      try {
        const pending = runGit(
          ['-c', `alias.hangtree=!${process.execPath} -e "${hangTreeScript(pidFile)}"`, 'hangtree'],
          process.cwd(),
          10_000,
          1024,
          500,
          controller.signal,
        );

        // Abort once the tree demonstrably EXISTS, never on a fixed delay: the
        // claim is that abort kills a live descendant, and a delay that expires
        // first tests nothing while looking like it passed.
        const grandchildPid = await readPidWhenSpawned(pidFile);
        controller.abort();
        const result = await pending;

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/aborted/i);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        await expectProcessDead(grandchildPid);
      } finally {
        rmSync(pidFile, { force: true });
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
