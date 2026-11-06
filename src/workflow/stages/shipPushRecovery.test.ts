import { describe, it, expect, vi } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import {
  isRemoteServerError,
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
