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
  fetchPrDetail,
  UNKNOWN_PR_DETAIL,
  mergePr,
  updatePrBody,
  updatePrBase,
  fetchPrBody,
  prFromAlreadyExists,
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
      const { writeFileSync, renameSync } = require('node:fs');
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      writeFileSync(${JSON.stringify(pidFile)} + '.tmp', String(grandchild.pid));
      renameSync(${JSON.stringify(pidFile)} + '.tmp', ${JSON.stringify(pidFile)});
      process.stdout.write(String(grandchild.pid) + '\\n');
      setInterval(() => {}, 1000);
    `);
    vi.useFakeTimers();
    let grandchildPid = Number.NaN;
    const result = await (async () => {
      try {
        const pending = defaultGhRunnerAsync(['status'], cwd, {
          timeoutMs: 10_000,
          terminationGraceMs: 500,
        });

        // The pid file is renamed into place after its content is written, and
        // the poll requires a parseable pid — spawning is not instant, and
        // existsSync alone can observe the file before its content lands.
        const readinessDeadline = process.hrtime.bigint() + 5_000_000_000n;
        while (!Number.isInteger(grandchildPid) && process.hrtime.bigint() < readinessDeadline) {
          if (existsSync(pidFile)) {
            grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
          }
          if (!Number.isInteger(grandchildPid)) Atomics.wait(readiness, 0, 0, 10);
        }
        expect(Number.isInteger(grandchildPid)).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    })();

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
    // Registry copy, not a second hand-written version of it: the dashboard and
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

  it('marks a genuinely created PR as not adopted', async () => {
    const gh: GhRunner = async () => ({ stdout: 'https://github.com/o/r/pull/7', exitCode: 0 });
    expect(await openPr(gh, { cwd: '/wt', title: 'T', body: 'b' })).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      adopted: false,
    });
  });

  // The reported bug, in its most stubborn form: the branch probe can come back
  // blind (bad auth, an ambiguous base repo, a remote hiccup) and gh then refuses
  // the create — while handing back the URL of the PR that already exists. An
  // existing PR is what ship is FOR, so this is a reusable answer, not a failure.
  it('reuses the PR gh names instead of throwing when one already exists', async () => {
    const gh: GhRunner = async () => ({
      stdout: '',
      exitCode: 1,
      stderr:
        'a pull request for branch "fix/thing" into branch "develop" already exists:\nhttps://github.com/team/project/pull/123123',
    });
    expect(await openPr(gh, { cwd: '/wt', title: 'T', body: 'b' })).toEqual({
      number: 123123,
      url: 'https://github.com/team/project/pull/123123',
      adopted: true,
    });
  });

  it('reuses it even when gh writes the refusal to stdout', async () => {
    const gh: GhRunner = async () => ({
      stdout: 'a pull request for branch "x" into branch "develop" already exists:\nhttps://h/o/r/pull/5',
      exitCode: 1,
      stderr: '',
    });
    expect((await openPr(gh, { cwd: '/wt', title: 'T', body: 'b' })).adopted).toBe(true);
  });
});

describe('prFromAlreadyExists', () => {
  it('reads the PR gh named in its refusal', () => {
    expect(
      prFromAlreadyExists(
        'a pull request for branch "fix/x" into branch "develop" already exists:\nhttps://github.com/o/r/pull/42\n',
      ),
    ).toEqual({ number: 42, url: 'https://github.com/o/r/pull/42' });
  });

  it('is null for a failure that names no PR', () => {
    expect(prFromAlreadyExists('could not determine base repository')).toBeNull();
    expect(prFromAlreadyExists('')).toBeNull();
  });

  // Both signals are required, and deliberately so: reusing the wrong PR would
  // record someone else's work as this ticket's and pass the stage silently,
  // while failing to match only restores the loud error that was already visible.
  it('is null for a URL that is not an already-exists refusal', () => {
    expect(prFromAlreadyExists('pull request https://github.com/o/r/pull/9 is not mergeable')).toBeNull();
  });

  it('is null for an already-exists message with no URL to reuse', () => {
    expect(prFromAlreadyExists('a pull request for branch "x" already exists')).toBeNull();
  });
});

const viewJson = (o: unknown): string => JSON.stringify(o);

describe('findOpenPr', () => {
  it('asks gh for the branch’s PR as JSON, in the repo cwd', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return {
        stdout: viewJson({ number: 18, url: 'https://github.com/o/r/pull/18', state: 'OPEN', body: 'why' }),
        exitCode: 0,
      };
    };
    const pr = await findOpenPr(gh, '/wt/a');
    expect(calls[0]!.args).toEqual(['pr', 'view', '--json', 'number,url,state,body']);
    expect(calls[0]!.cwd).toBe('/wt/a');
    expect(pr).toEqual({ number: 18, url: 'https://github.com/o/r/pull/18', body: 'why' });
  });

  // The body decides whether an adopted PR may be prefilled, so the three cases
  // must stay distinguishable: prose to keep, '' to fill, and null for "gh did
  // not say" — which is NOT permission to overwrite.
  it('reports an empty body as empty, not as absent', async () => {
    const gh: GhRunner = async () => ({
      stdout: viewJson({ number: 2, url: 'https://github.com/o/r/pull/2', state: 'OPEN', body: '' }),
      exitCode: 0,
    });
    expect((await findOpenPr(gh, '/wt'))?.body).toBe('');
  });

  it('reports a body gh never returned as null, not as empty', async () => {
    const gh: GhRunner = async () => ({
      stdout: viewJson({ number: 2, url: 'https://github.com/o/r/pull/2', state: 'OPEN' }),
      exitCode: 0,
    });
    expect((await findOpenPr(gh, '/wt'))?.body).toBeNull();
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
    expect(await findOpenPr(gh, '/wt')).toEqual({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      body: null,
    });
  });

  it('is null when the JSON carries no url — an adopted PR with no link is useless', async () => {
    const gh: GhRunner = async () => ({ stdout: viewJson({ number: 3, state: 'OPEN' }), exitCode: 0 });
    expect(await findOpenPr(gh, '/wt')).toBeNull();
  });
});

describe('fetchPrBody', () => {
  it('asks gh for the body of a PR by ref, in the given cwd', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: viewJson({ body: '## Summary\nwhy' }), exitCode: 0 };
    };
    const body = await fetchPrBody(gh, 'https://github.com/o/r/pull/9', '/wt/a');
    expect(calls[0]!.args).toEqual(['pr', 'view', 'https://github.com/o/r/pull/9', '--json', 'body']);
    expect(calls[0]!.cwd).toBe('/wt/a');
    expect(body).toBe('## Summary\nwhy');
  });

  it('reports an empty body as empty, not as absent', async () => {
    const gh: GhRunner = async () => ({ stdout: viewJson({ body: '' }), exitCode: 0 });
    expect(await fetchPrBody(gh, '9', '/wt')).toBe('');
  });

  // Same rule as every other probe: a failure says "I do not know", never "empty"
  // — because "empty" is what authorizes an overwrite.
  it('is null for every failure, rather than throwing or guessing empty', async () => {
    const failed: GhRunner = async () => ({ stdout: '', exitCode: 1, stderr: 'auth' });
    const garbled: GhRunner = async () => ({ stdout: 'not json', exitCode: 0 });
    expect(await fetchPrBody(failed, '9', '/wt')).toBeNull();
    expect(await fetchPrBody(garbled, '9', '/wt')).toBeNull();
    expect(await fetchPrBody(async () => ({ stdout: viewJson({}), exitCode: 0 }), '9', '/wt')).toBeNull();
  });
});

describe('updatePrBody', () => {
  it('edits the PR body by ref, in the given cwd', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: '', exitCode: 0 };
    };
    const ok = await updatePrBody(gh, 'https://github.com/o/r/pull/8', '/wt/a', '## Summary\nx');

    expect(calls[0]!.args).toEqual([
      'pr',
      'edit',
      'https://github.com/o/r/pull/8',
      '--body',
      '## Summary\nx',
    ]);
    expect(calls[0]!.cwd).toBe('/wt/a');
    expect(ok).toEqual({ ok: true, reason: '' });
  });

  // The PR is already open — the irreversible part of ship succeeded. A failed
  // backfill is a note on a ship that worked, never an exception that parks the
  // ticket, so this reports rather than throws.
  it('reports gh’s refusal instead of throwing', async () => {
    const gh: GhRunner = async () => ({ stdout: '', stderr: 'no write access', exitCode: 1 });
    expect(await updatePrBody(gh, '8', '/wt', 'body')).toEqual({
      ok: false,
      reason: 'no write access',
    });
  });

  it('reports a runner that rejects, rather than propagating it', async () => {
    const gh: GhRunner = async () => {
      throw new Error('spawn failed');
    };
    expect(await updatePrBody(gh, '8', '/wt', 'body')).toEqual({
      ok: false,
      reason: 'spawn failed',
    });
  });

  it('never leaves the reason empty when gh says nothing', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 3 });
    expect((await updatePrBody(gh, '8', '/wt', 'body')).reason).toBe('gh exit 3');
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

describe('fetchPrDetail', () => {
  const full = {
    state: 'MERGED',
    isDraft: false,
    headRefName: 'karst/feat/x',
    baseRefName: 'develop',
    createdAt: '2026-07-23T08:00:00Z',
    mergedAt: '2026-07-28T09:30:00Z',
    comments: [{ author: { login: 'ada' }, createdAt: '2026-07-24T10:00:00Z', body: 'lgtm' }],
  };

  it('asks gh for every metadata field the ship stage renders, in one call', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: viewJson(full), exitCode: 0 };
    };
    const detail = await fetchPrDetail(gh, 'https://github.com/o/r/pull/9', '/wt/a');
    expect(calls).toHaveLength(1); // one round trip, not one per field
    expect(calls[0]!.args).toEqual([
      'pr',
      'view',
      'https://github.com/o/r/pull/9',
      '--json',
      'state,isDraft,headRefName,baseRefName,createdAt,mergedAt,comments,mergeable,mergeStateStatus,statusCheckRollup',
    ]);
    expect(calls[0]!.cwd).toBe('/wt/a');
    expect(detail).toEqual({
      status: 'merged',
      headRef: 'karst/feat/x',
      baseRef: 'develop',
      createdAt: '2026-07-23T08:00:00Z',
      mergedAt: '2026-07-28T09:30:00Z',
      comments: [{ author: 'ada', at: '2026-07-24T10:00:00Z', body: 'lgtm' }],
      checks: null,
      mergeBlock: 'unknown',
    });
  });

  // An open PR has no merge stamp — that is the normal case, not missing data.
  it('reads an open PR with no merge stamp and no comments', async () => {
    const gh: GhRunner = async () => ({
      stdout: viewJson({
        state: 'OPEN',
        isDraft: false,
        headRefName: 'karst/fix/y',
        baseRefName: 'main',
        createdAt: '2026-07-23T08:00:00Z',
        mergedAt: null,
        comments: [],
      }),
      exitCode: 0,
    });
    const detail = await fetchPrDetail(gh, '12', '/wt');
    expect(detail.status).toBe('open');
    expect(detail.mergedAt).toBeNull();
    // [] is a real answer ('no comments'), distinct from null ('gh never told us').
    expect(detail.comments).toEqual([]);
  });

  // Every failure is the all-unknown detail, never a throw and never a partial
  // guess: the caller keeps what it already knows rather than overwriting it.
  it('is the unknown detail when gh exits nonzero', async () => {
    const gh: GhRunner = async () => ({ stdout: '', exitCode: 1, stderr: 'bad auth' });
    expect(await fetchPrDetail(gh, '1', '/wt')).toEqual(UNKNOWN_PR_DETAIL);
  });

  it('is the unknown detail on output that is not JSON', async () => {
    const gh: GhRunner = async () => ({ stdout: 'not json', exitCode: 0 });
    expect(await fetchPrDetail(gh, '1', '/wt')).toEqual(UNKNOWN_PR_DETAIL);
  });

  // A gh that answers with fewer fields than asked (an older gh, a partial row)
  // must still yield a usable status — the missing parts are null, not invented.
  it('nulls fields gh omitted while keeping the state it did report', async () => {
    const gh: GhRunner = async () => ({ stdout: viewJson({ state: 'OPEN' }), exitCode: 0 });
    expect(await fetchPrDetail(gh, '1', '/wt')).toEqual({
      status: 'open',
      headRef: null,
      baseRef: null,
      createdAt: null,
      mergedAt: null,
      comments: null,
      checks: null,
      mergeBlock: 'unknown',
    });
  });

  // The three fields join the SAME round trip: a second probe could disagree
  // with the first (a PR merged between them would render as open with a
  // passing rollup), which is exactly why fetchPrDetail is a superset.
  it('normalizes the CI rollup and merge state from the same call', async () => {
    const gh: GhRunner = async () => ({
      stdout: viewJson({
        state: 'OPEN',
        isDraft: false,
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'Typecheck, build, unit, e2e',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            detailsUrl: 'https://github.com/AndrewHaluza/karst/actions/runs/35152829691/job/104985079741',
            workflowName: 'CI',
          },
        ],
      }),
      exitCode: 0,
    });
    const detail = await fetchPrDetail(gh, '384', '/wt');
    expect(detail.checks?.state).toBe('passing');
    expect(detail.mergeBlock).toBe('unknown');
  });

  it('reads a BLOCKED merge state as blocked', async () => {
    const gh: GhRunner = async () => ({
      stdout: viewJson({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }),
      exitCode: 0,
    });
    expect((await fetchPrDetail(gh, '9', '/wt')).mergeBlock).toBe('blocked');
  });

  it('leaves the rollup null when an older gh returns no statusCheckRollup key', async () => {
    // Not 'none': reporting "this PR has no CI" on a repo that has plenty is a
    // worse lie than reporting nothing.
    const gh: GhRunner = async () => ({ stdout: viewJson({ state: 'OPEN', isDraft: false }), exitCode: 0 });
    expect((await fetchPrDetail(gh, '9', '/wt')).checks).toBeNull();
  });
});

describe('mergePr', () => {
  it('merges by ref with the requested method, and never deletes the branch', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const gh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return { stdout: 'Merged pull request #9', exitCode: 0 };
    };
    const r = await mergePr(gh, 'https://github.com/o/r/pull/9', '/wt/a', 'squash');
    expect(calls[0]!.args).toEqual(['pr', 'merge', 'https://github.com/o/r/pull/9', '--squash']);
    expect(calls[0]!.cwd).toBe('/wt/a');
    // --delete-branch would destroy the ref the worktree row and the archive
    // restore both depend on.
    expect(calls[0]!.args).not.toContain('--delete-branch');
    expect(r.ok).toBe(true);
  });

  it('supports a merge commit and a rebase merge', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return { stdout: '', exitCode: 0 };
    };
    await mergePr(gh, '9', '/wt', 'merge');
    await mergePr(gh, '9', '/wt', 'rebase');
    expect(calls[0]).toContain('--merge');
    expect(calls[1]).toContain('--rebase');
  });

  // A refused merge — conflicts, failing checks, no permission — must come back
  // in gh's own words. This text is what the user is shown.
  it('reports the refusal in gh’s own words', async () => {
    const gh: GhRunner = async () => ({
      stdout: '',
      exitCode: 1,
      stderr: 'Pull request is not mergeable: the base branch policy prohibits the merge.',
    });
    const r = await mergePr(gh, '9', '/wt', 'squash');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('Pull request is not mergeable: the base branch policy prohibits the merge.');
  });

  it('falls back to stdout, then to the exit code, so a failure is never a bare blank', async () => {
    const quiet: GhRunner = async () => ({ stdout: 'X00003: not authorized', exitCode: 1 });
    expect((await mergePr(quiet, '9', '/wt', 'squash')).reason).toBe('X00003: not authorized');
    const silent: GhRunner = async () => ({ stdout: '', exitCode: 4, stderr: '' });
    expect((await mergePr(silent, '9', '/wt', 'squash')).reason).toBe('gh exit 4');
  });

  it('never throws when the runner itself rejects', async () => {
    const gh: GhRunner = async () => {
      throw new Error('spawn blew up');
    };
    const r = await mergePr(gh, '9', '/wt', 'squash');
    expect(r).toEqual({ ok: false, reason: 'spawn blew up' });
  });
});

describe('updatePrBase', () => {
  it('edits the PR base and reports success', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    expect(await updatePrBase(gh, '42', '/wt', 'epic/checkout')).toEqual({ ok: true, reason: '' });
    expect(calls).toEqual([['pr', 'edit', '42', '--base', 'epic/checkout']]);
  });

  it('reports gh’s refusal verbatim instead of throwing', async () => {
    const gh: GhRunner = async () => ({ stdout: '', stderr: 'no write access', exitCode: 1 });
    expect(await updatePrBase(gh, '42', '/wt', 'epic/checkout')).toEqual({
      ok: false,
      reason: 'no write access',
    });
  });

  it('turns a thrown runner into a reason', async () => {
    const gh: GhRunner = async () => {
      throw new Error('gh not installed');
    };
    expect((await updatePrBase(gh, '42', '/wt', 'main')).reason).toBe('gh not installed');
  });
});
