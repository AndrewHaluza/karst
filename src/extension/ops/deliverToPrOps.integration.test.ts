import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUndeliveredTracker, deliverToPr, refreshUndelivered, type CountDeps, type DeliverDeps } from './deliverToPrOps.js';
import type { DeliverPr, DeliverTargets } from '../../workflow/deliverState.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let root: string;
let origin: string;
let wt: string;
let clone: string;
let pr: DeliverPr;

const commit = (cwd: string, name: string): void => {
  writeFileSync(join(cwd, name), name);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-m', name);
};

/** Real-git seams: the sandbox clone is a sibling repo whose branch is fetched into the worktree. */
const countDeps: CountDeps = {
  git: async (cwd, args) => {
    try {
      return { code: 0, stdout: git(cwd, ...args) };
    } catch {
      return { code: 1, stdout: '' };
    }
  },
  sandboxRef: async (cwd) => {
    git(cwd, 'fetch', clone, 'feat/x');
    return 'FETCH_HEAD';
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deliver-'));
  origin = join(root, 'origin.git');
  wt = join(root, 'wt');
  clone = join(root, 'clone');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', origin, wt], { stdio: 'ignore' });
  git(wt, 'checkout', '-b', 'feat/x');
  commit(wt, 'base');
  git(wt, 'push', 'origin', 'feat/x');
  execFileSync('git', ['clone', '-b', 'feat/x', wt, clone], { stdio: 'ignore' });
  pr = { repo: 'r', number: 1, branch: 'feat/x', cwd: wt };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const targets: () => DeliverTargets = () => ({ available: true, prs: [pr] });

describe('deliver to PR (real git)', () => {
  it('counts sandbox-only commits, then a fast-forward sync + push puts them on the PR', async () => {
    commit(clone, 'fix1');
    commit(clone, 'fix2');
    const tracker = createUndeliveredTracker();
    await refreshUndelivered(tracker, 1, targets(), countDeps);
    expect(tracker.get(1)).toEqual({ hostAhead: 0, sandboxAhead: 2 });

    const d: DeliverDeps = {
      targets,
      agentActive: () => false,
      ensureSynced: async () => { git(wt, 'merge', '--ff-only', 'FETCH_HEAD'); return { ok: true }; },
      blocked: vi.fn(async () => {}),
      runShip: async () => { git(wt, 'push', 'origin', 'feat/x'); },
      reprobe: vi.fn(async () => {}),
      info: vi.fn(), error: vi.fn(), logError: vi.fn(), afterServerChange: vi.fn(),
    };
    await deliverToPr(d);
    expect(git(origin, 'rev-parse', 'feat/x')).toBe(git(clone, 'rev-parse', 'HEAD'));
    expect(d.reprobe).toHaveBeenCalledOnce();
    await refreshUndelivered(tracker, 1, targets(), countDeps);
    expect(tracker.get(1)).toBeUndefined();
  });

  it('counts host-only commits and pushes them without any sandbox', async () => {
    commit(wt, 'host1');
    const tracker = createUndeliveredTracker();
    await refreshUndelivered(tracker, 1, targets(), { ...countDeps, sandboxRef: async () => null });
    expect(tracker.get(1)).toEqual({ hostAhead: 1, sandboxAhead: 0 });
  });

  it('a diverged clone stops before the push and raises the blocker', async () => {
    commit(clone, 'theirs');
    commit(wt, 'ours');
    const before = git(origin, 'rev-parse', 'feat/x');
    const blocked = vi.fn(async () => {});
    const runShip = vi.fn(async () => {});
    await deliverToPr({
      targets, agentActive: () => false, blocked, runShip, reprobe: vi.fn(async () => {}),
      ensureSynced: async () => {
        try { git(wt, 'fetch', clone, 'feat/x'); git(wt, 'merge', '--ff-only', 'FETCH_HEAD'); return { ok: true }; }
        catch { return { ok: false, reason: 'diverged' } as never; }
      },
      info: vi.fn(), error: vi.fn(), logError: vi.fn(), afterServerChange: vi.fn(),
    });
    expect(blocked).toHaveBeenCalledWith('diverged', false);
    expect(runShip).not.toHaveBeenCalled();
    expect(git(origin, 'rev-parse', 'feat/x')).toBe(before);
  });
});
