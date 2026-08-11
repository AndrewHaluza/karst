import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket, updateTicketFields } from '../../store/tickets.js';
import { listPrsByTicket } from '../../store/dashboard.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { listShipEvidence } from '../../store/shipRuns.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { transition } from '../machine.js';
import { shipTicket, type ShipStepEvent } from './ship.js';
import type { InsideProgressEvent } from '../../model/inside/progress.js';
import type { GhRunner } from '../../integrations/github.js';
import { defaultGitRunner, runGit, type GitRunner } from '../../integrations/git.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { manifest, repo } from '../../manifest/fixtures.js';

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

/**
 * gh with an already-open PR on the branch — the state that used to fail ship.
 *
 * `view` carries a body because that is what decides whether ship may prefill a
 * description; pass `null` for a gh that never reported one, and `''` for a PR
 * opened by hand with no description at all.
 */
function ghWithExistingPr(
  url: string,
  body: string | null = 'a description someone already wrote',
  editExit = 0,
): { gh: GhRunner; args: string[][] } {
  const args: string[][] = [];
  const gh: GhRunner = async (a) => {
    args.push(a);
    if (a[1] === 'view') {
      const view = body === null ? { number: 18, url, state: 'OPEN' } : { number: 18, url, state: 'OPEN', body };
      return { stdout: JSON.stringify(view), exitCode: 0 };
    }
    if (a[1] === 'edit') {
      return { stdout: '', stderr: editExit === 0 ? '' : 'no write access', exitCode: editExit };
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
    if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { git, calls };
}

/** A real git repo at `path` with one base commit — the quarantine commit
 *  machinery runs real git, so a worktree exercising it must BE a repo. The
 *  `develop` branch at the base commit is what `seedWorktree`'s persisted
 *  `base_ref` names, so bounded ship provenance can resolve it. */
async function initRealRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await runGit(['init', '-b', 'main'], path);
  await runGit(['config', 'user.name', 'Test'], path);
  await runGit(['config', 'user.email', 'test@example.com'], path);
  await runGit(['config', 'commit.gpgsign', 'false'], path);
  writeFileSync(join(path, 'base.txt'), 'base');
  await runGit(['add', '-A'], path);
  const commit = await runGit(['commit', '-m', 'base'], path);
  expect(commit.exitCode).toBe(0);
  await runGit(['branch', 'develop'], path);
}

/**
 * Git runner over a REAL repo: records every invocation, answers `diff` with
 * "changes exist" and `push` with success (there is no remote), and delegates
 * everything else to real git so the quarantine plumbing works.
 */
function dirtyRealRepo(calls: string[][]): GitRunner {
  return async (args, cwd) => {
    calls.push(args);
    if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
    if (args[0] === 'push') return { stdout: '', stderr: '', exitCode: 0 };
    return defaultGitRunner(args, cwd);
  };
}

/**
 * The git verbs that CHANGE something. Ship also runs a read-only merge probe
 * (`fetch` / `rev-parse` / `merge-tree`) on every invocation, and the assertions
 * below are about what ship *does to the repo* — an idempotency test that broke
 * because a probe read the remote would be testing the wrong thing.
 */
const MUTATING = new Set(['status', 'add', 'commit', 'push']);
function mutating<T extends { args: string[] }>(calls: T[]): T[] {
  return calls.filter((c) => MUTATING.has(c.args[0]!));
}

/**
 * `git merge-tree --write-tree --name-only` as git actually prints it: the tree
 * OID, then the conflicted paths on the very next lines, then a blank line, then
 * git's informational messages. Verbatim from git 2.50 — a fixture that invents
 * a friendlier layout is what let a parser that read the messages as filenames
 * pass its own tests.
 */
const MERGE_TREE_CONFLICT =
  '9f2c1a0\nsrc/a.ts\nsrc/b.ts\n\nAuto-merging src/a.ts\n' +
  'CONFLICT (content): Merge conflict in src/a.ts\n';
const MERGE_TREE_CONFLICT_ONE =
  '9f2c1a0\nsrc/a.ts\n\nAuto-merging src/a.ts\n' +
  'CONFLICT (content): Merge conflict in src/a.ts\n';

/**
 * git that answers the merge probe: fetch works, both refs resolve, merge-tree
 * reports the given outcome. Everything else (status/add/commit/push) succeeds.
 */
function gitWithMergeProbe(probe: { exitCode: number; stdout?: string; stderr?: string }): GitRunner {
  return async (args) => {
    if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
    if (args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '', exitCode: 0 };
    if (args[0] === 'merge-tree') {
      return { stdout: probe.stdout ?? '', stderr: probe.stderr ?? '', exitCode: probe.exitCode };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

function fakeAdapter(): AgentAdapter {
  return {
    runHeadless: async () => ({ sessionId: 's', verdict: null, raw: 'Generated PR body.' }),
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: true, resume: true },
  };
}

/** The commit the saga created for a repo, per the durable evidence. */
function createdShipCommit(
  store: Store,
  ticketId: number,
  repoName: string,
): { sha: string; message: string } | undefined {
  const commits = listShipEvidence(store, ticketId).repos[repoName]?.commits ?? [];
  return commits.find((c) => c.origin === 'created-by-ship');
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

  it('uses the asynchronous gh runner by default and leaves the event loop responsive', async () => {
    const worktree = join(dir, 'fe');
    mkdirSync(worktree);
    seedWorktree(store, id, '/repo/frontend', worktree);
    const binDir = join(dir, 'bin');
    const executable = join(binDir, 'gh');
    const originalPath = process.env.PATH;
    mkdirSync(binDir);
    writeFileSync(
      executable,
      `#!/usr/bin/env node
setTimeout(() => {
  if (process.argv.includes('view')) process.exitCode = 1;
  else process.stdout.write('https://github.com/o/r/pull/7');
}, 30);
`,
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    let responsive = false;
    setTimeout(() => {
      responsive = true;
    }, 0);

    try {
      const result = await shipTicket(store, { ticketId: id }, undefined, undefined, fakeGit().git);
      expect(responsive).toBe(true);
      expect(result.prs).toEqual([
        { repo: '/repo/frontend', number: 7, url: 'https://github.com/o/r/pull/7' },
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  // `gh pr create` refuses a branch that exists only locally: "you must first push
  // the current branch to a remote". Every karst ticket works on a fresh worktree
  // branch, so the branch is ALWAYS local-only — ship could never have opened a
  // single PR without this.
  it('pushes the worktree branch before opening its PR', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const order: string[] = [];
    const git: GitRunner = async (args, cwd) => {
      if (MUTATING.has(args[0]!)) order.push(`git ${args[0]}`);
      expect(cwd).toBe(join(dir, 'fe'));
      if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const gh: GhRunner = async (args) => {
      order.push(`gh pr ${args[1]}`);
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      return { stdout: 'https://github.com/o/r/pull/1', exitCode: 0 };
    };

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git);

    // The probe sits after the push, not before it: an existing PR must still
    // receive the branch's new commits. Adopting is not skipping. The trailing
    // view is the metadata read (from-to branches, opened stamp) on the PR that
    // now exists — the ship stage renders it immediately, not a sweep later.
    expect(order).toEqual([
      'git status',
      'git push',
      'gh pr view',
      'gh pr create',
      'gh pr view',
    ]);
  });

  it('targets the current repository baseline instead of the worktree creation-time base', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[1] === 'view') {
        return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      }
      return { stdout: 'https://github.com/o/r/pull/1', exitCode: 0 };
    };

    await shipTicket(
      store,
      {
        ticketId: id,
        manifest: manifest({
          frontend: repo({ repoPath: '/repo/frontend', baselineBranch: 'release' }),
        }),
      },
      gh,
      undefined,
      fakeGit().git,
    );

    expect(calls.find((args) => args[1] === 'create')).toContain('release');
    expect(listMergeChecksByTicket(store, id)[0]!.baseRef).toBe('release');
  });

  // The reported bug: impl/uat/review all passed but the work was never committed,
  // so the branch had no commits and gh died with "No commits between main and
  // karst/…". Ship commits what the agent left behind rather than pushing nothing.
  it('commits uncommitted worktree changes before pushing', async () => {
    const worktree = join(dir, 'fe');
    seedWorktree(store, id, '/repo/frontend', worktree);
    await initRealRepo(worktree);
    writeFileSync(join(worktree, 'left.txt'), 'work');
    const calls: string[][] = [];
    const recording = dirtyRealRepo(calls);
    const { gh } = fakeGh();

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), recording);

    // The exact intended SHA and message are persisted as provenance, and the
    // push ran after the commit — the branch carries the work to GitHub.
    const created = createdShipCommit(store, id, '/repo/frontend');
    expect(created?.message).toBe('add search');
    expect(created?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(calls.some((args) => args[0] === 'push')).toBe(true);
  });

  // The branch's pre-ship commits are bounded at the persisted worktree
  // baseline: `rev-list <base>..HEAD`, never the whole reachable ancestry. The
  // repository root and unrelated base-branch work would otherwise be stored
  // and mislabeled as "before ship" for every ticket on the repo.
  it('records only commits after the worktree baseline as before-ship provenance', async () => {
    const worktree = join(dir, 'fe');
    seedWorktree(store, id, '/repo/frontend', worktree);
    await initRealRepo(worktree);
    // An unrelated ancestor on the base branch, then the ticket's own commits.
    await runGit(['checkout', 'develop'], worktree);
    writeFileSync(join(worktree, 'unrelated.txt'), 'unrelated');
    await runGit(['add', '-A'], worktree);
    await runGit(['commit', '-m', 'unrelated'], worktree);
    await runGit(['checkout', '-b', 'karst/x'], worktree);
    writeFileSync(join(worktree, 't1.txt'), '1');
    await runGit(['add', '-A'], worktree);
    await runGit(['commit', '-m', 'ticket-1'], worktree);
    const t1 = (await runGit(['rev-parse', 'HEAD'], worktree)).stdout.trim();
    writeFileSync(join(worktree, 't2.txt'), '2');
    await runGit(['add', '-A'], worktree);
    await runGit(['commit', '-m', 'ticket-2'], worktree);
    const t2 = (await runGit(['rev-parse', 'HEAD'], worktree)).stdout.trim();

    await shipTicket(store, { ticketId: id }, fakeGh().gh, fakeAdapter(), dirtyRealRepo([]));

    const commits = listShipEvidence(store, id).repos['/repo/frontend']?.commits ?? [];
    const beforeShip = commits.filter((c) => c.origin === 'before-ship').map((c) => c.sha);
    expect(beforeShip).toEqual([t1, t2]);
    // The worktree was clean: the saga created nothing of its own.
    expect(commits.filter((c) => c.origin === 'created-by-ship')).toHaveLength(0);
  });

  // Manifest drift: the worktree was cut from `develop` and its row says so,
  // but the manifest now resolves the repo to `main`. Provenance must read the
  // PERSISTED baseline — the branch was cut from develop, so `develop..HEAD`
  // is the only honest before-ship bound. The manifest's current answer must
  // never rewrite history for a worktree that already exists.
  it('uses the persisted worktree baseline for provenance, not the drifted manifest', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await shipTicket(
      store,
      {
        ticketId: id,
        manifest: manifest({
          frontend: repo({ repoPath: '/repo/frontend', baselineBranch: 'main' }),
        }),
      },
      fakeGh().gh,
      undefined,
      git,
    );

    expect(calls).toContainEqual(['rev-list', '--reverse', 'develop..HEAD']);
    expect(calls).not.toContainEqual(['rev-list', '--reverse', 'main..HEAD']);
  });

  // A worktree with NO persisted baseline must record unknown provenance even
  // when the manifest resolves a baseline today — substituting the manifest's
  // current answer would claim commits under a bound this ticket never had.
  it('records unknown provenance when no baseline was persisted, never the manifest answer', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    store.db
      .prepare('UPDATE worktrees SET base_ref = NULL WHERE ticket_id = ? AND repo = ?')
      .run(id, '/repo/frontend');
    const calls: string[][] = [];
    const events: ShipStepEvent[] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await shipTicket(
      store,
      {
        ticketId: id,
        manifest: manifest({
          frontend: repo({ repoPath: '/repo/frontend', baselineBranch: 'main' }),
        }),
      },
      fakeGh().gh,
      undefined,
      git,
      (event) => events.push(event),
    );

    expect(calls.filter((args) => args[0] === 'rev-list')).toEqual([]);
    expect(events).toContainEqual({
      repo: '/repo/frontend',
      step: 'commit',
      status: 'note',
      detail: 'no baseline recorded — before-ship provenance unknown',
    });
    expect(listShipEvidence(store, id).repos['/repo/frontend']?.commits ?? []).toHaveLength(0);
  });

  describe('when the branch has no effective changes from its target', () => {
    it('succeeds without pushing or invoking PR creation and reports the no-op', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const calls: string[][] = [];
      const git: GitRunner = async (args) => {
        calls.push(args);
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      };
      const ghCalls: string[][] = [];
      const gh: GhRunner = async (args) => {
        ghCalls.push(args);
        return { stdout: '', stderr: 'GraphQL: No commits between develop and karst/x', exitCode: 1 };
      };
      const events: ShipStepEvent[] = [];

      const result = await shipTicket(
        store,
        { ticketId: id },
        gh,
        fakeAdapter(),
        git,
        (event) => events.push(event),
      );

      expect(result.prs).toEqual([]);
      expect(ghCalls).toEqual([]);
      expect(calls.some((args) => args[0] === 'push')).toBe(false);
      expect(calls).toContainEqual(['fetch', 'origin', 'develop']);
      expect(calls).toContainEqual(['diff', '--quiet', 'origin/develop...HEAD']);
      expect(events).toContainEqual({
        repo: '/repo/frontend',
        step: 'pr',
        status: 'note',
        detail: 'no PR needed — no changes from develop',
      });
      expect(getTicket(store, id).stageCurrent).toBe('done');
    });

    it('preserves normal PR creation when an effective change is present', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const order: string[] = [];
      const git: GitRunner = async (args) => {
        if (args[0] === 'fetch') order.push('git fetch');
        if (args[0] === 'diff') {
          order.push('git diff');
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (MUTATING.has(args[0]!)) order.push(`git ${args[0]}`);
        return { stdout: '', stderr: '', exitCode: 0 };
      };
      const gh: GhRunner = async (args) => {
        order.push(`gh pr ${args[1]}`);
        if (args[1] === 'view') {
          return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
        }
        return { stdout: 'https://github.com/o/r/pull/1', stderr: '', exitCode: 0 };
      };

      const result = await shipTicket(store, { ticketId: id }, gh, undefined, git);

      expect(result.prs).toHaveLength(1);
      expect(order).toEqual([
        'git status',
        'git fetch',
        'git diff',
        'git push',
        'gh pr view',
        // The description is written from the branch material — commits,
        // diffstat, unified diff — collected once, bounded, before the PR opens.
        'git diff',
        'git diff',
        'gh pr create',
        'gh pr view',
        'git fetch',
      ]);
    });
  });

  // A dirty tree that cannot be committed (a third writer holds the index lock)
  // means the PR would be empty. Fail loudly at ship rather than open a no-op PR.
  it('a failed commit aborts the ship and never calls gh', async () => {
    const worktree = join(dir, 'fe');
    seedWorktree(store, id, '/repo/frontend', worktree);
    await initRealRepo(worktree);
    writeFileSync(join(worktree, 'left.txt'), 'work');
    // A pre-existing lock makes the compare-and-swap refuse: the world moved
    // under the preparation and nothing is overwritten.
    const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], worktree)).stdout.trim();
    writeFileSync(join(gitDir, 'karst-index-lock'), 'stale');
    const { gh, ...ghCalls } = fakeGh();

    await expect(
      shipTicket(store, { ticketId: id }, gh, fakeAdapter(), defaultGitRunner),
    ).rejects.toThrow(/commit refused.*lock-exists/);

    expect(ghCalls.calls).toBe(0);
    const ship = getTicket(store, id).stages.find((s) => s.stageKey === 'ship');
    expect(ship?.status).toBe('failed');
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  // A git status that FAILED must never read as "nothing to commit": the work
  // the agent left may simply be unreadable, and pushing an empty branch would
  // open a PR that never carried the work. Nonzero parks ship with a bounded
  // diagnostic — never raw unbounded git stderr — and no false clean note.
  it('a nonzero git status exit is a failure, never a clean worktree', async () => {
    const worktree = join(dir, 'fe');
    seedWorktree(store, id, '/repo/frontend', worktree);
    const calls: string[][] = [];
    const events: ShipStepEvent[] = [];
    let ghCalls = 0;
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'status') {
        return {
          stdout: '',
          stderr: 'fatal: not a git repository\nfatal: more prose',
          exitCode: 128,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const gh: GhRunner = async (args, cwd) => {
      ghCalls++;
      return fakeGh().gh(args, cwd);
    };

    await expect(
      shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git, (e) => events.push(e)),
    ).rejects.toThrow(/git status --porcelain failed \(exit 128\)/);

    // The verdict that parks the ticket is one collapsed line — the raw
    // multi-line stderr never reaches the stage row or any rendered surface.
    const ship = getTicket(store, id).stages.find((s) => s.stageKey === 'ship');
    expect(ship?.status).toBe('failed');
    expect(ship?.verdict).toContain('git status --porcelain failed (exit 128)');
    expect(ship?.verdict).not.toContain('\n');
    expect(getTicket(store, id).stageCurrent).toBe('ship');
    // No false "nothing to commit" note, no push, no PR, no provenance rows.
    expect(events.some((e) => e.detail === 'worktree clean — nothing to commit')).toBe(false);
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
    expect(ghCalls).toBe(0);
    expect(listShipEvidence(store, id).repos['/repo/frontend']?.commits ?? []).toHaveLength(0);
  });

  it('pushes each repo’s own worktree, and sets upstream so the PR has a head', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
    const { gh } = fakeGh();
    const { git, calls } = fakeGit();

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git);

    expect([...new Set(calls.map((c) => c.cwd))].sort()).toEqual([join(dir, 'be'), join(dir, 'fe')]);
    // Clean worktrees (the fake reports no changes) → status only, then push.
    for (const c of mutating(calls)) expect(c.args[0]).toMatch(/^(status|push)$/);
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

    expect(mutating(calls)).toEqual([]);
  });

  it('opens one PR per hot repo and writes rows to prs', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
    const { gh } = fakeGh();
    const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    expect(res.prs).toHaveLength(2);
    expect(listPrsByTicket(store, id)).toHaveLength(2);
  });

  it('each PR carries a deterministic description when the pr-description process is disabled', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const gh: GhRunner = async (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      // With no collected metadata the safe deterministic fallback is the title.
      const bodyIdx = args.indexOf('--body');
      expect(args[bodyIdx + 1]).toBe('add search');
      return { stdout: 'https://github.com/o/r/pull/9', exitCode: 0 };
    };
    const res = await shipTicket(
      store,
      { ticketId: id, prDescriptionProcess: null },
      gh,
      fakeAdapter(),
      fakeGit().git,
    );
    expect(res.prs[0]!.url).toBe('https://github.com/o/r/pull/9');
  });

  describe('artifact conventions', () => {
    function recordingGh(): { gh: GhRunner; creates: string[][] } {
      const creates: string[][] = [];
      const gh: GhRunner = async (args) => {
        if (args[1] === 'view') {
          return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
        }
        creates.push(args);
        return {
          stdout: `https://github.com/o/r/pull/${creates.length}`,
          stderr: '',
          exitCode: 0,
        };
      };
      return { gh, creates };
    }

    it('applies all three configured templates to the exact git and gh arguments', async () => {
      const worktree = join(dir, 'fe');
      seedWorktree(store, id, 'frontend', worktree);
      await initRealRepo(worktree);
      writeFileSync(join(worktree, 'work.txt'), 'work');
      const gitCalls: string[][] = [];
      const { gh, creates } = recordingGh();
      let headless = 0;
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async () => {
          headless++;
          return { sessionId: 's', verdict: null, raw: 'Generated summary.' };
        },
      };

      await shipTicket(
        store,
        {
          ticketId: id,
          conventions: {
            commitMessage: 'feat({repo}): {title} [{key}]',
            pullRequestTitle: '[{key}] {title} ({repo})',
            pullRequestDescription: '# {title}\n\n{description}\n\nTicket {id}',
          },
        },
        gh,
        adapter,
        dirtyRealRepo(gitCalls),
      );

      expect(createdShipCommit(store, id, 'frontend')?.message).toBe(
        'feat(frontend): add search [PROJ-1]',
      );
      expect(creates).toEqual([[
        'pr',
        'create',
        '--title',
        '[PROJ-1] add search (frontend)',
        '--body',
        '# add search\n\nGenerated summary.\n\nTicket 1',
        '--base',
        'develop',
      ]]);
      expect(headless).toBe(1);
    });

    it('renders {type} from the ticket and {scope} from the repository', async () => {
      const worktree = join(dir, 'fe');
      seedWorktree(store, id, 'frontend', worktree);
      updateTicketFields(store, id, { type: 'fix' });
      await initRealRepo(worktree);
      writeFileSync(join(worktree, 'work.txt'), 'work');
      const gitCalls: string[][] = [];
      const { gh, creates } = recordingGh();

      await shipTicket(
        store,
        {
          ticketId: id,
          manifest: manifest({
            frontend: repo({ repoPath: '/repo/frontend', scope: 'web' }),
          }),
          conventions: {
            commitMessage: '{type}({scope}): {title} [{key}]',
            pullRequestTitle: '{type}({scope}): {title}',
          },
        },
        gh,
        undefined,
        dirtyRealRepo(gitCalls),
      );

      expect(createdShipCommit(store, id, 'frontend')?.message).toBe('fix(web): add search [PROJ-1]');
      expect(creates[0]).toContain('fix(web): add search');
    });

    it('falls back to the manifest default type and the repository name as scope', async () => {
      const worktree = join(dir, 'fe');
      seedWorktree(store, id, 'frontend', worktree);
      await initRealRepo(worktree);
      writeFileSync(join(worktree, 'work.txt'), 'work');
      const gitCalls: string[][] = [];
      const { gh } = recordingGh();

      await shipTicket(
        store,
        {
          ticketId: id,
          manifest: manifest({ frontend: repo({ repoPath: '/repo/frontend' }) }),
          conventions: { commitMessage: '{type}({scope}): {title}', defaultType: 'chore' },
        },
        gh,
        undefined,
        dirtyRealRepo(gitCalls),
      );

      expect(createdShipCommit(store, id, 'frontend')?.message).toBe('chore(frontend): add search');
    });

    it('falls back to feat when neither the ticket nor the manifest sets a type', async () => {
      const worktree = join(dir, 'fe');
      seedWorktree(store, id, 'frontend', worktree);
      await initRealRepo(worktree);
      writeFileSync(join(worktree, 'work.txt'), 'work');
      const gitCalls: string[][] = [];
      const { gh } = recordingGh();

      await shipTicket(
        store,
        { ticketId: id, conventions: { commitMessage: '{type}: {title}' } },
        gh,
        undefined,
        dirtyRealRepo(gitCalls),
      );

      expect(createdShipCommit(store, id, 'frontend')?.message).toBe('feat: add search');
    });

    it('keeps absent commit and body behavior when only the PR title is configured', async () => {
      const worktree = join(dir, 'fe');
      seedWorktree(store, id, 'frontend', worktree);
      await initRealRepo(worktree);
      writeFileSync(join(worktree, 'work.txt'), 'work');
      const gitCalls: string[][] = [];
      const { gh, creates } = recordingGh();
      const prompts: string[] = [];
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async (opts) => {
          prompts.push(opts.prompt);
          return { sessionId: 's', verdict: null, raw: 'Legacy generated body.' };
        },
      };

      await shipTicket(
        store,
        { ticketId: id, conventions: { pullRequestTitle: '[{key}] {title}' } },
        gh,
        adapter,
        dirtyRealRepo(gitCalls),
      );

      expect(createdShipCommit(store, id, 'frontend')?.message).toBe('add search');
      // The description call carries the branch context, not just the title —
      // a run told only a title goes exploring for the changes, which is how a
      // help-request ("where is the worktree") became a PR body (PR #117).
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Repository: frontend');
      expect(prompts[0]).toContain('Title: [PROJ-1] add search');
      expect(prompts[0]).toContain(
        'Base the description ONLY on the material above. Do not run commands, open files, or inspect the repository — everything you need is included.',
      );
      expect(creates[0]).toEqual([
        'pr',
        'create',
        '--title',
        '[PROJ-1] add search',
        '--body',
        'Legacy generated body.',
        '--base',
        'develop',
      ]);
    });

    it('renders branch-only facts locally when the pr-description process is disabled', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();
      let headless = 0;
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async () => {
          headless++;
          throw new Error('PR descriptions must not launch an agent');
        },
      };
      const git: GitRunner = async (args) => {
        if (args[0] === 'diff' && args[1] === '--quiet') return { stdout: '', stderr: '', exitCode: 1 };
        if (args[0] === 'log') {
          expect(args).toEqual(['log', '--oneline', 'origin/develop..HEAD']);
          return { stdout: '* abc1234 add search\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'diff' && args[1] === '--stat') {
          return { stdout: ' src/a.ts | 3 ++\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      // The CONFIGURED process is null (enabled: false): no AI call, and the
      // deterministic branch-facts body is rendered locally instead — even
      // though a positional adapter is present.
      await shipTicket(
        store,
        { ticketId: id, prDescriptionProcess: null },
        gh,
        adapter,
        git,
      );

      expect(headless).toBe(0);
      const body = creates[0]![creates[0]!.indexOf('--body') + 1]!;
      expect(body).toContain('## Summary');
      expect(body).toContain('- add search');
      expect(body).toContain('src/a.ts | 3 ++');
    });

    it('still describes when the diff cannot be read — a failed read never fails ship', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh } = recordingGh();
      let headless = 0;
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async () => {
          headless++;
          throw new Error('must not run');
        },
      };
      const git: GitRunner = async (args) => {
        if (args[0] === 'diff' && args[1] === '--quiet') return { stdout: '', stderr: '', exitCode: 1 };
        if (['fetch', 'status', 'push', 'add', 'commit', 'rev-list'].includes(args[0]!)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'boom', exitCode: 128 };
      };

      await expect(
        shipTicket(store, { ticketId: id, prDescriptionProcess: null }, gh, adapter, git),
      ).resolves.toBeDefined();
      expect(headless).toBe(0);
    });

    it('uses a deterministic configured body without calling the adapter', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();
      let headless = 0;
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async () => {
          headless++;
          return { sessionId: 's', verdict: null, raw: 'unused' };
        },
      };

      await shipTicket(
        store,
        {
          ticketId: id,
          conventions: { pullRequestDescription: 'Ticket {key}\nRepo {repo}' },
        },
        gh,
        adapter,
        fakeGit().git,
      );

      expect(headless).toBe(0);
      expect(creates[0]!.slice(2)).toEqual([
        '--title',
        'add search',
        '--body',
        'Ticket PROJ-1\nRepo frontend',
        '--base',
        'develop',
      ]);
    });

    it('uses the final PR title for description fallback when no adapter exists', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();

      await shipTicket(
        store,
        {
          ticketId: id,
          conventions: {
            pullRequestTitle: '[{key}] {title}',
            pullRequestDescription: '## Summary\n{description}',
          },
        },
        gh,
        undefined,
        fakeGit().git,
      );

      expect(creates[0]!.slice(2)).toEqual([
        '--title',
        '[PROJ-1] add search',
        '--body',
        '## Summary\n[PROJ-1] add search',
        '--base',
        'develop',
      ]);
    });

    it('renders repository-specific metadata independently for every worktree', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      seedWorktree(store, id, 'backend', join(dir, 'be'));
      const { gh, creates } = recordingGh();

      await shipTicket(
        store,
        {
          ticketId: id,
          conventions: {
            pullRequestTitle: '{repo}: {title}',
            pullRequestDescription: 'Repository {repo}',
          },
        },
        gh,
        fakeAdapter(),
        fakeGit().git,
      );

      expect(creates.map((args) => [args[3], args[5]]).sort()).toEqual([
        ['backend: add search', 'Repository backend'],
        ['frontend: add search', 'Repository frontend'],
      ]);
    });

    it('preserves exact unconfigured title and no-adapter body behavior', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();

      await shipTicket(store, { ticketId: id }, gh, undefined, fakeGit().git);

      expect(creates[0]).toEqual([
        'pr',
        'create',
        '--title',
        'add search',
        '--body',
        'add search',
        '--base',
        'develop',
      ]);
    });
  });

  // The AI answer is public GitHub metadata the moment it is written, so the
  // agent's chat-shaped scaffolding must never reach it: the prompt asks for a
  // clean body, and `sanitizePrDescription` enforces it.
  describe('PR body hygiene', () => {
    /** What an agent answering a chat-shaped question actually hands back. */
    const SESSION_ANSWER = [
      'No PR open yet for this branch. Description below (copy-paste ready).',
      '',
      '```markdown',
      '## Summary',
      '',
      'Sanitize `describePr` output before it reaches `gh pr create --body`.',
      '',
      '```bash',
      'npm test',
      '```',
      '```',
      '',
      'Let me know if you want any changes.',
    ].join('\n');

    function chattyAdapter(): AgentAdapter {
      return {
        ...fakeAdapter(),
        runHeadless: async () => ({ sessionId: 's', verdict: null, raw: SESSION_ANSWER }),
      };
    }

    function bodyOf(creates: string[][]): string {
      const args = creates[0]!;
      return args[args.indexOf('--body') + 1]!;
    }

    function recordingGh(): { gh: GhRunner; creates: string[][] } {
      const creates: string[][] = [];
      const gh: GhRunner = async (args) => {
        if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
        creates.push(args);
        return { stdout: 'https://github.com/o/r/pull/7', exitCode: 0 };
      };
      return { gh, creates };
    }

    it('strips agent chatter and wrapping fences from the AI answer', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();

      await shipTicket(store, { ticketId: id }, gh, chattyAdapter(), fakeGit().git);

      const body = bodyOf(creates);
      // The status line, the "copy-paste ready" preamble, the whole-body
      // markdown fence and the sign-off are gone; the real content survives.
      expect(body).toBe(
        [
          '## Summary',
          '',
          'Sanitize `describePr` output before it reaches `gh pr create --body`.',
          '',
          '```bash',
          'npm test',
          '```',
        ].join('\n'),
      );
    });

    it('sanitizes the description before it is interpolated into a body template', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();

      await shipTicket(
        store,
        {
          ticketId: id,
          conventions: { pullRequestDescription: '{description}\n\nTicket {key}' },
        },
        gh,
        chattyAdapter(),
        fakeGit().git,
      );

      const body = bodyOf(creates);
      expect(body.startsWith('## Summary')).toBe(true);
      expect(body).toContain('Ticket PROJ-1');
      expect(body).not.toContain('copy-paste');
      expect(body).not.toContain('Let me know');
    });

    // The reported bug (PR #117): the model answered a title-only question with
    // a help-request ("The current directory (/) is not a git repository. Where
    // is the worktree located?") and that narration shipped as the PR body.
    // The prompt must hand it the branch facts instead of sending it looking.
    it('hands the collected branch facts to the description model', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();
      const prompts: string[] = [];
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async (opts) => {
          prompts.push(opts.prompt);
          return { sessionId: 's', verdict: null, raw: 'Grounded body.' };
        },
      };
      const git: GitRunner = async (args) => {
        if (args[0] === 'diff' && args[1] === '--quiet') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (args[0] === 'log') {
          return { stdout: '* abc1234 add search\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'diff' && args[1] === '--stat') {
          return { stdout: ' src/a.ts | 3 ++\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'diff') {
          return { stdout: 'diff --git a/src/a.ts b/src/a.ts\n+hello\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      await shipTicket(store, { ticketId: id }, gh, adapter, git);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Commits on this branch:\n* abc1234 add search');
      expect(prompts[0]).toContain('Changed files (diffstat):\n src/a.ts | 3 ++');
      expect(prompts[0]).toContain(
        'Diff (full):\ndiff --git a/src/a.ts b/src/a.ts\n+hello',
      );
      expect(bodyOf(creates)).toBe('Grounded body.');
    });

    it('never ships "where is the worktree" narration as the PR body', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async () => ({
          sessionId: 's',
          verdict: null,
          raw: [
            'The current directory (`/`) is not a git repository. Where is the worktree located?',
            'Please provide the path to the repository, or I can check common locations: I can\'t locate a git worktree with changes matching "add search".',
            'Could you provide the path to the repository or worktree you would like me to generate the PR description for?',
            '',
            '## Summary',
            '',
            'The search feature now works.',
          ].join('\n'),
        }),
      };

      await shipTicket(store, { ticketId: id }, gh, adapter, fakeGit().git);

      expect(bodyOf(creates)).toBe(['## Summary', '', 'The search feature now works.'].join('\n'));
    });
  });

  // Task 3: the pr-description process bundle carries the configured identity
  // AND its own adapter — the description step snapshots the assignment into
  // its process run and runs the model through the bundle's adapter, never a
  // second resolution path.
  describe('pr-description process assignment', () => {
    function recordingCreateGh(): { gh: GhRunner; creates: string[][] } {
      const creates: string[][] = [];
      const gh: GhRunner = async (args) => {
        if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
        creates.push(args);
        return { stdout: 'https://github.com/o/r/pull/9', exitCode: 0 };
      };
      return { gh, creates };
    }

    it('snapshots the configured pr-description identity into the description process run', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = recordingCreateGh();
      let actualModel: string | undefined;
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async (opts) => {
          actualModel = opts.model;
          return { sessionId: 's', verdict: null, raw: 'Generated PR body.' };
        },
      };
      const process = {
        assignment: { agentName: 'PR Scribe', provider: 'codex' as const, model: 'sol' },
        adapter,
      };

      await shipTicket(
        store,
        { ticketId: id, prDescriptionProcess: process },
        gh,
        undefined,
        fakeGit().git,
      );

      const run = listProcessRuns(store, id).find((r) => r.processId === 'pr-description')!;
      expect(run).toMatchObject({
        agentName: 'PR Scribe',
        provider: 'codex',
        model: 'sol',
        status: 'passed',
      });
      expect(actualModel).toBe('sol');
    });

    it('a null pr-description process performs no model call, opens no process run, and falls back to the deterministic branch-facts body', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh, creates } = recordingCreateGh();
      let headless = 0;
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async () => {
          headless++;
          return { sessionId: 's', verdict: null, raw: 'must never be asked' };
        },
      };

      // The positional adapter is present, but the CONFIGURED process is null
      // (enabled: false) — configured absence wins: no AI call, no process run,
      // and the deterministic branch-facts body still produces the PR body.
      await shipTicket(
        store,
        { ticketId: id, prDescriptionProcess: null },
        gh,
        adapter,
        fakeGit().git,
      );

      expect(headless).toBe(0);
      expect(listProcessRuns(store, id).filter((r) => r.processId === 'pr-description')).toHaveLength(0);
      const body = creates[0]![creates[0]!.indexOf('--body') + 1]!;
      expect(body).toBe('add search');
    });
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
    expect(t.stageCurrent).toBe('ship');
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
      expect(getTicket(store, id).stageCurrent).toBe('ship');
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
      expect(mutating(calls)).toEqual([]);
      expect(listPrsByTicket(store, id)).toHaveLength(1);
    });

    // Probing before the create is what buys this: `describePr` runs BEFORE
    // `openPr`, so rescuing after the failure would still have paid a model call
    // per repo to write prose for a PR that already exists.
    it('asks no model for a description it cannot use', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh, args } = ghWithExistingPr(URL);
      let headless = 0;
      const events: ShipStepEvent[] = [];
      const adapter: AgentAdapter = { ...fakeAdapter(), runHeadless: async () => {
        headless++;
        return { sessionId: 's', verdict: null, raw: 'x' };
      } };

      await shipTicket(
        store,
        {
          ticketId: id,
          conventions: {
            pullRequestDescription: '## Summary\n{description}',
          },
        },
        gh,
        adapter,
        fakeGit().git,
        (event) => events.push(event),
      );

      expect(headless).toBe(0);
      expect(args.some((a) => a[1] === 'edit')).toBe(false);
      expect(events).toContainEqual({
        repo: '/repo/frontend',
        step: 'describe',
        status: 'note',
        detail: 'existing PR already has a description — kept',
      });
    });

    // The second half of the reported bug: a PR opened by hand often has NO
    // description, and ship skipped the describe step wholesale — so adopting it
    // left a permanently empty PR body that nothing would ever fill.
    describe('and that PR has no description', () => {
      it('fills it in, rather than leaving the PR body empty forever', async () => {
        seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
        const { gh, args } = ghWithExistingPr(URL, '');
        const events: ShipStepEvent[] = [];

        await shipTicket(
          store,
          { ticketId: id, conventions: { pullRequestDescription: '## Summary\n{description}' } },
          gh,
          fakeAdapter(),
          fakeGit().git,
          (event) => events.push(event),
        );

        const edit = args.find((a) => a[1] === 'edit');
        expect(edit).toEqual(['pr', 'edit', URL, '--body', '## Summary\nGenerated PR body.']);
        expect(events).toContainEqual({
          repo: '/repo/frontend',
          step: 'describe',
          status: 'pass',
          detail: 'existing PR had no description — filled in',
        });
        expect(getTicket(store, id).stageCurrent).toBe('ship');
      });

      // Whitespace is not a description a human wrote; it is the same emptiness
      // with invisible characters in it.
      it('treats a whitespace-only body as empty', async () => {
        seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
        const { gh, args } = ghWithExistingPr(URL, '\n  \n');

        await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);

        expect(args.some((a) => a[1] === 'edit')).toBe(true);
      });

      // The PR is already open — ship's irreversible part succeeded. A refused
      // edit is a note on a working ship, not a failure that parks the ticket.
      it('notes a refused edit and still finishes the ship', async () => {
        seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
        const { gh } = ghWithExistingPr(URL, '', 1);
        const events: ShipStepEvent[] = [];

        await shipTicket(
          store,
          { ticketId: id },
          gh,
          fakeAdapter(),
          fakeGit().git,
          (event) => events.push(event),
        );

        expect(events).toContainEqual({
          repo: '/repo/frontend',
          step: 'describe',
          status: 'note',
          detail: 'existing PR had no description — update failed: no write access',
        });
        expect(getTicket(store, id).stageCurrent).toBe('ship');
      });
    });

    // The probe is not infallible: `gh pr view` for the current branch comes back
    // nonzero for bad auth, an ambiguous base repository, or a remote hiccup just
    // as it does for "no PR" — and then ship went on to create, gh refused with
    // "a pull request for branch … already exists", and `openPr` threw. That is
    // the exact failure on the ticket. gh names the PR in its refusal, so there is
    // never a reason to fail: reuse it.
    describe('but the branch probe came back blind', () => {
      /** gh that cannot answer the branch probe, and refuses the create. */
      function ghBlindProbe(body: string | null = 'a description someone already wrote'): {
        gh: GhRunner;
        args: string[][];
      } {
        const args: string[][] = [];
        const gh: GhRunner = async (a) => {
          args.push(a);
          // The branch-inferred probe (no ref) — blind, exactly like "no PR".
          if (a[1] === 'view' && a[2] === '--json') {
            return { stdout: '', stderr: 'could not determine base repository', exitCode: 1 };
          }
          // Any probe BY ref still works: gh knows this PR, it just could not map
          // the branch to it.
          if (a[1] === 'view') {
            const view = body === null ? { state: 'OPEN' } : { state: 'OPEN', body };
            return { stdout: JSON.stringify(view), exitCode: 0 };
          }
          if (a[1] === 'edit') return { stdout: '', exitCode: 0 };
          return {
            stdout: '',
            stderr: `a pull request for branch "karst/x" into branch "develop" already exists:\n${URL}`,
            exitCode: 1,
          };
        };
        return { gh, args };
      }

      it('reuses the PR gh names instead of failing the ship', async () => {
        seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
        const { gh } = ghBlindProbe();

        const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);

        expect(res.prs).toEqual([{ repo: '/repo/frontend', number: 18, url: URL }]);
        expect(getTicket(store, id).stageCurrent).toBe('ship');
        expect(getTicket(store, id).stages.find((s) => s.stageKey === 'ship')!.verdict).toBeNull();
      });

      // The whole point of recording it: a retry must be absorbed by the local
      // guard rather than driven back into the same refusal.
      it('records the reused PR, so a re-run does not create a duplicate', async () => {
        seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
        await shipTicket(store, { ticketId: id }, ghBlindProbe().gh, fakeAdapter(), fakeGit().git);
        expect(listPrsByTicket(store, id)).toHaveLength(1);

        const second = ghBlindProbe();
        await shipTicket(store, { ticketId: id }, second.gh, fakeAdapter(), fakeGit().git);

        expect(second.args).toEqual([]);
        expect(listPrsByTicket(store, id)).toHaveLength(1);
      });

      // The body ship just generated never reached GitHub — gh refused the create.
      // It is exactly as usable as one built for an adopted PR, and subject to the
      // same rule: fill an empty description, never overwrite a written one. The
      // one model call already paid for it — no second one to edit it in.
      it('fills an empty description with the body the create never delivered', async () => {
        seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
        const { gh, args } = ghBlindProbe('');
        let headless = 0;
        const adapter: AgentAdapter = {
          ...fakeAdapter(),
          runHeadless: async () => {
            headless++;
            return { sessionId: 's', verdict: null, raw: 'Generated PR body.' };
          },
        };

        await shipTicket(store, { ticketId: id }, gh, adapter, fakeGit().git);

        expect(args.find((a) => a[1] === 'edit')).toEqual([
          'pr',
          'edit',
          URL,
          '--body',
          'Generated PR body.',
        ]);
        expect(headless).toBe(1);
      });

      it('keeps a description the reused PR already has', async () => {
        seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
        const { gh, args } = ghBlindProbe('prose a human wrote');

        await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);

        expect(args.some((a) => a[1] === 'edit')).toBe(false);
      });

      // A refusal that names no PR is a real failure and must still park the
      // ticket — reuse is for an existing PR, not a blanket "never fail".
      it('still fails the ship for a refusal that names no PR', async () => {
        seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
        const gh: GhRunner = async (a) => {
          if (a[1] === 'view') return { stdout: '', stderr: 'blind', exitCode: 1 };
          return { stdout: '', stderr: 'GraphQL: Resource not accessible', exitCode: 1 };
        };

        await expect(
          shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git),
        ).rejects.toThrow(/Resource not accessible/);
        expect(getTicket(store, id).stageCurrent).toBe('ship');
      });
    });

    // "gh did not say" is not "the PR has no description". Overwriting on a
    // degraded probe would destroy prose a human wrote — the one outcome this
    // whole path must never produce.
    it('leaves the body alone when gh reported no body at all', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh, args } = ghWithExistingPr(URL, null);
      const events: ShipStepEvent[] = [];

      await shipTicket(
        store,
        { ticketId: id },
        gh,
        fakeAdapter(),
        fakeGit().git,
        (event) => events.push(event),
      );

      expect(args.some((a) => a[1] === 'edit')).toBe(false);
      expect(events).toContainEqual({
        repo: '/repo/frontend',
        step: 'describe',
        status: 'note',
        detail: 'existing PR description could not be read — left unchanged',
      });
    });
  });

  it('parks at ship, blocked on the merge gate, on success — an open PR is not a landing', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const { gh } = fakeGh();
    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    const t = getTicket(store, id);
    expect(t.stageCurrent).toBe('ship');
    expect(t.stages.find((s) => s.stageKey === 'ship')?.blockedKind).toBe('awaiting-merge');
  });

  // Ship used to advance to `done` without ever asking whether the branch could
  // merge, so a ticket could finish carrying a PR nobody could land.
  describe('merge conflict tracking', () => {
    it('records a clean check for each shipped repo', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
      const { gh } = fakeGh();

      await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), gitWithMergeProbe({ exitCode: 0 }));

      const checks = listMergeChecksByTicket(store, id);
      expect(checks.map((c) => [c.repo, c.state])).toEqual([
        ['/repo/backend', 'clean'],
        ['/repo/frontend', 'clean'],
      ]);
      expect(checks[0]?.baseRef).toBe('develop');
    });

    it('records the conflicting files when the branch cannot merge', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = fakeGh();

      await shipTicket(
        store,
        { ticketId: id },
        gh,
        fakeAdapter(),
        gitWithMergeProbe({ exitCode: 1, stdout: MERGE_TREE_CONFLICT }),
      );

      const [check] = listMergeChecksByTicket(store, id);
      expect(check?.state).toBe('conflicted');
      expect(check?.files).toEqual(['src/a.ts', 'src/b.ts']);
    });

    // The decision this feature turns on: `ship` has no `failed` edge, so making a
    // conflict fail the stage would park the ticket at `ship` forever — and a
    // retry cannot resolve a conflict, only a human rebase can. The PR exists, so
    // the ship succeeded; the conflict is recorded state, not a verdict.
    it('a conflict does not fail the ship — the ticket still parks at ship awaiting the merge', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = fakeGh();

      const res = await shipTicket(
        store,
        { ticketId: id },
        gh,
        fakeAdapter(),
        gitWithMergeProbe({ exitCode: 1, stdout: MERGE_TREE_CONFLICT_ONE }),
      );

      expect(res.prs).toHaveLength(1);
      const t = getTicket(store, id);
      expect(t.stageCurrent).toBe('ship');
      expect(t.stages.find((s) => s.stageKey === 'ship')?.status).toBe('passed');
      expect(t.stages.find((s) => s.stageKey === 'ship')?.blockedKind).toBe('awaiting-merge');
    });

    // Distinguishing "checked, no conflict" from "could not check" is the point.
    // A probe that fails must never be recorded as clean.
    it('records unknown, not clean, when the check itself fails', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = fakeGh();
      const git: GitRunner = async (args) => {
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: "fatal: couldn't find remote ref develop", exitCode: 128 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git);

      const [check] = listMergeChecksByTicket(store, id);
      expect(check?.state).toBe('unknown');
      expect(check?.reason).toContain("couldn't find remote ref develop");
      expect(getTicket(store, id).stageCurrent).toBe('ship');
    });

    // The staleness requirement: the base moves under a PR nobody touched, so the
    // re-ship that skips all the PR work is exactly when a fresh answer matters.
    it('refreshes the check on a re-ship, even for a repo whose PR already exists', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = fakeGh();
      await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), gitWithMergeProbe({ exitCode: 0 }));
      expect(listMergeChecksByTicket(store, id)[0]?.state).toBe('clean');

      // Base moved; the same branch no longer merges.
      await shipTicket(
        store,
        { ticketId: id },
        gh,
        fakeAdapter(),
        gitWithMergeProbe({ exitCode: 1, stdout: MERGE_TREE_CONFLICT_ONE }),
      );

      const checks = listMergeChecksByTicket(store, id);
      expect(checks).toHaveLength(1); // overwritten, not appended
      expect(checks[0]?.state).toBe('conflicted');
    });

    // Observability must not be able to sink the operation it observes.
    it('a failure to record the check does not fail the ship', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = fakeGh();
      store.db.exec('DROP TABLE merge_checks');

      const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);

      expect(res.prs).toHaveLength(1);
      expect(getTicket(store, id).stageCurrent).toBe('ship');
    });

    // A ship that never opened a PR has not shipped; there is nothing to report
    // mergeability about, and the stage stays parked.
    it('records nothing when the ship itself failed', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const gh: GhRunner = async () => ({ stdout: '', stderr: 'gh: not authenticated', exitCode: 1 });

      await expect(
        shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git),
      ).rejects.toThrow();

      expect(listMergeChecksByTicket(store, id)).toEqual([]);
    });
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

  // The guard on the tail transition (only advance when still AT ship) is not
  // enough on its own: the head `setStage(..., 'ship', {status:'running', ...})`
  // ran unconditionally, so a re-run past ship would leave the `ship` row stuck
  // `running` — blue/in-progress on the dashboard — beside a ticket still
  // parked at `ship`, blocked on the merge gate, a state that could not occur
  // before this guard existed (the old unconditional tail transition always
  // repaired it back to `passed`). Both writes must agree on whether this run
  // is genuinely at ship.
  it('a re-run past ship leaves the ship row exactly as the first run left it', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const { gh } = fakeGh();

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    const afterFirst = getTicket(store, id);
    expect(afterFirst.stageCurrent).toBe('ship');
    expect(afterFirst.stages.find((s) => s.stageKey === 'ship')!.status).toBe('passed');

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    const afterSecond = getTicket(store, id);
    expect(afterSecond.stageCurrent).toBe('ship');
    // Not 'running': the re-run's head setStage must have been skipped too.
    expect(afterSecond.stages.find((s) => s.stageKey === 'ship')!.status).toBe('passed');
  });

  // The dashboard used to render this as free text on the Now line; it now
  // reads it as structured per-repo/per-step rows inside the Inside block, so
  // ship must emit run→pass pairs in the order the work happens.
  describe('structured progress events', () => {
    function pairs(events: ShipStepEvent[]): [string, string][] {
      return events.map((e) => [e.step, e.status]);
    }

    it('emits run then pass for commit, push, describe, and pr, in order', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const events: ShipStepEvent[] = [];
      await shipTicket(
        store,
        { ticketId: id },
        fakeGh().gh,
        fakeAdapter(),
        gitWithMergeProbe({ exitCode: 0 }),
        (e) => events.push(e),
      );

      expect(pairs(events)).toEqual([
        ['commit', 'note'],
        ['push', 'run'],
        ['push', 'pass'],
        ['pr', 'run'],
        ['describe', 'run'],
        ['describe', 'pass'],
        ['pr', 'pass'],
        ['merge', 'run'],
        ['merge', 'pass'],
      ]);
      expect(events.every((e) => e.repo === '/repo/frontend')).toBe(true);
    });

    it('carries the repo on every event when several worktrees ship', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
      const events: ShipStepEvent[] = [];
      await shipTicket(
        store,
        { ticketId: id },
        fakeGh().gh,
        fakeAdapter(),
        fakeGit().git,
        (e) => events.push(e),
      );

      expect(events.some((e) => e.repo === '/repo/frontend' && e.step === 'push')).toBe(true);
      expect(events.some((e) => e.repo === '/repo/backend' && e.step === 'push')).toBe(true);
    });

    it('does not emit a describe event when there is no adapter', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const events: ShipStepEvent[] = [];
      await shipTicket(
        store,
        { ticketId: id },
        fakeGh().gh,
        undefined,
        fakeGit().git,
        (e) => events.push(e),
      );

      // The describe step IS the model call; without an AI process there is no
      // run to report, and the deterministic fallback says nothing.
      expect(events.some((e) => e.step === 'describe')).toBe(false);
      expect(events.some((e) => e.step === 'pr' && e.status === 'pass')).toBe(true);
    });

    // The idempotent-retry path used to emit nothing for a skipped repo — a
    // silent gap in the live view. It must say what happened, honestly: `note`,
    // never `pass`, since commit/push did not run this time.
    it('emits a note, not a pass, for a repo whose PR was already open', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      store.db
        .prepare("INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 1, 'u', 'open')")
        .run(id, '/repo/frontend');
      const events: ShipStepEvent[] = [];
      await shipTicket(
        store,
        { ticketId: id },
        fakeGh().gh,
        fakeAdapter(),
        fakeGit().git,
        (e) => events.push(e),
      );

      // Every step this repo skips must say so — commit/push must not sit at an
      // implied "still to come" with no event ever explaining why they never run.
      // Merge still runs (mergeability is re-checked on every ship, even for a
      // repo whose PR-opening was skipped), so it is exempt from the note check.
      const skippedEvents = events.filter((e) => e.step !== 'merge');
      expect(skippedEvents.map((e) => e.step)).toEqual(['commit', 'push', 'describe', 'pr']);
      expect(skippedEvents.every((e) => e.status === 'note' && e.repo === '/repo/frontend')).toBe(true);
      expect(events.some((e) => e.step === 'merge')).toBe(true);
    });

    it('resolves the merge event to the same status the persisted check gets', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const events: ShipStepEvent[] = [];
      await shipTicket(
        store,
        { ticketId: id },
        fakeGh().gh,
        fakeAdapter(),
        gitWithMergeProbe({ exitCode: 1, stdout: MERGE_TREE_CONFLICT_ONE }),
        (e) => events.push(e),
      );

      const merge = events.find((e) => e.step === 'merge' && e.status !== 'run');
      expect(merge?.status).toBe('fail');
    });
  });

  // Finding 12: live Ship flows through the SAME generic inside-progress union
  // as gates and Fix — one 'ship' process, `active` while the invocation runs
  // and a complete process row when it settles — never the raw per-repo/
  // per-step `ship-progress` structures the dashboard used to derive from.
  describe('inside progress events', () => {
    it('emits an active ship event when the invocation starts', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const events: InsideProgressEvent[] = [];
      await shipTicket(
        store,
        { ticketId: id },
        fakeGh().gh,
        fakeAdapter(),
        fakeGit().git,
        () => {},
        (e) => events.push(e),
      );

      expect(events[0]).toEqual({
        kind: 'active',
        ticketId: id,
        stage: 'ship',
        processId: 'ship',
        live: { status: 'run', label: 'Shipping' },
      });
    });

    it('emits a completed pass process when the ship settles', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const events: InsideProgressEvent[] = [];
      await shipTicket(
        store,
        { ticketId: id },
        fakeGh().gh,
        fakeAdapter(),
        fakeGit().git,
        () => {},
        (e) => events.push(e),
      );

      expect(events.filter((e) => e.kind === 'completed')).toContainEqual({
        kind: 'completed',
        ticketId: id,
        stage: 'ship',
        process: { id: 'pr', kind: 'ship', label: 'Ship', status: 'pass' },
      });
    });

    it('emits a completed fail process when the ship errors', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const events: InsideProgressEvent[] = [];
      const git: GitRunner = async (args) => {
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
        if (args[0] === 'push') {
          return { stdout: '', stderr: "fatal: 'origin' does not appear to be a git repository", exitCode: 128 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      await expect(
        shipTicket(
          store,
          { ticketId: id },
          fakeGh().gh,
          fakeAdapter(),
          git,
          () => {},
          (e) => events.push(e),
        ),
      ).rejects.toThrow(/does not appear to be a git repository/);

      expect(events.filter((e) => e.kind === 'completed')).toContainEqual({
        kind: 'completed',
        ticketId: id,
        stage: 'ship',
        process: { id: 'pr', kind: 'ship', label: 'Ship', status: 'fail' },
      });
    });
  });

  describe('ship saga evidence', () => {
    it('adopts a commit that landed before the run crashed, then completes the ship on retry', async () => {
      const worktree = join(dir, 'fe');
      seedWorktree(store, id, '/repo/frontend', worktree);
      await initRealRepo(worktree);
      writeFileSync(join(worktree, 'work.txt'), 'work');

      // First run: the HEAD compare-and-swap lands (update-ref succeeds) but
      // the owned index install crashes — the crash window the saga exists for.
      let readTreeCalls = 0;
      const crashing: GitRunner = async (args, cwd) => {
        if (args[0] === 'read-tree') {
          readTreeCalls++;
          if (readTreeCalls === 1) {
            return { stdout: '', stderr: 'interrupted', exitCode: 1 };
          }
        }
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
        if (args[0] === 'push') return { stdout: '', stderr: '', exitCode: 0 };
        return defaultGitRunner(args, cwd);
      };
      const { gh } = fakeGh();
      await expect(
        shipTicket(store, { ticketId: id }, gh, fakeAdapter(), crashing),
      ).rejects.toThrow(/commit refused.*install-failed/);
      expect(getTicket(store, id).stageCurrent).toBe('ship');

      const crashedHead = (await runGit(['rev-parse', 'HEAD'], worktree)).stdout.trim();

      // Second run: reconciliation adopts the landed commit (completing the
      // index install, recording provenance exactly once), and the fresh loop
      // finishes the ship on top of it.
      await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), dirtyRealRepo([]));
      // PRs opened → the ticket parks at ship awaiting their merge; the run
      // itself closed passed.
      expect(getTicket(store, id).stageCurrent).toBe('ship');
      expect(listPrsByTicket(store, id)).toHaveLength(1);
      expect((await runGit(['rev-parse', 'HEAD'], worktree)).stdout.trim()).toBe(crashedHead);
      expect(listShipEvidence(store, id).run?.status).toBe('passed');

      // The interrupted run's step row was adopted, not left lying as failed
      // (the retry's own worktree was clean, so it opened no commit step), and
      // its provenance recorded exactly once.
      const stepRows = store.db
        .prepare("SELECT status, detail FROM ship_repo_steps WHERE step = 'commit' AND repo = ?")
        .all('/repo/frontend') as { status: string; detail: string }[];
      expect(stepRows).toHaveLength(1);
      expect(stepRows[0]!.status).toBe('passed');
      expect(stepRows[0]!.detail).toContain('adopted commit');
      const allCommits = store.db
        .prepare("SELECT origin, sha FROM ship_commits WHERE repo = ? ORDER BY id")
        .all('/repo/frontend') as { origin: string; sha: string }[];
      const created = allCommits.filter((c) => c.origin === 'created-by-ship');
      expect(created).toHaveLength(1);
      expect(created[0]!.sha).toBe(crashedHead);
    });

    it('keeps a partially successful ship: one repo lands, the failing repo stays at ship', async () => {
      const fe = join(dir, 'fe');
      const be = join(dir, 'zz');
      seedWorktree(store, id, '/repo/frontend', fe);
      seedWorktree(store, id, '/repo/backend', be);
      await initRealRepo(fe);
      await initRealRepo(be);
      writeFileSync(join(fe, 'work.txt'), 'work');
      writeFileSync(join(be, 'work.txt'), 'work');

      const git: GitRunner = async (args, cwd) => {
        if (args[0] === 'push') {
          if (cwd === be) {
            return { stdout: '', stderr: "fatal: 'origin' does not appear to be a git repository", exitCode: 128 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'diff') return { stdout: '', stderr: '', exitCode: 1 };
        return defaultGitRunner(args, cwd);
      };
      const { gh } = fakeGh();

      await expect(shipTicket(store, { ticketId: id }, gh, fakeAdapter(), git)).rejects.toThrow(
        /does not appear to be a git repository/,
      );
      expect(getTicket(store, id).stageCurrent).toBe('ship');

      const evidence = listShipEvidence(store, id);
      expect(evidence.repos['/repo/frontend']?.pr?.status).toBe('passed');
      expect(evidence.repos['/repo/frontend']?.pr?.prNumber).not.toBeNull();
      expect(evidence.repos['/repo/backend']?.push?.status).toBe('failed');
      expect(evidence.repos['/repo/frontend']?.commits.some((c) => c.origin === 'created-by-ship')).toBe(true);
      // The failing repo committed and pushed nothing; the run that failed is
      // not a ship — the ticket stays parked, and the push step names the fault.
      expect(evidence.repos['/repo/backend']?.commit?.status).toBe('passed');
      expect(evidence.repos['/repo/backend']?.push?.detail).toContain('origin');
      expect(evidence.run?.status).toBe('failed');
    });
  });
});
