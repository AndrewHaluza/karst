import { describe, it, expect, vi } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import type { GhRunner } from '../../integrations/github.js';
import {
  isRemoteServerError,
  openPrWithServerErrorRetry,
  PR_SERVER_ERROR_RETRY_DELAYS_MS,
  pushWithServerErrorRetry,
  PUSH_SERVER_ERROR_RETRY_DELAY_MS,
} from './shipPushRecovery.js';

const SERVER_ERROR =
  'remote: fatal error in commit_refs_rules\n ! [remote rejected] HEAD -> karst/x (failure)\nerror: failed to push some refs';

function failing(stderr: string) {
  return { stdout: '', stderr, exitCode: 1 };
}
const OK = { stdout: '', stderr: '', exitCode: 0 };

describe('isRemoteServerError', () => {
  it('is true for the real GitHub server error text', () => {
    expect(isRemoteServerError(new Error(SERVER_ERROR))).toBe(true);
  });

  it.each([
    ['non-fast-forward', '! [rejected] HEAD -> karst/x (non-fast-forward)'],
    ['hook declined', '! [remote rejected] HEAD -> karst/x (pre-receive hook declined)'],
    ['stale lease', '! [rejected] HEAD -> karst/x (stale info)'],
    ['network error', 'fatal: unable to access: Could not resolve host: github.com'],
    ['timeout', 'git push timed out after 120000ms'],
  ])('is false for %s', (_name, text) => {
    expect(isRemoteServerError(new Error(text))).toBe(false);
  });

  it('accepts a non-Error value', () => {
    expect(isRemoteServerError(SERVER_ERROR)).toBe(true);
  });
});

