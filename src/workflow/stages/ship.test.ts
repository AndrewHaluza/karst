import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket, updateTicketFields } from '../../store/tickets.js';
import { listPrsByTicket } from '../../store/dashboard.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { transition } from '../machine.js';
import { shipTicket, type ShipStepEvent } from './ship.js';
import type { GhRunner } from '../../integrations/github.js';
import type { GitRunner } from '../../integrations/git.js';
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
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const git: GitRunner = async (args) => ({
      stdout: args[0] === 'status' ? ' M src/a.ts\n' : '',
      stderr: '',
      exitCode: args[0] === 'diff' ? 1 : 0,
    });
    const calls: string[][] = [];
    const recording: GitRunner = async (args, cwd) => {
      calls.push(args);
      return git(args, cwd);
    };
    const { gh } = fakeGh();

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), recording);

    expect(mutating(calls.map((args) => ({ args }))).map((c) => c.args)).toEqual([
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'add search'],
      ['push', '-u', 'origin', 'HEAD'],
    ]);
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
        'git diff',
        'gh pr create',
        'gh pr view',
        'git fetch',
      ]);
    });
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

  it('each PR carries a deterministic description without calling the agent', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const gh: GhRunner = async (args) => {
      if (args[1] === 'view') return { stdout: '', stderr: 'no pull requests found', exitCode: 1 };
      // With no collected metadata the safe deterministic fallback is the title.
      const bodyIdx = args.indexOf('--body');
      expect(args[bodyIdx + 1]).toBe('add search');
      return { stdout: 'https://github.com/o/r/pull/9', exitCode: 0 };
    };
    const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
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

    function dirtyGit(calls: string[][]): GitRunner {
      return async (args) => {
        calls.push(args);
        return {
          stdout: args[0] === 'status' ? ' M src/a.ts\n' : '',
          stderr: '',
          // Upstream's baseline-aware ship path reads `git diff --quiet`;
          // exit 1 means this branch has changes and therefore needs a PR.
          exitCode: args[0] === 'diff' ? 1 : 0,
        };
      };
    }

    it('applies all three configured templates to the exact git and gh arguments', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
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
        dirtyGit(gitCalls),
      );

      expect(gitCalls).toContainEqual([
        'commit',
        '-m',
        'feat(frontend): add search [PROJ-1]',
      ]);
      expect(creates).toEqual([[
        'pr',
        'create',
        '--title',
        '[PROJ-1] add search (frontend)',
        '--body',
        '# add search\n\n[PROJ-1] add search (frontend)\n\nTicket 1',
        '--base',
        'develop',
      ]]);
      expect(headless).toBe(0);
    });

    it('renders {type} from the ticket and {scope} from the repository', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      updateTicketFields(store, id, { type: 'fix' });
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
        dirtyGit(gitCalls),
      );

      expect(gitCalls).toContainEqual(['commit', '-m', 'fix(web): add search [PROJ-1]']);
      expect(creates[0]).toContain('fix(web): add search');
    });

    it('falls back to the manifest default type and the repository name as scope', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
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
        dirtyGit(gitCalls),
      );

      expect(gitCalls).toContainEqual(['commit', '-m', 'chore(frontend): add search']);
    });

    it('falls back to feat when neither the ticket nor the manifest sets a type', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const gitCalls: string[][] = [];
      const { gh } = recordingGh();

      await shipTicket(
        store,
        { ticketId: id, conventions: { commitMessage: '{type}: {title}' } },
        gh,
        undefined,
        dirtyGit(gitCalls),
      );

      expect(gitCalls).toContainEqual(['commit', '-m', 'feat: add search']);
    });

    it('keeps absent commit and body behavior when only the PR title is configured', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
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
        dirtyGit(gitCalls),
      );

      expect(gitCalls).toContainEqual(['commit', '-m', 'add search']);
      expect(prompts).toEqual([]);
      expect(creates[0]).toEqual([
        'pr',
        'create',
        '--title',
        '[PROJ-1] add search',
        '--body',
        '[PROJ-1] add search',
        '--base',
        'develop',
      ]);
    });

    it('renders branch-only facts locally and never calls the tool-capable adapter', async () => {
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

      await shipTicket(store, { ticketId: id, model: 'cheap-model' }, gh, adapter, git);

      expect(headless).toBe(0);
      const body = creates[0]![creates[0]!.indexOf('--body') + 1]!;
      expect(body).toContain('## Summary');
      expect(body).toContain('- add search');
      expect(body).toContain('src/a.ts | 3 ++');
    });

    it('still describes when the diff cannot be read — a failed read never fails ship', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh } = recordingGh();
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        runHeadless: async () => { throw new Error('must not run'); },
      };
      const git: GitRunner = async (args) => {
        if (args[0] === 'diff' && args[1] === '--quiet') return { stdout: '', stderr: '', exitCode: 1 };
        if (['fetch', 'status', 'push', 'add', 'commit'].includes(args[0]!)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'boom', exitCode: 128 };
      };

      await expect(
        shipTicket(store, { ticketId: id }, gh, adapter, git),
      ).resolves.toBeDefined();

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

  // PR bodies no longer consume an agent answer, so chat scaffolding and tool
  // exploration cannot reach GitHub metadata at all.
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

    it('ignores agent chatter and renders only repository-local facts', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();

      await shipTicket(store, { ticketId: id }, gh, chattyAdapter(), fakeGit().git);

      const body = bodyOf(creates);
      expect(body).toBe('add search');
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
      expect(body.startsWith('add search')).toBe(true);
      expect(body).toContain('Ticket PROJ-1');
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
    expect(t.stageCurrent).toBe('merge');
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
      expect(getTicket(store, id).stageCurrent).toBe('merge');
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
        expect(edit).toEqual(['pr', 'edit', URL, '--body', '## Summary\nadd search']);
        expect(events).toContainEqual({
          repo: '/repo/frontend',
          step: 'describe',
          status: 'pass',
          detail: 'existing PR had no description — filled in',
        });
        expect(getTicket(store, id).stageCurrent).toBe('merge');
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
        expect(getTicket(store, id).stageCurrent).toBe('merge');
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
        expect(getTicket(store, id).stageCurrent).toBe('merge');
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
      // same rule: fill an empty description, never overwrite a written one.
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
          'add search',
        ]);
        expect(headless).toBe(0);
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

  it('advances the stage to merge on success — an open PR is not a landing', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const { gh } = fakeGh();
    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    expect(getTicket(store, id).stageCurrent).toBe('merge');
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
    it('a conflict does not fail the ship — the ticket still reaches merge', async () => {
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
      expect(t.stageCurrent).toBe('merge');
      expect(t.stages.find((s) => s.stageKey === 'ship')?.status).toBe('passed');
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
      expect(getTicket(store, id).stageCurrent).toBe('merge');
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
      expect(getTicket(store, id).stageCurrent).toBe('merge');
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
  // `running` — blue/in-progress on the dashboard — beside a ticket already
  // parked at `merge`, a state that could not occur before this guard existed
  // (the old unconditional tail transition always repaired it back to
  // `passed`). Both writes must agree on whether this run is genuinely at ship.
  it('a re-run past ship leaves the ship row exactly as the first run left it', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const { gh } = fakeGh();

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    const afterFirst = getTicket(store, id);
    expect(afterFirst.stageCurrent).toBe('merge');
    expect(afterFirst.stages.find((s) => s.stageKey === 'ship')!.status).toBe('passed');

    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    const afterSecond = getTicket(store, id);
    expect(afterSecond.stageCurrent).toBe('merge');
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
        ['commit', 'run'],
        ['commit', 'pass'],
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

    it('emits describe progress even when no adapter exists', async () => {
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

      expect(events.some((e) => e.step === 'describe' && e.status === 'pass')).toBe(true);
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
});
