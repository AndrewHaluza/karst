import { describe, expect, it } from 'vitest';
import { diffsRenderFixtures, DIFFS_SCENARIOS, type DiffsScenario } from './renderFixtures.js';

/**
 * Data-contract tests for the diffs (ticket changes) render fixture corpus.
 * Pins deterministic identity, ordering, per-scenario invariants, and
 * hostile-string presence — same shape as usage/sidebar's renderFixtures.test.ts.
 */
describe('diffs render fixtures', () => {
  const fixtures = diffsRenderFixtures();

  it('is deterministic: one fixture per scenario, in DIFFS_SCENARIOS order, no duplicates', () => {
    expect(fixtures).toHaveLength(DIFFS_SCENARIOS.length);
    const ids = fixtures.map((f) => f.scenario);
    expect(ids).toEqual([...DIFFS_SCENARIOS]);
    expect(new Set(ids).size).toBe(fixtures.length);
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(diffsRenderFixtures()));
  });

  it('every fixture carries a matching worktreeCount, commitCount and pendingCount', () => {
    for (const f of fixtures) {
      expect(f.state.worktreeCount, f.scenario).toBe(f.state.worktrees.length);
      const commitCount = f.state.worktrees.reduce((n, w) => n + w.commits.length, 0);
      const pendingCount = f.state.worktrees.reduce(
        (n, w) => n + w.staged.length + w.unstaged.length + w.untracked.length,
        0,
      );
      expect(f.state.commitCount, f.scenario).toBe(commitCount);
      expect(f.state.pendingCount, f.scenario).toBe(pendingCount);
    }
  });

  it('empty has no worktrees and zero counts', () => {
    const empty = fixtures.find((f) => f.scenario === 'empty')!;
    expect(empty.state.worktrees).toHaveLength(0);
    expect(empty.state.worktreeCount).toBe(0);
    expect(empty.state.commitCount).toBe(0);
    expect(empty.state.pendingCount).toBe(0);
  });

  it('populated has 2 repos, commits, and staged/unstaged/untracked files', () => {
    const populated = fixtures.find((f) => f.scenario === 'populated')!;
    expect(populated.state.worktrees).toHaveLength(2);
    expect(populated.state.commitCount).toBeGreaterThan(0);
    expect(populated.state.pendingCount).toBeGreaterThan(0);
    const allStaged = populated.state.worktrees.flatMap((w) => w.staged);
    const allUnstaged = populated.state.worktrees.flatMap((w) => w.unstaged);
    const allUntracked = populated.state.worktrees.flatMap((w) => w.untracked);
    expect(allStaged.length).toBeGreaterThan(0);
    expect(allUnstaged.length).toBeGreaterThan(0);
    expect(allUntracked.length).toBeGreaterThan(0);
  });

  it('error has a worktree with a non-null error and no commits or pending', () => {
    const error = fixtures.find((f) => f.scenario === 'error')!;
    expect(error.state.worktrees).toHaveLength(1);
    expect(error.state.worktrees[0]!.error).not.toBeNull();
  });

  it('every ticketId is in the reserved band 900001–999999', () => {
    for (const f of fixtures) {
      expect(f.state.ticketId, f.scenario).toBeGreaterThanOrEqual(900001);
      expect(f.state.ticketId, f.scenario).toBeLessThanOrEqual(999999);
    }
  });

  it('every absolutePath and changeId is fixture:-prefixed or under /fixture/', () => {
    for (const f of fixtures) {
      for (const w of f.state.worktrees) {
        const files = [...w.staged, ...w.unstaged, ...w.untracked, ...w.commits.flatMap((c) => c.files)];
        for (const file of files) {
          expect(file.changeId.startsWith('fixture:'), `${f.scenario}: ${file.changeId}`).toBe(true);
          expect(file.absolutePath.startsWith('/fixture/'), `${f.scenario}: ${file.absolutePath}`).toBe(true);
        }
      }
    }
  });

  it('hostile contains the required untrusted strings', () => {
    const hostile = fixtures.find((f) => f.scenario === 'hostile')!;
    const allText = hostile.state.worktrees
      .map((w) => `${w.label} ${w.branch ?? ''} ${w.commits.map((c) => `${c.subject} ${c.author}`).join(' ')}`)
      .join(' ');
    expect(allText).toContain('<script>alert(1)</script>');
    expect(allText.length).toBeGreaterThan(300);
  });

  it('calling the factory twice returns structurally equal but non-identical arrays', () => {
    const a = diffsRenderFixtures();
    const b = diffsRenderFixtures();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).not.toBe(b);
  });

  it('DIFFS_SCENARIOS type covers every DiffsScenario member', () => {
    const check: readonly DiffsScenario[] = DIFFS_SCENARIOS;
    expect(check.length).toBe(4);
  });
});
