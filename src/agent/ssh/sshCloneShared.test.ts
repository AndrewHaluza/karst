import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CloneInput } from '../docker/dockerClone.js';
import type { ProcessResult, ProcessRunOptions, SbxProcess } from '../sbx/sbxProcess.js';
import {
  HARDENED_FETCH_FLAGS,
  HOST_GIT_ENV,
  diffSandboxBundle,
  fetchSandboxBundle,
  syncSandboxBundle,
} from './sshCloneShared.js';

const WT = '/w t';
const BRANCH = 'feat/x';
const SHA = 'a'.repeat(40);
const input: CloneInput = { hostWorktreePath: WT, branch: BRANCH };

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly opts?: ProcessRunOptions;
}

interface FakeHost extends SbxProcess {
  readonly calls: Call[];
}

/** Answers by joined argv prefix; records the bundle bytes at call time (the xfer temp is gone afterwards). */
function fakeHost(
  answers: Record<string, Partial<ProcessResult>> = {},
  onFetch?: (path: string, bytes: Buffer) => void,
): FakeHost {
  const calls: Call[] = [];
  return {
    calls,
    run: async (command, args, opts) => {
      calls.push({ command, args: [...args], ...(opts ? { opts } : {}) });
      if (onFetch !== undefined && args.includes('fetch')) {
        const path = args.find((a) => a.endsWith('out.bundle'));
        if (path !== undefined) onFetch(path, readFileSync(path));
      }
      const line = [command, ...args].join(' ');
      const key = Object.keys(answers)
        .filter((k) => line.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const hit = key === undefined ? {} : answers[key]!;
      return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
    },
  };
}

const bytes = (text: string): Uint8Array => Buffer.from(text);

describe('fetchSandboxBundle', () => {
  it('writes the bytes through xfer, fetches by explicit path into the private ref, and removes the temp', async () => {
    let path = '';
    let written = Buffer.alloc(0);
    const host = fakeHost({}, (p, b) => { path = p; written = b; });
    await expect(fetchSandboxBundle({ host, input, bundle: async () => bytes('bundle-bytes') })).resolves.toEqual({ ok: true });
    expect(written.toString()).toBe('bundle-bytes');
    expect(path.endsWith('/out.bundle')).toBe(true);
    expect(existsSync(path)).toBe(false);

    const fetch = host.calls[0]!;
    expect(fetch.command).toBe('git');
    expect(fetch.args.slice(0, 2 + HARDENED_FETCH_FLAGS.length)).toEqual(['-C', WT, ...HARDENED_FETCH_FLAGS]);
    expect(fetch.args.slice(2 + HARDENED_FETCH_FLAGS.length)).toEqual([
      'fetch', '--no-write-fetch-head', path, `+refs/heads/${BRANCH}:refs/karst/sandbox/${BRANCH}`,
    ]);
    expect(fetch.opts?.env).toEqual(HOST_GIT_ENV);
    expect(fetch.args.join(' ')).not.toContain('FETCH_HEAD');
  });

  it('reports a failed fetch', async () => {
    const host = fakeHost({ [`git -C ${WT} -c`]: { code: 1, stderr: 'bad bundle' } });
    await expect(fetchSandboxBundle({ host, input, bundle: async () => bytes('x') })).resolves.toEqual({
      ok: false, reason: 'git fetch of the sandbox bundle failed: bad bundle',
    });
  });

  it('removes the temp even when the fetch throws', async () => {
    let path = '';
    const host: SbxProcess = {
      run: async (_command, args) => {
        const p = args.find((a) => a.endsWith('out.bundle'));
        if (p !== undefined) path = p;
        throw new Error('spawn failed');
      },
    };
    await expect(fetchSandboxBundle({ host, input, bundle: async () => bytes('x') })).rejects.toThrow('spawn failed');
    expect(path.endsWith('/out.bundle')).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});

describe('syncSandboxBundle', () => {
  const headKey = `git -C ${WT} rev-parse --verify --quiet refs/karst/sandbox/${BRANCH}^{commit}`;

  it('resolves the ref once, then fast-forwards to that sha', async () => {
    const host = fakeHost({
      [headKey]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor HEAD ${SHA}`]: { code: 0 },
      [`git -C ${WT} merge --ff-only ${SHA}`]: { code: 0 },
    });
    await expect(syncSandboxBundle({ host, input, bundle: async () => bytes('b') })).resolves.toEqual({
      ok: true, summary: `fast-forwarded ${BRANCH} to the ssh sandbox's commits`,
    });
    const lines = host.calls.map((c) => c.args.join(' '));
    expect(lines).toContain(`-C ${WT} merge --ff-only ${SHA}`);
    expect(lines.filter((l) => l.includes('rev-parse --verify --quiet'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('FETCH_HEAD');
  });

  it('refuses a divergence and never merges', async () => {
    const host = fakeHost({
      [headKey]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor HEAD ${SHA}`]: { code: 1 },
      [`git -C ${WT} merge-base --is-ancestor ${SHA} HEAD`]: { code: 1 },
    });
    await expect(syncSandboxBundle({ host, input, bundle: async () => bytes('b') })).resolves.toEqual({
      ok: false, reason: `refused: the sandbox's ${BRANCH} is not a fast-forward of the host branch (never forced)`,
    });
    expect(host.calls.map((c) => c.args.join(' ')).some((l) => l.includes('merge --ff-only'))).toBe(false);
  });

  it('a clone behind the host is a no-op ok', async () => {
    const host = fakeHost({
      [headKey]: { stdout: `${SHA}\n` },
      [`git -C ${WT} merge-base --is-ancestor HEAD ${SHA}`]: { code: 1 },
      [`git -C ${WT} merge-base --is-ancestor ${SHA} HEAD`]: { code: 0 },
    });
    await expect(syncSandboxBundle({ host, input, bundle: async () => bytes('b') })).resolves.toEqual({
      ok: true, summary: 'host ahead, nothing to bring',
    });
    expect(host.calls.map((c) => c.args.join(' ')).some((l) => l.includes('merge --ff-only'))).toBe(false);
  });

  it('an unreadable head is an error, never a divergence, and never merges', async () => {
    const host = fakeHost({ [headKey]: { code: 1 } });
    await expect(syncSandboxBundle({ host, input, bundle: async () => bytes('b') })).resolves.toEqual({
      ok: false, reason: 'cannot read the sandbox head',
    });
    expect(host.calls.map((c) => c.args.join(' ')).some((l) => l.includes('merge'))).toBe(false);
  });
});

describe('diffSandboxBundle', () => {
  it('fetches, resolves once and diffs HEAD against that sha', async () => {
    const host = fakeHost({
      [`git -C ${WT} rev-parse --verify --quiet refs/karst/sandbox/${BRANCH}^{commit}`]: { stdout: `${SHA}\n` },
      [`git -C ${WT} diff HEAD...${SHA}`]: { stdout: 'diff --git a/a b/a\n' },
    });
    await expect(diffSandboxBundle({ host, input, bundle: async () => bytes('b') })).resolves.toEqual({
      ok: true, diff: 'diff --git a/a b/a\n', ref: SHA,
    });
    expect(host.calls.map((c) => c.args.join(' '))).toContain(`-C ${WT} diff HEAD...${SHA}`);
  });

  it('reports a failed diff', async () => {
    const host = fakeHost({
      [`git -C ${WT} rev-parse --verify --quiet refs/karst/sandbox/${BRANCH}^{commit}`]: { stdout: `${SHA}\n` },
      [`git -C ${WT} diff HEAD...${SHA}`]: { code: 1, stderr: 'bad tree' },
    });
    await expect(diffSandboxBundle({ host, input, bundle: async () => bytes('b') })).resolves.toEqual({
      ok: false, reason: 'git diff failed: bad tree',
    });
  });
});
