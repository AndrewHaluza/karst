import { afterEach, describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultGhRunnerAsync,
  openPr,
  findOpenPr,
  toGhResult,
  normalizePrState,
  fetchPrState,
  type GhRunner,
} from './github.js';
import { GH_DEPENDENCY, renderMissingDependency } from '../runtime/deps.js';

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

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

function installFakeGh(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-gh-'));
  tempDirs.push(dir);
  const executable = join(dir, 'gh');
  writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${dir}:${originalPath ?? ''}`;
  return dir;
}

afterEach(() => {
  process.env.PATH = originalPath;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('defaultGhRunnerAsync (POSIX fixture)', () => {
  it('maps a missing gh to the dependency instruction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-no-gh-'));
    tempDirs.push(dir);
    process.env.PATH = dir;

    const result = await defaultGhRunnerAsync(['status'], dir, { timeoutMs: 1_000 });

    expect(result).toEqual({
      stdout: '',
      stderr: renderMissingDependency(GH_DEPENDENCY),
      exitCode: 1,
    });
  });

  it('maps a normal exit without blocking the event loop', async () => {
    const cwd = installFakeGh(
      `setTimeout(() => { process.stdout.write('ok'); process.stderr.write('note'); }, 30);`,
    );
    let responsive = false;
    setTimeout(() => {
      responsive = true;
    }, 0);

    const result = await defaultGhRunnerAsync(['status'], cwd, { timeoutMs: 1_000 });

    expect(responsive).toBe(true);
    expect(result).toEqual({ stdout: 'ok', stderr: 'note', exitCode: 0 });
  });

  it('times out a hung gh process and reports a nonzero result', async () => {
    const cwd = installFakeGh(`setInterval(() => {}, 1_000);`);

    const result = await defaultGhRunnerAsync(['status'], cwd, {
      timeoutMs: 20,
      terminationGraceMs: 200,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('gh timed out after 20ms');
  });

  it('terminates a timed-out gh process and its descendants', async () => {
    const readiness = new Int32Array(new SharedArrayBuffer(4));
    const handshakeDir = mkdtempSync(join(tmpdir(), 'karst-gh-ready-'));
    tempDirs.push(handshakeDir);
    const pidFile = join(handshakeDir, 'grandchild.pid');
    const cwd = installFakeGh(`
      const { writeFileSync } = require('node:fs');
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
      process.stdout.write(String(grandchild.pid) + '\\n');
      setInterval(() => {}, 1000);
    `);
    vi.useFakeTimers();
    const result = await (async () => {
      try {
        const pending = defaultGhRunnerAsync(['status'], cwd, {
          timeoutMs: 10_000,
          terminationGraceMs: 500,
        });

        const readinessDeadline = process.hrtime.bigint() + 5_000_000_000n;
        while (!existsSync(pidFile) && process.hrtime.bigint() < readinessDeadline) {
          Atomics.wait(readiness, 0, 0, 10);
        }
        expect(existsSync(pidFile)).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    })();
    const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);

    expect(result.exitCode).toBe(1);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await expectProcessDead(grandchildPid);
  });

  it('bounds both output streams and marks truncation once per stream', async () => {
    const cwd = installFakeGh(
      `process.stdout.write('s'.repeat(200)); process.stderr.write('e'.repeat(200));`,
    );
    const marker = '\n[output truncated]\n';

    const result = await defaultGhRunnerAsync(['status'], cwd, {
      maxOutputBytes: 24,
      timeoutMs: 1_000,
    });

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(24 + Buffer.byteLength(marker));
    expect(Buffer.byteLength(result.stderr!)).toBeLessThanOrEqual(
      24 + Buffer.byteLength(marker) + 100,
    );
    expect(result.stdout.split(marker)).toHaveLength(2);
    expect(result.stderr!.split(marker)).toHaveLength(2);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('refusing truncated gh output');
  });

  it('clears its deadline after ordinary completion', async () => {
    const cwd = installFakeGh(`process.stdout.write('ok');`);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await defaultGhRunnerAsync(['status'], cwd, { timeoutMs: 10_000 });

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});

describe('toGhResult', () => {
  it('carries gh’s own stderr through', () => {
    expect(toGhResult({ stdout: 'out', stderr: 'boom', status: 1, error: undefined })).toEqual({
      stdout: 'out',
      stderr: 'boom',
      exitCode: 1,
    });
  });

  it('turns a missing gh into an instruction, not an ENOENT', () => {
    // `gh` not installed: spawnSync returns status null and null pipes, and the
    // real cause lives only on `error`. "spawnSync gh ENOENT" is true but tells a
    // user nothing they can act on — and this text is what the dashboard's fault
    // card shows them.
    const r = toGhResult({
      stdout: null,
      stderr: null,
      status: null,
      error: Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain('ENOENT');
    // Registry copy, not a second hand-written version of it: the fault card and
    // the setup checklist must not disagree about how to install gh.
    expect(r.stderr).toBe(renderMissingDependency(GH_DEPENDENCY));
  });

  it('reports any other spawn failure verbatim — gh never ran, so it said nothing', () => {
    const r = toGhResult({
      stdout: null,
      stderr: null,
      status: null,
      error: Object.assign(new Error('spawnSync gh EACCES'), { code: 'EACCES' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('EACCES');
    expect(r.stderr).toContain('gh');
  });

  it('never yields an empty reason for a failure', () => {
    const r = toGhResult({ stdout: null, stderr: null, status: 1, error: undefined });
    expect(r.stderr!.length).toBeGreaterThan(0);
  });
});

describe('openPr', () => {
  it('runs `gh pr create` in the repo cwd and parses the returned URL', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: 'https://github.com/o/r/pull/7\n', exitCode: 0 };
    };
    const pr = await openPr(gh, { cwd: '/wt/a', title: 'T', body: 'desc' });
    expect(calls[0]!.args).toContain('pr');
    expect(calls[0]!.args).toContain('create');
    expect(calls[0]!.cwd).toBe('/wt/a');
    expect(pr.url).toBe('https://github.com/o/r/pull/7');
    expect(pr.number).toBe(7);
  });

  it('passes the title and body through to gh', async () => {
    const seen: string[] = [];
    const gh: GhRunner = async (args) => {
      seen.push(...args);
      return { stdout: 'https://github.com/o/r/pull/1', exitCode: 0 };
    };
    await openPr(gh, { cwd: '/wt', title: 'My Title', body: 'My Body' });
    expect(seen).toContain('My Title');
    expect(seen).toContain('My Body');
  });

  it('throws when gh exits nonzero, naming what gh reported', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 1, stderr: 'auth error' });
    await expect(openPr(gh, { cwd: '/wt', title: 'T', body: 'b' })).rejects.toThrow(/auth error/);
  });

  it('still says something useful when gh fails silently', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 3, stderr: '' });
    await expect(openPr(gh, { cwd: '/wt', title: 'T', body: 'b' })).rejects.toThrow(/exit 3/);
  });
});

const viewJson = (o: unknown): string => JSON.stringify(o);

describe('findOpenPr', () => {
  it('asks gh for the branch’s PR as JSON, in the repo cwd', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: viewJson({ number: 18, url: 'https://github.com/o/r/pull/18', state: 'OPEN' }), exitCode: 0 };
    };
    const pr = await findOpenPr(gh, '/wt/a');
    expect(calls[0]!.args).toEqual(['pr', 'view', '--json', 'number,url,state']);
    expect(calls[0]!.cwd).toBe('/wt/a');
    expect(pr).toEqual({ number: 18, url: 'https://github.com/o/r/pull/18' });
  });

  // The only signal gh gives for "this branch has no PR" is a nonzero exit. It is
  // also what an auth or remote failure looks like — which is why this returns
  // null rather than throwing: `openPr` runs next and reports that failure with
  // gh's own words. Nothing is swallowed.
  it('is null when gh exits nonzero — no PR for this branch', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 1, stderr: 'no pull requests found for branch' });
    expect(await findOpenPr(gh, '/wt')).toBeNull();
  });

  it('is null on output that is not JSON, rather than throwing', async () => {
    const gh: GhRunner = async () => ({ stdout: 'https://github.com/o/r/pull/1', exitCode: 0 });
    expect(await findOpenPr(gh, '/wt')).toBeNull();
  });

  // A closed or merged PR does NOT block a new one on the same branch. Adopting
  // it would strand the ticket on a PR nobody will merge, and skip the create
  // that should have happened.
  it.each(['CLOSED', 'MERGED'])('is null for a %s PR — a new one must still open', async (state) => {
    const gh: GhRunner = async () => ({
      stdout: viewJson({ number: 4, url: 'https://github.com/o/r/pull/4', state }),
      exitCode: 0,
    });
    expect(await findOpenPr(gh, '/wt')).toBeNull();
  });

  it('falls back to the URL when gh reports no number', async () => {
    const gh: GhRunner = async () => ({
      stdout: viewJson({ url: 'https://github.com/o/r/pull/12', state: 'OPEN' }),
      exitCode: 0,
    });
    expect(await findOpenPr(gh, '/wt')).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12' });
  });

  it('is null when the JSON carries no url — an adopted PR with no link is useless', async () => {
    const gh: GhRunner = async () => ({ stdout: viewJson({ number: 3, state: 'OPEN' }), exitCode: 0 });
    expect(await findOpenPr(gh, '/wt')).toBeNull();
  });
});

describe('normalizePrState', () => {
  it('maps gh’s upstream states onto the dashboard vocabulary', () => {
    expect(normalizePrState('MERGED', false)).toBe('merged');
    expect(normalizePrState('CLOSED', false)).toBe('closed');
    expect(normalizePrState('OPEN', false)).toBe('open');
  });

  // A draft is state OPEN with isDraft true — it needs its own label, or a PR
  // still being written reads as ready for review.
  it('distinguishes a draft from a ready open PR', () => {
    expect(normalizePrState('OPEN', true)).toBe('draft');
    expect(normalizePrState('OPEN', false)).toBe('open');
  });

  // A state gh never emits (a new upstream status, a garbled row) must not be
  // guessed into one of the known buckets — 'unknown' is the honest answer.
  it('is unknown for any unrecognised state', () => {
    expect(normalizePrState('WEIRD', false)).toBe('unknown');
    expect(normalizePrState(undefined, false)).toBe('unknown');
    expect(normalizePrState(null, undefined)).toBe('unknown');
  });
});

describe('fetchPrState', () => {
  it('asks gh for the PR’s state by ref, in the given cwd', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: viewJson({ state: 'MERGED', isDraft: false }), exitCode: 0 };
    };
    const status = await fetchPrState(gh, 'https://github.com/o/r/pull/9', '/wt/a');
    expect(calls[0]!.args).toEqual(['pr', 'view', 'https://github.com/o/r/pull/9', '--json', 'state,isDraft']);
    expect(calls[0]!.cwd).toBe('/wt/a');
    expect(status).toBe('merged');
  });

  it('reads a draft PR as draft', async () => {
    const gh: GhRunner = async () => ({ stdout: viewJson({ state: 'OPEN', isDraft: true }), exitCode: 0 });
    expect(await fetchPrState(gh, '12', '/wt')).toBe('draft');
  });

  // Every failure — bad auth, a deleted PR, a dead remote — is 'unknown', never a
  // throw and never a wrong state. The caller must be free to keep the last known
  // status rather than overwrite it with a guess.
  it('is unknown when gh exits nonzero', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 1, stderr: 'could not resolve to a PullRequest' });
    expect(await fetchPrState(gh, 'https://x/pull/1', '/wt')).toBe('unknown');
  });

  it('is unknown on output that is not JSON', async () => {
    const gh: GhRunner = async () => ({ stdout: 'not json', exitCode: 0 });
    expect(await fetchPrState(gh, '1', '/wt')).toBe('unknown');
  });
});