describe('pushWithServerErrorRetry', () => {
  const lease = { ref: 'karst/x', expected: 'a'.repeat(40) };

  function setup(results: Array<typeof OK>) {
    const pushes: string[][] = [];
    const git: GitRunner = async (args) => {
      pushes.push(args);
      return results[pushes.length - 1] ?? OK;
    };
    const wait = vi.fn(async () => {});
    const onRetry = vi.fn();
    return { git, pushes, wait, onRetry };
  }

  it('retries once after the delay and resolves when the second push passes', async () => {
    const { git, pushes, wait, onRetry } = setup([failing(SERVER_ERROR), OK]);
    await pushWithServerErrorRetry(git, '/wt', {}, { wait, onRetry });
    expect(pushes).toHaveLength(2);
    expect(wait).toHaveBeenCalledExactlyOnceWith(PUSH_SERVER_ERROR_RETRY_DELAY_MS);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('uses a delay of 30 seconds', () => {
    expect(PUSH_SERVER_ERROR_RETRY_DELAY_MS).toBe(30_000);
  });

  it('throws the error of the second attempt when both fail', async () => {
    const second = SERVER_ERROR.replace('commit_refs_rules', 'second_rules');
    const { git, pushes, wait } = setup([failing(SERVER_ERROR), failing(second)]);
    await expect(pushWithServerErrorRetry(git, '/wt', {}, { wait, onRetry: vi.fn() })).rejects.toThrow(
      /second_rules/,
    );
    expect(pushes).toHaveLength(2);
  });

  it('makes no third attempt and does not wait again', async () => {
    const { git, pushes, wait } = setup([failing(SERVER_ERROR), failing(SERVER_ERROR), OK]);
    await expect(pushWithServerErrorRetry(git, '/wt', {}, { wait, onRetry: vi.fn() })).rejects.toThrow();
    expect(pushes).toHaveLength(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('does not retry or wait on a non-fast-forward error', async () => {
    const { git, pushes, wait, onRetry } = setup([failing('! [rejected] HEAD (non-fast-forward)')]);
    await expect(pushWithServerErrorRetry(git, '/wt', {}, { wait, onRetry })).rejects.toThrow(
      /non-fast-forward/,
    );
    expect(pushes).toHaveLength(1);
    expect(wait).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('sends the same lease on the second attempt', async () => {
    const { git, pushes, wait } = setup([failing(SERVER_ERROR), OK]);
    await pushWithServerErrorRetry(git, '/wt', { forceWithLease: lease }, { wait, onRetry: vi.fn() });
    const arg = `--force-with-lease=${lease.ref}:${lease.expected}`;
    expect(pushes.map((a) => a.find((x) => x.startsWith('--force-with-lease')))).toEqual([arg, arg]);
  });
});

describe('openPrWithServerErrorRetry', () => {
  const PR_URL = 'https://github.com/o/r/pull/7';
  const BAD_GATEWAY = 'HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)';
  const GRAPHQL = 'GraphQL: Something went wrong while executing your query. Please include `AB:CD` when reporting this issue.';
  const opts = { cwd: '/wt', title: 't', body: 'b', base: 'develop', head: 'karst/x' };

  /** gh: `pr create` answers from `creates` in order (then a URL); `pr view` answers from `views` (then "no PR"). */
  function setup(creates: string[], views: Array<string | null> = []) {
    const calls: string[][] = [];
    let c = 0;
    let v = 0;
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[1] === 'view') {
        const url = views[v++] ?? null;
        return url === null
          ? { stdout: '', stderr: 'no pull requests found', exitCode: 1 }
          : { stdout: JSON.stringify({ number: 9, url, state: 'OPEN', body: '' }), exitCode: 0 };
      }
      const err = creates[c++];
      return err === undefined ? { stdout: PR_URL, exitCode: 0 } : { stdout: '', stderr: err, exitCode: 1 };
    };
    const wait = vi.fn(async () => {});
    const onRetry = vi.fn();
    const count = (sub: string) => calls.filter((a) => a[1] === sub).length;
    return { gh, wait, onRetry, count };
  }

  it('uses delays of 15 and 45 seconds', () => {
    expect(PR_SERVER_ERROR_RETRY_DELAYS_MS).toEqual([15_000, 45_000]);
  });

  it('creates the PR on the third attempt after two server errors', async () => {
    const { gh, wait, onRetry, count } = setup([BAD_GATEWAY, BAD_GATEWAY]);
    const pr = await openPrWithServerErrorRetry(gh, opts, { wait, onRetry });
    expect(pr).toEqual({ url: PR_URL, number: 7, adopted: false });
    expect(wait.mock.calls).toEqual([[15_000], [45_000]]);
    expect(onRetry.mock.calls).toEqual([
      [1, 2, 15_000],
      [2, 2, 45_000],
    ]);
    expect(count('create')).toBe(3);
    expect(count('view')).toBe(2);
  });

  it('adopts the PR the probe finds and does not create again', async () => {
    const found = 'https://github.com/o/r/pull/9';
    const { gh, wait, onRetry, count } = setup([GRAPHQL], [found]);
    const pr = await openPrWithServerErrorRetry(gh, opts, { wait, onRetry });
    expect(pr).toEqual({ url: found, number: 9, adopted: true });
    expect(count('create')).toBe(1);
    expect(wait).toHaveBeenCalledExactlyOnceWith(15_000);
  });

  it('throws the error of the last attempt, unchanged, after 3 server errors', async () => {
    const third = 'HTTP 503: 503 Service Unavailable (third)';
    const { gh, wait, onRetry, count } = setup([BAD_GATEWAY, GRAPHQL, third]);
    await expect(openPrWithServerErrorRetry(gh, opts, { wait, onRetry })).rejects.toThrow(
      'gh pr create failed in /wt: HTTP 503: 503 Service Unavailable (third)',
    );
    expect(count('create')).toBe(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('stops at a non-server error after a retry', async () => {
    const { gh, wait, onRetry, count } = setup([BAD_GATEWAY, 'HTTP 401: Bad credentials']);
    await expect(openPrWithServerErrorRetry(gh, opts, { wait, onRetry })).rejects.toThrow(/HTTP 401/);
    expect(count('create')).toBe(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('fails at once on a non-server error, with no wait and no probe', async () => {
    const { gh, wait, onRetry, count } = setup(['HTTP 422: Validation Failed']);
    await expect(openPrWithServerErrorRetry(gh, opts, { wait, onRetry })).rejects.toThrow(/HTTP 422/);
    expect(wait).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(count('view')).toBe(0);
  });

  it('retries a server error that the gh runner throws as a string', async () => {
    let creates = 0;
    const gh: GhRunner = async (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      if (creates++ === 0) throw BAD_GATEWAY;
      return { stdout: PR_URL, exitCode: 0 };
    };
    const wait = vi.fn(async () => {});
    const pr = await openPrWithServerErrorRetry(gh, opts, { wait, onRetry: vi.fn() });
    expect(pr.adopted).toBe(false);
    expect(creates).toBe(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('retries a server error that the gh runner throws', async () => {
    let creates = 0;
    const gh: GhRunner = async (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      if (creates++ === 0) throw new Error(BAD_GATEWAY);
      return { stdout: PR_URL, exitCode: 0 };
    };
    const pr = await openPrWithServerErrorRetry(gh, opts, { wait: vi.fn(async () => {}), onRetry: vi.fn() });
    expect(pr.adopted).toBe(false);
    expect(creates).toBe(2);
  });
});
