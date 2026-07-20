import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { listPrsByTicket } from '../../store/dashboard.js';
import { transition } from '../machine.js';
import { shipTicket } from './ship.js';
import type { GhRunner } from '../../integrations/github.js';
import type { GitRunner } from '../../integrations/git.js';
import type { AgentAdapter } from '../../agent/adapter.js';

function seedWorktree(store: Store, ticketId: number, repo: string, path: string): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, ?, 'karst/x', 'develop', 'inherited')`,
    )
    .run(ticketId, repo, path);
}

function walkToShip(store: Store, id: number): void {
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
  transition(store, id, 'uat', { kind: 'passed' });
  transition(store, id, 'review', { kind: 'passed' });
}

/**
 * Counts `pr create` only, and answers `pr view` with "no PR for this branch"
 * (gh's nonzero exit). Ship probes before it creates, so a fake that counted
 * every gh call would conflate the probe with the thing under test.
 */
function fakeGh(): { gh: GhRunner; calls: number } {
  let calls = 0;
  const gh: GhRunner = async (args) => {
    if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
    calls++;
    return { stdout: `https://github.com/o/r/pull/${calls}`, exitCode: 0 };
  };
  return {
    gh,
    get calls() {
      return calls;
    },
  } as { gh: GhRunner; calls: number };
}

/** gh with an already-open PR on the branch — the state that used to fail ship. */
function ghWithExistingPr(url: string): { gh: GhRunner; args: string[][] } {
  const args: string[][] = [];
  const gh: GhRunner = async (a) => {
    args.push(a);
    if (a[1] === 'view') {
      return { stdout: JSON.stringify({ number: 18, url, state: 'OPEN' }), exitCode: 0 };
    }
    return { stdout: '', stderr: `a pull request for branch "karst/x" already exists:\n${url}`, exitCode: 1 };
  };
  return { gh, args };
}

/** Records every git invocation; succeeds by default. */
function fakeGit(): { git: GitRunner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { git, calls };
}

function fakeAdapter(): AgentAdapter {
  return {
    runHeadless: async () => ({ sessionId: 's', verdict: null, raw: 'Generated PR body.' }),
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    requiredBinary: 'claude',
    capabilities: { httpHooks: true, resume: true },
  };
}

