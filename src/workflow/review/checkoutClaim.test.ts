import { describe, it, expect, vi } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import type { FindingInput } from '../../store/reviewFindings.js';
import { isWrongCheckoutClaim, verifyCheckout, dropDisprovenCheckoutClaims } from './checkoutClaim.js';

const claim: FindingInput = {
  repo: '/repo',
  severity: 'critical',
  title: 'wrong checkout',
  detail: 'Expected branch karst/feat/x but HEAD is on develop.',
  source: 'agent',
};

const real: FindingInput = {
  repo: '/repo',
  severity: 'high',
  title: 'unbounded loop in reap',
  detail: '…',
  source: 'agent',
};

/** A git runner answering `rev-parse --abbrev-ref HEAD` with `branch`. */
function gitOn(branch: string, exitCode = 0): GitRunner {
  return vi.fn(async () => ({ stdout: `${branch}\n`, stderr: '', exitCode })) as unknown as GitRunner;
}

describe('isWrongCheckoutClaim', () => {
  it('recognises the claim the scope block asks for, whatever the casing', () => {
    expect(isWrongCheckoutClaim(claim)).toBe(true);
    expect(isWrongCheckoutClaim({ ...claim, title: 'Wrong Checkout' })).toBe(true);
    expect(isWrongCheckoutClaim({ ...claim, title: '  wrong  checkout ' })).toBe(true);
  });

  it('does not swallow an unrelated finding that merely mentions a branch', () => {
    expect(isWrongCheckoutClaim(real)).toBe(false);
    expect(
      isWrongCheckoutClaim({ ...real, title: 'checkout logic reads the wrong ref' }),
    ).toBe(false);
  });
});

describe('verifyCheckout', () => {
  it('says `matches` when HEAD is the ticket branch', async () => {
    await expect(verifyCheckout(gitOn('karst/feat/x'), '/wt', 'karst/feat/x')).resolves.toBe(
      'matches',
    );
  });

  it('says `differs` when HEAD is another branch', async () => {
    await expect(verifyCheckout(gitOn('develop'), '/wt', 'karst/feat/x')).resolves.toBe('differs');
  });

  it('says `unknown` when git cannot answer — never `matches`', async () => {
    // A failed probe must not be read as proof: the claim then stands.
    await expect(verifyCheckout(gitOn('', 128), '/wt', 'karst/feat/x')).resolves.toBe('unknown');
    const thrower = vi.fn(async () => {
      throw new Error('spawn git ENOENT');
    }) as unknown as GitRunner;
    await expect(verifyCheckout(thrower, '/wt', 'karst/feat/x')).resolves.toBe('unknown');
  });

  it('asks git in the WORKTREE, for the branch name only', async () => {
    const git = gitOn('karst/feat/x');
    await verifyCheckout(git, '/wt', 'karst/feat/x');
    expect(git).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD'], '/wt');
  });
});

describe('dropDisprovenCheckoutClaims', () => {
  it('drops the claim when the host can prove the checkout is right', () => {
    const warn = vi.fn();
    const kept = dropDisprovenCheckoutClaims([claim, real], 'matches', {
      branch: 'karst/feat/x',
      repo: '/repo',
      warn,
    });
    expect(kept).toEqual([real]);
    // Reported, never silent: a dropped critical must be visible, or the next
    // reader cannot tell a guard from a lost finding.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wrong checkout'));
  });

  it('keeps the claim when the checkout really differs', () => {
    expect(
      dropDisprovenCheckoutClaims([claim], 'differs', { branch: 'karst/feat/x', repo: '/repo' }),
    ).toEqual([claim]);
  });

  it('keeps the claim when the host could not check', () => {
    expect(
      dropDisprovenCheckoutClaims([claim], 'unknown', { branch: 'karst/feat/x', repo: '/repo' }),
    ).toEqual([claim]);
  });

  it('returns a new array and never mutates the input', () => {
    const input: FindingInput[] = [claim, real];
    const kept = dropDisprovenCheckoutClaims(input, 'matches', {
      branch: 'karst/feat/x',
      repo: '/repo',
    });
    expect(input).toHaveLength(2);
    expect(kept).not.toBe(input);
  });
});
