import { describe, it, expect } from 'vitest';
import { commitAllIfDirty, pushBranch, defaultGitRunner, runGit, type GitRunner } from './git.js';

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
    const script =
      `const{spawn}=require('node:child_process');` +
      `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);` +
      `process.stdout.write(String(c.pid)+'\\\\n');setInterval(()=>{},1000)`;
    const r = await runGit(
      ['-c', `alias.hangtree=!${process.execPath} -e "${script}"`, 'hangtree'],
      process.cwd(),
      100,
      1024,
      500,
    );
    const grandchildPid = Number.parseInt(r.stdout, 10);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('timed out after 100ms');
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await expectProcessDead(grandchildPid);
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
});
