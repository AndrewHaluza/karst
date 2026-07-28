import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { listPrsByTicket } from '../../store/dashboard.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { transition } from '../machine.js';
import { shipTicket, type ShipStepEvent } from './ship.js';
import type { GhRunner } from '../../integrations/github.js';
import type { GitRunner } from '../../integrations/git.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { manifest, repo } from '../../manifest/fixtures.js';
import { buildPrDescriptionPrompt } from '../prDescription.js';

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
    // receive the branch's new commits. Adopting is not skipping.
    expect(order).toEqual(['git status', 'git push', 'gh pr view', 'gh pr create']);
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
        'gh pr create',
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
        '# add search\n\nGenerated summary.\n\nTicket 1',
        '--base',
        'develop',
      ]]);
      expect(headless).toBe(1);
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
      expect(prompts).toEqual([buildPrDescriptionPrompt('[PROJ-1] add search')]);
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

  // The reported bug: the PR body carried the session's own chatter ("No PR open
  // yet for this branch. Description below (copy-paste ready).") and the whole
  // description sat inside a code fence, so GitHub rendered one monospace block
  // with no markdown at all. The agent's answer is now sanitized before it
  // reaches `--body`; these feed a representative session answer end to end.
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

    it('strips session chatter and the whole-body fence from the created PR body', async () => {
      seedWorktree(store, id, 'frontend', join(dir, 'fe'));
      const { gh, creates } = recordingGh();

      await shipTicket(store, { ticketId: id }, gh, chattyAdapter(), fakeGit().git);

      const body = bodyOf(creates);
      expect(body).not.toMatch(/copy-paste ready/i);
      expect(body).not.toMatch(/no pr open yet/i);
      expect(body).not.toMatch(/let me know/i);
      // No wrapper fence: the body starts with the description itself.
      expect(body.startsWith('```')).toBe(false);
      expect(body.startsWith('## Summary')).toBe(true);
      // The real code block survives, language tag intact.
      expect(body).toContain('```bash\nnpm test\n```');
      expect(body).toContain('`describePr`');
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
      expect(body).not.toMatch(/copy-paste ready/i);
      expect(body).not.toMatch(/no pr open yet/i);
      expect(body.startsWith('## Summary')).toBe(true);
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
      expect(mutating(calls)).toEqual([]);
      expect(listPrsByTicket(store, id)).toHaveLength(1);
    });

    // Probing before the create is what buys this: `describePr` runs BEFORE
    // `openPr`, so rescuing after the failure would still have paid a model call
    // per repo to write prose for a PR that already exists.
    it('asks no model for a description it cannot use', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = ghWithExistingPr(URL);
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
      expect(events).toContainEqual({
        repo: '/repo/frontend',
        step: 'describe',
        status: 'note',
        detail: 'existing PR already open — description not regenerated',
      });
    });
  });

  it('advances the stage to done on success', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const { gh } = fakeGh();
    await shipTicket(store, { ticketId: id }, gh, fakeAdapter(), fakeGit().git);
    expect(getTicket(store, id).stageCurrent).toBe('done');
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
        gitWithMergeProbe({ exitCode: 1, stdout: '9f2c1a0\n\nsrc/a.ts\nsrc/b.ts\n' }),
      );

      const [check] = listMergeChecksByTicket(store, id);
      expect(check?.state).toBe('conflicted');
      expect(check?.files).toEqual(['src/a.ts', 'src/b.ts']);
    });

    // The decision this feature turns on: `ship` has no `failed` edge, so making a
    // conflict fail the stage would park the ticket at `ship` forever — and a
    // retry cannot resolve a conflict, only a human rebase can. The PR exists, so
    // the ship succeeded; the conflict is recorded state, not a verdict.
    it('a conflict does not fail the ship — the ticket still reaches done', async () => {
      seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
      const { gh } = fakeGh();

      const res = await shipTicket(
        store,
        { ticketId: id },
        gh,
        fakeAdapter(),
        gitWithMergeProbe({ exitCode: 1, stdout: '9f2c1a0\n\nsrc/a.ts\n' }),
      );

      expect(res.prs).toHaveLength(1);
      const t = getTicket(store, id);
      expect(t.stageCurrent).toBe('done');
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
      expect(getTicket(store, id).stageCurrent).toBe('done');
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
        gitWithMergeProbe({ exitCode: 1, stdout: '9f2c1a0\n\nsrc/a.ts\n' }),
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
      expect(getTicket(store, id).stageCurrent).toBe('done');
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
        gitWithMergeProbe({ exitCode: 1, stdout: '9f2c1a0\n\nsrc/a.ts\n' }),
        (e) => events.push(e),
      );

      const merge = events.find((e) => e.step === 'merge' && e.status !== 'run');
      expect(merge?.status).toBe('fail');
    });
  });
});
