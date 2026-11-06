import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { THIN_OUT_SCRIPT } from './docker/dockerClone.js';
import { CONTAINER_REPO } from './docker/dockerRunArgs.js';
import { fetchSandboxBundleArgs, hostBundleHaves } from './cloneSyncClass.js';
import { createSbxSessionRunner } from './sbx/sbxRunner.js';
import type { ProcessResult, SbxProcess } from './sbx/sbxProcess.js';

/**
 * T992 / arch:AC-46: a sandbox sync must add a pack proportional to the change, not a copy of the history.
 * Measured on real git: the bytes the host `.git/objects` grows by across one more sync.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'karst-syncpack-')));
// Git's detached auto-maintenance repacks after a fetch and would race the size measurement.
const NO_MAINTENANCE = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false' } as const;
const savedEnv = Object.fromEntries(Object.keys(NO_MAINTENANCE).map((k) => [k, process.env[k]]));
Object.assign(process.env, NO_MAINTENANCE);
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const BRANCH = 'feat';

function dirBytes(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
    const p = join(dir, e.name);
    return sum + (e.isDirectory() ? dirBytes(p) : statSync(p).size);
  }, 0);
}

/** A repo whose history is hard to compress (random files), so a full copy is unmistakably large. */
function makeHost(name: string): { wt: string; clone: string; historyBytes: number } {
  const wt = join(root, `${name}-wt`);
  const clone = join(root, `${name}-clone`);
  execFileSync('git', ['init', '-q', '-b', BRANCH, wt]);
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(wt, `f${i}.bin`), randomBytes(40_000));
    git(wt, 'add', '-A');
    git(wt, ...ID, 'commit', '-q', '-m', `c${i}`);
  }
  execFileSync('git', ['clone', '-q', '--no-hardlinks', wt, clone]);
  return { wt, clone, historyBytes: dirBytes(join(wt, '.git', 'objects')) };
}

function agentCommit(clone: string, n: number): void {
  writeFileSync(join(clone, 'small.txt'), `change ${n}\n`);
  git(clone, 'add', '-A');
  git(clone, ...ID, 'commit', '-q', '-m', `agent ${n}`);
}

/** `sbx exec <n> -- cmd` runs cmd locally in cwd (the "sandbox" is the clone); everything else is real. */
const localSbx: SbxProcess = {
  run: (command, args, opts) => {
    const argv = command === 'sbx' ? args.slice(args.indexOf('--') + 1) : args;
    const bin = command === 'sbx' ? argv[0]! : command;
    const r = spawnSync(bin, command === 'sbx' ? argv.slice(1) : [...argv], { cwd: opts?.cwd, encoding: 'utf8', env: { ...process.env, ...opts?.env } });
    return Promise.resolve<ProcessResult>({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
  },
};

describe('a repeated sandbox sync adds a small pack, not a copy of the history', () => {
  it('sbx: the second sync grows the host objects by far less than the history', async () => {
    const { wt, clone, historyBytes } = makeHost('sbx');
    const runner = createSbxSessionRunner({ proc: localSbx, core: 'claude', name: 'karst-ab12cd34-7-claude', existing: [], cloneDir: clone });
    agentCommit(clone, 1);
    expect(await runner.sync!({ hostWorktreePath: wt, branch: BRANCH })).toMatchObject({ ok: true });
    const before = dirBytes(join(wt, '.git', 'objects'));
    agentCommit(clone, 2);
    expect(await runner.sync!({ hostWorktreePath: wt, branch: BRANCH })).toMatchObject({ ok: true });
    const grown = dirBytes(join(wt, '.git', 'objects')) - before;
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'HEAD'));
    expect(historyBytes).toBeGreaterThan(500_000);
    expect(grown).toBeLessThan(historyBytes / 20);
  });

  it('sbx: a host-only commit (unknown to the clone) still gives a thin bundle through the last synced tip', async () => {
    const { wt, clone, historyBytes } = makeHost('sbxhost');
    const runner = createSbxSessionRunner({ proc: localSbx, core: 'claude', name: 'karst-ab12cd34-8-claude', existing: [], cloneDir: clone });
    agentCommit(clone, 1);
    expect(await runner.sync!({ hostWorktreePath: wt, branch: BRANCH })).toMatchObject({ ok: true });
    // The host commits on its own: HEAD is now a commit the clone lacks, so only the last fetched tip can thin the bundle.
    writeFileSync(join(wt, 'host.txt'), 'host\n');
    git(wt, 'add', '-A');
    git(wt, ...ID, 'commit', '-q', '-m', 'host only');
    const tip = git(clone, 'rev-parse', 'HEAD').trim();
    git(clone, 'update-ref', 'refs/heads/other', tip);
    agentCommit(clone, 2);
    const before = dirBytes(join(wt, '.git', 'objects'));
    await runner.sync!({ hostWorktreePath: wt, branch: BRANCH });
    const grown = dirBytes(join(wt, '.git', 'objects')) - before;
    expect(grown).toBeLessThan(historyBytes / 20);
  });

  it('docker: the clone-side script makes a thin bundle that the host fetch stores small', async () => {
    const { wt, clone, historyBytes } = makeHost('docker');
    const hostGit = (args: string[]) => Promise.resolve({ code: spawnSync('git', ['-C', wt, ...args]).status ?? 1, stdout: spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8' }).stdout });
    const sync = async (): Promise<void> => {
      const haves = await hostBundleHaves(hostGit, BRANCH);
      const out = join(root, `docker-${Date.now()}-${Math.random()}.bundle`);
      const script = THIN_OUT_SCRIPT.replace(`-C ${CONTAINER_REPO}`, `-C ${clone}`);
      execFileSync('sh', ['-c', script, 'karst-bundle', out, BRANCH, ...haves]);
      execFileSync('git', ['-C', wt, ...fetchSandboxBundleArgs(out, BRANCH)]);
      git(wt, 'merge', '--ff-only', `refs/karst/sandbox/${BRANCH}`);
    };
    agentCommit(clone, 1);
    await sync();
    const before = dirBytes(join(wt, '.git', 'objects'));
    agentCommit(clone, 2);
    await sync();
    const grown = dirBytes(join(wt, '.git', 'objects')) - before;
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'HEAD'));
    expect(grown).toBeLessThan(historyBytes / 20);
  });

  it('control: without a candidate commit the bundle is full and the host stores a copy of the history', () => {
    const { clone, historyBytes } = makeHost('full');
    agentCommit(clone, 1);
    const out = join(root, 'full.bundle');
    const script = THIN_OUT_SCRIPT.replace(`-C ${CONTAINER_REPO}`, `-C ${clone}`);
    execFileSync('sh', ['-c', script, 'karst-bundle', out, BRANCH]);
    expect(statSync(out).size).toBeGreaterThan(historyBytes / 2);
  });
});
