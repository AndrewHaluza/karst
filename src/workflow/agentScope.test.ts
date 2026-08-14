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

  it('still falls back to HEAD when no branch is known', () => {
    const text = buildScopeBlock('review', { baseRef: 'develop' }).join('\n');
    expect(text).toContain('...HEAD');
    expect(text).not.toContain('This ticket\'s branch is');
  });

  it('never interpolates a missing base ref', () => {
    const text = buildScopeBlock('test').join('\n');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('origin/null');
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