describe('shipTicket', () => {
  let store: Store;
  let id: number;
  let dir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'PROJ-1', title: 'add search' }).id;
    dir = mkdtempSync(join(tmpdir(), 'karst-ship-'));
    walkToShip(store, id);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // `gh pr create` refuses a branch that exists only locally: "you must first push
  // the current branch to a remote". Every karst ticket works on a fresh worktree
  // branch, so the branch is ALWAYS local-only — ship could never have opened a
  // single PR without this.
  it('pushes the worktree branch before opening its PR', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const order: string[] = [];
    const git: GitRunner = async (args, cwd) => {
      order.push(`git ${args[0]}`);
      expect(cwd).toBe(join(dir, 'fe'));
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const gh: GhRunner = async (args) => {
      order.push(`gh pr ${args[1]}`);
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      return { stdout: 'https://github.com/o/r/pull/1', exitCode: 0 };
    };

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git);

    // The probe sits after the push, not before it: an existing PR must still
    // receive the branch's new commits. Adopting is not skipping.
    expect(order).toEqual(['git status', 'git push', 'gh pr view', 'gh pr create']);
  });

  // The reported bug: impl/uat/review all passed but the work was never committed,
  // so the branch had no commits and gh died with "No commits between main and
  // karst/…". Ship commits what the agent left behind rather than pushing nothing.
  it('commits uncommitted worktree changes before pushing', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const git: GitRunner = async (args) => ({
      stdout: args[0] === 'status' ? ' M src/a.ts\n' : '',
      stderr: '',
      exitCode: 0,
    });
    const calls: string[][] = [];
    const recording: GitRunner = async (args, cwd) => {
      calls.push(args);
      return git(args, cwd);
    };
    const { gh } = fakeGh();

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), recording);

    expect(calls).toEqual([
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'add search'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  // A dirty tree that cannot be committed (hook rejects, gpg signing fails) means
  // the PR would be empty. Fail loudly at ship rather than open a no-op PR.
  it('a failed commit aborts the ship and never calls gh', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') return { stdout: ' M src/a.ts\n', stderr: '', exitCode: 0 };
      if (args[0] === 'commit')
        return { stdout: '', stderr: 'error: pre-commit hook rejected', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const { gh, ...ghCalls } = fakeGh();

    await expect(shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git)).rejects.toThrow(
      /pre-commit hook rejected/,
    );

    expect(ghCalls.calls).toBe(0);
    const ship = getTicket(store, id).stages.find((s) => s.stageKey === 'ship');
    expect(ship?.status).toBe('failed');
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('pushes each repo’s own worktree, and sets upstream so the PR has a head', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
    const { gh } = fakeGh();
    const { git, calls } = fakeGit();

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git);

    expect([...new Set(calls.map((c) => c.cwd))].sort()).toEqual([join(dir, 'be'), join(dir, 'fe')]);
    // Clean worktrees (the fake reports no changes) → status only, then push.
    for (const c of calls) expect(c.args[0]).toMatch(/^(status|push)$/);
    expect(calls.filter((c) => c.args[0] === 'push').map((c) => c.args)).toEqual([
      ['push', '-u', 'origin', 'HEAD'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
  });

  // A push that fails means the PR cannot open. Opening it anyway is impossible;
  // asking a model for a description first would just burn a call.
  it('a failed push aborts the ship, records why, and never calls gh', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const git: GitRunner = async () => ({
      stdout: '',
      stderr: "fatal: 'origin' does not appear to be a git repository",
      exitCode: 128,
    });
    const { gh, ...ghCalls } = fakeGh();

    await expect(shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git)).rejects.toThrow(
      /does not appear to be a git repository/,
    );

    expect(ghCalls.calls).toBe(0);
    const ship = getTicket(store, id).stages.find((s) => s.stageKey === 'ship');
    expect(ship?.status).toBe('failed');
    expect(ship?.verdict).toContain('origin');
    // Ship has no `failed` edge: a ticket that did not ship must not move.
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  // Idempotency (§5.3): a re-run must not re-push a repo whose PR already opened.
  it('does not push a repo that already has an open PR', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    store.db
      .prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 1, 'u', 'open')")
      .run(id, '/repo/frontend');
    const { gh } = fakeGh();
    const { git, calls } = fakeGit();

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git);

    expect(calls).toEqual([]);
  });

  it('opens one PR per hot repo and writes rows to prs', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
    const { gh } = fakeGh();
    const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    expect(res.prs).toHaveLength(2);
    expect(listPrsByTicket(store, id)).toHaveLength(2);
  });

  it('each PR carries an agent-generated description', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const gh: GhRunner = async (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      // body flag value is the generated prose
      const bodyIdx = args.indexOf('--body');
      expect(args[bodyIdx + 1]).toContain('Generated PR body');
      return { stdout: 'https://github.com/o/r/pull/9', exitCode: 0 };
    };
    const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    expect(res.prs[0]!.url).toBe('https://github.com/o/r/pull/9');
  });

  it('records why a failed ship failed, on the stage the dashboard reads', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const gh: GhRunner = async () => ({ stdout: '', stderr: 'gh: not authenticated', exitCode: 1 });

    await expect(shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git)).rejects.toThrow();

    // Ship has no `failed` edge (graph.ts) — the ticket must NOT move. It parks
    // at ship, red, carrying the reason, instead of silently sitting at "running"
    // with the truth only in the dev output channel.
    const t = getTicket(store, id);
    expect(t.stageCurrent).toBe('ship');
    const ship = t.stages.find((s) => s.stageKey === 'ship')!;
    expect(ship.status).toBe('failed');
    expect(ship.verdict).toContain('not authenticated');
  });

  it('clears a prior failure when a retried ship succeeds', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const bad: GhRunner = async () => ({ stdout: '', stderr: 'boom', exitCode: 1 });
    await expect(shipTicket(store, { ticketId: id }, bad, fakeAdapter(), fakeGit().git)).rejects.toThrow();

    const { gh } = fakeGh();
    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);

    const t = getTicket(store, id);
    expect(t.stageCurrent).toBe('done');
    expect(t.stages.find((s) => s.stageKey === 'ship')!.verdict).toBeNull();
  });

  // The reported bug: a PR opened by hand (or by a run whose db row was lost) made
  // ship fail forever — gh said "a pull request for branch … already exists" and
  // `openPr` threw before the `prs` insert, so the local guard could never absorb
  // it and every retry died identically, with ship having no `failed` edge to
  // advance out of. An open PR is what ship is FOR; it is not a failure.
  describe('when the branch already has an open PR on GitHub', () => {
    const URL = 'https://github.com/AndrewHaluza/karst/pull/18';

    it('adopts it instead of failing, and finishes the ship', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh, args } = ghWithExistingPr(URL);

      const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);

      expect(args.some((a) => a[1] === 'create')).toBe(false);
      expect(res.prs).toEqual([{ repo: '/repo/frontend', number: 18, url: URL }]);
      expect(getTicket(store, id).stageCurrent).toBe('done');
    });

    // The insert is what closes the permanence bug: it is why a later re-run is
    // absorbed by the local guard rather than probing GitHub again.
    it('records the adopted PR, so a re-run needs no gh at all', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = ghWithExistingPr(URL);
      await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);

      expect(listPrsByTicket(store, id)).toHaveLength(1);

      const { git, calls } = fakeGit();
      const second = ghWithExistingPr(URL);
      await shipTicket(store, { ticketId: id }, second.gh, fakeAdapter(), git);

      expect(second.args).toEqual([]);
      expect(calls).toEqual([]);
      expect(listPrsByTicket(store, id)).toHaveLength(1);
    });

    // Probing before the create is what buys this: `describePr` runs BEFORE
    // `openPr`, so rescuing after the failure would still have paid a model call
    // per repo to write prose for a PR that already exists.
    it('asks no model for a description it cannot use', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = ghWithExistingPr(URL);
      let headless = 0;
      const adapter: AgentAdapter = { ...fakeAdapter(), runHeadless: async () => {
        headless++;
        return { sessionId: 's', verdict: null, raw: 'x' };
      } };

      await shipTicket(store, { ticketId: id }, gh, adapter, fakeGit().git);

      expect(headless).toBe(0);
    });
  });

  it('advances the stage to done on success', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const { gh } = fakeGh();
    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  it('is idempotent — a re-run skips repos with an existing open PR (no duplicate)', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
    let calls = 0;
    const gh: GhRunner = async (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      calls++;
      return { stdout: `https://github.com/o/r/pull/${calls}`, exitCode: 0 };
    };
    // First ship opens both PRs (2 gh calls).
    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    expect(calls).toBe(2);
    expect(listPrsByTicket(store, id)).toHaveLength(2);

    // Re-run (crash-recovery re-drive): no new gh calls, no duplicate rows.
    const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    expect(calls).toBe(2);
    expect(listPrsByTicket(store, id)).toHaveLength(2);
    expect(res.prs).toHaveLength(2);
  });
});
