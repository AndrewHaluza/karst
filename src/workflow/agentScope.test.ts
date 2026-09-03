import { describe, expect, it } from 'vitest';
import { buildScopeBlock } from './agentScope.js';

describe('buildScopeBlock', () => {
  it('names the exact diff range when the base ref is known', () => {
    const text = buildScopeBlock('review', { baseRef: 'develop' }).join('\n');
    expect(text).toContain('`git diff origin/develop...HEAD`');
    expect(text).toContain('`git diff develop...HEAD`');
    // Each command is its own code span — a nested pair renders as a mangled
    // range the agent then has to guess at, which is what this block removes.
    for (const line of buildScopeBlock('review', { baseRef: 'develop' })) {
      expect((line.match(/`/g) ?? []).length % 2).toBe(0);
    }
  });

  // fu1: "review agent xterm log shows no changes, but diffs are present". The
  // ticket's branch is on the worktree row and the host knows it — the diff
  // range uses `origin/<branch>` so a stale local ref never produces an empty
  // diff; the rev-parse is only to confirm where the agent is.
  it('names the ticket branch in the diff range when it is known', () => {
    const text = buildScopeBlock('review', {
      baseRef: 'develop',
      branch: 'karst/feat/planner-issue-planner-issue',
    }).join('\n');
    expect(text).toContain('`git diff origin/develop...origin/karst/feat/planner-issue-planner-issue`');
    expect(text).toContain('`git diff develop...karst/feat/planner-issue-planner-issue`');
    expect(text).not.toContain('...HEAD');
    // The orientation names the branch instead of asserting "already on the
    // correct branch", and grants the ONE self-check that detects a wrong
    // checkout.
    expect(text).toContain('This ticket\'s branch is `karst/feat/planner-issue-planner-issue`');
    expect(text).toContain('git rev-parse --abbrev-ref HEAD');
    expect(text).not.toContain('already checked out on the correct branch');
    for (const line of buildScopeBlock('review', {
      baseRef: 'develop',
      branch: 'karst/feat/planner-issue-planner-issue',
    })) {
      expect((line.match(/`/g) ?? []).length % 2).toBe(0);
    }
  });

  // 869ej1nfb: "UAT tester xterm console shows no diffs if they're there". The
  // agent was dropped into a checkout on `develop` and read `git diff
  // develop...<branch>` as empty because the local branch ref was stale at the
  // base — then reported "no changes to exercise". A wrong checkout must be a
  // HARD STOP (report it, never conclude "nothing to test"), and an empty diff
  // must not read as proof of no changes.
  // When openChanges: true (the test lane default), the empty-diff guard still
  // tells the agent to verify with git status.
  it('treats a wrong checkout as a hard stop when the branch is known', () => {
    const text = buildScopeBlock('test', { baseRef: 'develop', branch: 'karst/x', openChanges: true }).join('\n');
    expect(text).toContain('it MUST print `karst/x`');
    expect(text).toContain('you are in the WRONG checkout');
    expect(text).toMatch(/do NOT `git diff`, do NOT conclude there are no changes/);
    expect(text).toContain('Report exactly one observation');
    expect(text).toContain('severity "critical"');
    expect(text).toContain('An empty `git diff` is NOT proof of no changes');
    expect(text).toContain('never output `[]` because a diff came back empty');
    expect(text).not.toContain('already checked out on the correct branch');
  });

  it('never claims a wrong checkout or empty-diff guard when no branch is known', () => {
    const text = buildScopeBlock('review', { baseRef: 'develop' }).join('\n');
    expect(text).not.toContain('WRONG checkout');
    expect(text).not.toContain('NOT proof of no changes');
    expect(text).not.toContain('Report exactly one observation');
    expect(text).toContain('already checked out on the correct branch');
  });

  it('still falls back to HEAD when no branch is known', () => {
    const text = buildScopeBlock('review', { baseRef: 'develop' }).join('\n');
    expect(text).toContain('...HEAD');
    expect(text).not.toContain('This ticket\'s branch is');
  });

  it('snapshotRef replaces the branch as the diff head', () => {
    const text = buildScopeBlock('review', {
      baseRef: 'develop',
      branch: 'feature-branch',
      snapshotRef: 'refs/karst/snapshot/7/abc123abc123abcd',
    }).join('\n');
    expect(text).toContain('`git diff origin/develop...refs/karst/snapshot/7/abc123abc123abcd`');
    expect(text).not.toContain('origin/feature-branch');
  });

  it('snapshotRef states uncommitted work is already included', () => {
    const text = buildScopeBlock('test', {
      baseRef: 'develop',
      snapshotRef: 'refs/karst/snapshot/7/abc123abc123abcd',
    }).join('\n');
    expect(text).toContain('ALREADY includes uncommitted and untracked work');
  });

  it('snapshotRef suppresses the committed-only wording', () => {
    const text = buildScopeBlock('review', {
      baseRef: 'develop',
      snapshotRef: 'refs/karst/snapshot/7/abc123abc123abcd',
    }).join('\n');
    expect(text).not.toContain('committed changes only');
  });

  it('snapshotRef wins over openChanges false', () => {
    const text = buildScopeBlock('review', {
      baseRef: 'develop',
      openChanges: false,
      snapshotRef: 'refs/karst/snapshot/7/abc123abc123abcd',
    }).join('\n');
    expect(text).toContain('`git diff origin/develop...refs/karst/snapshot/7/abc123abc123abcd`');
    expect(text).not.toContain('committed changes only');
  });

  it('snapshotRef swaps the empty-diff guard', () => {
    const text = buildScopeBlock('test', {
      baseRef: 'develop',
      branch: 'karst/x',
      snapshotRef: 'refs/karst/snapshot/7/abc123abc123abcd',
    }).join('\n');
    expect(text).toContain('That range is authoritative');
    expect(text).not.toContain('An empty `git diff` is NOT proof of no changes');
  });

  it('absent snapshotRef is byte-identical to today', () => {
    const omitted = buildScopeBlock('review', { baseRef: 'develop', branch: 'karst/x' }).join('\n');
    const explicitUndefined = buildScopeBlock('review', {
      baseRef: 'develop',
      branch: 'karst/x',
      snapshotRef: undefined,
    }).join('\n');
    expect(explicitUndefined).toBe(omitted);
  });

  it('blank snapshotRef is treated as absent', () => {
    const text = buildScopeBlock('review', {
      baseRef: 'develop',
      branch: 'karst/x',
      snapshotRef: '   ',
    }).join('\n');
    expect(text).toContain('origin/develop...origin/karst/x');
    expect(text).not.toContain('refs/karst/snapshot');
  });

  it('never interpolates a missing base ref', () => {
    const text = buildScopeBlock('test').join('\n');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('origin/null');
  });

  it('openChanges: false removes the git status verification from the empty-diff guard', () => {
    // When openChanges is false (default), the diff range is committed-only.
    // An empty committed diff IS proof there are no committed changes to review.
    // The agent must NOT be told to run `git status --porcelain` to look for
    // uncommitted work — that would defeat the purpose of openChanges: false.
    const text = buildScopeBlock('review', {
      baseRef: 'develop',
      branch: 'karst/x',
      openChanges: false,
    }).join('\n');
    expect(text).toContain('committed changes only');
    expect(text).not.toContain('git status --porcelain');
    expect(text).not.toContain('An empty `git diff` is NOT proof of no changes');
    // Instead, the guard should say an empty committed diff means no changes to review
    expect(text).toContain('EMPTY');
    expect(text.toLowerCase()).toMatch(/no changes to review/);
  });

  it('openChanges: true keeps the git status verification in the empty-diff guard', () => {
    // When openChanges is true, the agent should also check uncommitted work.
    // The empty-diff guard should still tell the agent to verify with git status.
    const text = buildScopeBlock('review', {
      baseRef: 'develop',
      branch: 'karst/x',
      openChanges: true,
    }).join('\n');
    expect(text).toContain('plus any uncommitted work');
    expect(text).toContain('git status --porcelain');
    expect(text).toContain('An empty `git diff` is NOT proof of no changes');
  });

  it('forbids the repo-wide reconnaissance both lanes were paying for', () => {
    const text = buildScopeBlock('review', { baseRef: 'main' }).join('\n');
    expect(text).toContain('git worktree list');
    expect(text).toContain('orchestration tool that launched you');
    expect(text).toMatch(/Do NOT run repository-wide reconnaissance/);
    expect(text).toMatch(/Do NOT re-derive/i);
  });

  it('names the gates that already passed so the agent does not re-run them', () => {
    const text = buildScopeBlock('test', {
      baseRef: 'main',
      gatesPassed: ['test:unit (extention)', 'test:e2e (extention)'],
    }).join('\n');
    expect(text).toContain('test:unit (extention), test:e2e (extention)');
    expect(text).toContain('Do NOT re-run them');
  });

  it('omits the gate line entirely when no gate is named', () => {
    const text = buildScopeBlock('test', { baseRef: 'main' }).join('\n');
    expect(text).not.toContain('already ran and PASSED');
  });
});
