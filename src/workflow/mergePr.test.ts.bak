import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { listPrsByTicket } from '../store/dashboard.js';
import type { GhRunner } from '../integrations/github.js';
import type { GitRunner } from '../integrations/git.js';
import { mergeAllPrs, mergeTicketPr, type MergeAllDeps, type MergeAllPlan } from './mergePr.js';
import { resolveShipLanding } from './mergeGate.js';

const PR12 = 'https://github.com/o/r/pull/12';

function seedPr(store: Store, ticketId: number, repo: string, status: string): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, 12, PR12, status);
}

function seedWorktree(store: Store, ticketId: number, repo: string, path: string): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, path, `karst/${repo}`, 'main');
}

/**
 * A gh that accepts (or refuses) `pr merge` and answers `pr view` with a given
 * post-merge state — the two calls `mergeTicketPr` makes, in order.
 */
function ghFake(opts: {
  merge?: { exitCode: number; stderr?: string };
  view?: Record<string, unknown> | 'fail';
}): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[1] === 'merge') {
      const m = opts.merge ?? { exitCode: 0 };
      return { stdout: '', exitCode: m.exitCode, stderr: m.stderr ?? '' };
    }
    if (opts.view === 'fail') return { stdout: '', exitCode: 1, stderr: 'gone' };
    return { stdout: JSON.stringify(opts.view ?? { state: 'MERGED' }), exitCode: 0 };
  };
  return { gh, calls };
}

describe('mergeTicketPr', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('merges the repo’s PR and records the re-probed merged state', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    const { gh, calls } = ghFake({
      view: { state: 'MERGED', mergedAt: '2026-07-28T09:30:00Z', headRefName: 'karst/x', baseRefName: 'main' },
    });

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'squash' }, gh);

    expect(r).toEqual({ ok: true, status: 'merged', completedTicket: false, reason: '' });
    expect(calls.find((c) => c[1] === 'merge')).toEqual(['pr', 'merge', PR12, '--squash']);
    // The stored row reflects the REAL state, re-read from gh — never assumed
    // from the exit code.
    expect(listPrsByTicket(store, a.id)[0]).toMatchObject({
      status: 'merged',
      mergedAt: '2026-07-28T09:30:00Z',
      headRef: 'karst/x',
      baseRef: 'main',
    });
  });

  // The reason is gh's own words, and the row is still refreshed: a refused merge
  // may still have brought back new comments or a status that moved elsewhere.
  it('reports a refusal in gh’s words and leaves the PR unmerged', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    const { gh } = ghFake({
      merge: { exitCode: 1, stderr: 'Pull Request is not mergeable: merge conflicts.' },
      view: { state: 'OPEN', comments: [{ body: 'please rebase' }] },
    });

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'squash' }, gh);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('Pull Request is not mergeable: merge conflicts.');
    expect(r.status).toBe('open');
    const pr = listPrsByTicket(store, a.id)[0]!;
    expect(pr.status).toBe('open');
    expect(pr.comments).toEqual([{ author: '', at: null, body: 'please rebase' }]);
  });

  // The whole point of re-probing: a zero exit is not proof. If the PR does not
  // read merged afterwards, say so rather than painting the UI merged.
  it('refuses to claim success when the PR does not read merged afterwards', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    const { gh } = ghFake({ merge: { exitCode: 0 }, view: { state: 'OPEN' } });

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'merge' }, gh);

    expect(r.ok).toBe(false);
    expect(r.status).toBe('open');
    expect(r.reason).toMatch(/still reads open/);
    expect(listPrsByTicket(store, a.id)[0]!.status).toBe('open');
  });

  it('says plainly when it cannot confirm the outcome at all', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    const { gh } = ghFake({ merge: { exitCode: 0 }, view: 'fail' });

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'merge' }, gh);

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not confirm/i);
    // The unconfirmable probe never overwrites the status we last knew.
    expect(listPrsByTicket(store, a.id)[0]!.status).toBe('open');
  });

  // A merge that landed some other way (a teammate, the GitHub UI) is still the
  // outcome the user asked for — reflect the truth, not the exit code.
  it('reports success when the PR is already merged upstream despite a nonzero exit', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    const { gh } = ghFake({
      merge: { exitCode: 1, stderr: 'Pull request #12 is already merged' },
      view: { state: 'MERGED', mergedAt: '2026-07-28T09:30:00Z' },
    });

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'squash' }, gh);

    expect(r).toEqual({ ok: true, status: 'merged', completedTicket: false, reason: '' });
    expect(listPrsByTicket(store, a.id)[0]!.mergedAt).toBe('2026-07-28T09:30:00Z');
  });

  // Landing the last PR is what makes a ticket done — the whole point of the
  // merge stage. Reported on the result so the host pushes the provider's
  // post-delivery status exactly once, from the call that actually finished it.
  it('completes a ticket parked at merge when its last PR lands', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) {
      transition(store, a.id, from, { kind: 'passed' });
    }
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    // Mirrors ship's own tail: an open PR parks the ticket at `ship` blocked on
    // the merge gate, rather than landing it straight away.
    resolveShipLanding(store, a.id);
    const { gh } = ghFake({ view: { state: 'MERGED', mergedAt: '2026-07-28T09:30:00Z' } });

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'squash' }, gh);

    expect(r.ok).toBe(true);
    expect(r.completedTicket).toBe(true);
    expect(getTicket(store, a.id).stageCurrent).toBe('done');
  });

  // A multi-repo ticket is not done because ONE repo landed. Saying otherwise is
  // the bug the merge stage exists to prevent, one repo further along.
  it('does not complete a ticket whose other repo is still open', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    for (const from of ['scope', 'impl', 'uat', 'review'] as const) {
      transition(store, a.id, from, { kind: 'passed' });
    }
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    store.db
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, 'web', 13, 'https://github.com/o/r/pull/13', 'open');
    // Mirrors ship's own tail: two unmerged PRs park the ticket at `ship`
    // blocked on the merge gate.
    resolveShipLanding(store, a.id);
    const { gh } = ghFake({ view: { state: 'MERGED' } });

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'squash' }, gh);

    expect(r.ok).toBe(true);
    expect(r.completedTicket).toBe(false);
    expect(getTicket(store, a.id).stageCurrent).toBe('ship');
  });

  it('never runs gh when the ticket has no PR for that repo', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedWorktree(store, a.id, 'api', '/wt/api');
    const { gh, calls } = ghFake({});

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'squash' }, gh);

    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.reason).toMatch(/no pull request/i);
    expect(calls).toEqual([]);
  });

  // A stale panel can name a PR that has since merged. Nothing is lost and nothing
  // is re-run: the answer is the state, not an error.
  it('does not re-merge a PR already recorded as merged', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 'merged');
    seedWorktree(store, a.id, 'api', '/wt/api');
    const { gh, calls } = ghFake({});

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'squash' }, gh);

    expect(r).toEqual({ ok: true, status: 'merged', completedTicket: false, reason: '' });
    expect(calls).toEqual([]);
  });

  it('never throws when the runner itself blows up', async () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    const gh: GhRunner = async () => {
      throw new Error('spawn failed');
    };

    const r = await mergeTicketPr(store, { ticketId: a.id, repo: 'api', method: 'squash' }, gh);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('spawn failed');
    expect(listPrsByTicket(store, a.id)[0]!.status).toBe('open');
  });
});

describe('mergeAllPrs', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const seed = (ticketId: number, repo: string, number: number, mergeBlock: string): void => {
    store.db
      .prepare("INSERT INTO prs (ticket_id, repo, number, url, status, base_ref, merge_block) VALUES (?, ?, ?, ?, 'open', 'main', ?)")
      .run(ticketId, repo, number, `https://github.com/o/${repo}/pull/${number}`, mergeBlock);
  };
  const MERGED = { ok: true, status: 'merged', completedTicket: false, reason: '' } as const;

  function setup(over: Partial<MergeAllDeps> = {}) {
    const t = createTicket(store, { key: 'A', title: 'a' });
    seed(t.id, 'web', 1, 'clean');
    seed(t.id, 'api', 2, 'clean');
    seed(t.id, 'docs', 3, 'blocked');
    const order: string[] = [];
    const plans: MergeAllPlan[] = [];
    const deps: MergeAllDeps = {
      ticketId: t.id,
      repoOrder: ['api', 'web', 'docs'],
      repoNameFor: () => undefined,
      now: () => '2026-11-10T12:00:00Z',
      refresh: async () => {
        order.push('refresh');
      },
      autofixRunning: () => false,
      confirm: async (plan) => {
        order.push('confirm');
        plans.push(plan);
        return true;
      },
      merge: async (repo) => {
        order.push(`merge ${repo}`);
        return MERGED;
      },
      ...over,
    };
    return { deps, order, plans, ticketId: t.id };
  }

  it('re-probes before the modal, then merges the ready PRs in manifest order and skips the blocked one', async () => {
    const { deps, order, plans } = setup();
    const r = await mergeAllPrs(store, deps);
    expect(order).toEqual(['refresh', 'confirm', 'merge api', 'merge web']);
    expect(plans[0]!.ready.map((i) => i.repo)).toEqual(['api', 'web']);
    expect(plans[0]!.skipped.map((i) => i.repo)).toEqual(['docs']);
    expect(r).toMatchObject({ kind: 'done', failed: null, completedTicket: false });
    expect(r.kind === 'done' && r.merged.map((i) => i.repo)).toEqual(['api', 'web']);
  });

  it('skips every PR while the ticket holds commits that the PRs lack, so none merges', async () => {
    const { deps, order } = setup({ unpushed: () => 1 });
    const r = await mergeAllPrs(store, deps);
    expect(r.kind).toBe('refused');
    expect(order).toEqual(['refresh']);
  });

  it('merges nothing when the user cancels', async () => {
    const { deps, order } = setup({ confirm: async () => false });
    expect(await mergeAllPrs(store, deps)).toEqual({ kind: 'cancelled' });
    expect(order).toEqual(['refresh']);
  });

  it('stops at the first failure and leaves the later PRs untried', async () => {
    const { deps, order } = setup({
      merge: async (repo) => (repo === 'api' ? { ok: false, status: 'open', completedTicket: false, reason: 'checks pending' } : MERGED),
    });
    const r = await mergeAllPrs(store, deps);
    expect(r).toMatchObject({ kind: 'done', merged: [], failed: { reason: 'checks pending' } });
    expect(r.kind === 'done' && r.failed?.item.repo).toBe('api');
    expect(order).not.toContain('merge web');
  });

  it('reports the ticket complete when a merge completes it', async () => {
    const { deps } = setup({ merge: async () => ({ ...MERGED, completedTicket: true }) });
    expect(await mergeAllPrs(store, deps)).toMatchObject({ kind: 'done', completedTicket: true });
  });

  it('is refused while an auto-fix round runs, before any probe', async () => {
    const { deps, order } = setup({ autofixRunning: () => true });
    expect(await mergeAllPrs(store, deps)).toEqual({ kind: 'refused', reason: 'An auto-fix round is running' });
    expect(order).toEqual([]);
  });

  it('is refused when a round starts during the re-probe', async () => {
    let calls = 0;
    const { deps, order } = setup({ autofixRunning: () => ++calls > 1 });
    expect(await mergeAllPrs(store, deps)).toEqual({ kind: 'refused', reason: 'An auto-fix round is running' });
    expect(order).toEqual(['refresh']);
  });

  it('is refused when a round starts while the modal is open', async () => {
    let calls = 0;
    const { deps, order } = setup({ autofixRunning: () => ++calls > 2 });
    expect(await mergeAllPrs(store, deps)).toEqual({ kind: 'refused', reason: 'An auto-fix round is running' });
    expect(order).toEqual(['refresh', 'confirm']);
  });

  it('is refused when no PR is ready', async () => {
    const t = createTicket(store, { key: 'B', title: 'b' });
    seed(t.id, 'web', 1, 'blocked');
    const { deps } = setup({ ticketId: t.id });
    expect(await mergeAllPrs(store, { ...deps, ticketId: t.id })).toEqual({ kind: 'refused', reason: 'No pull request is ready to merge' });
  });

  it('runs one Merge all per ticket', async () => {
    let release: (v: boolean) => void = () => undefined;
    const { deps } = setup({ confirm: () => new Promise<boolean>((res) => (release = res)) });
    const first = mergeAllPrs(store, deps);
    await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(await mergeAllPrs(store, deps)).toEqual({ kind: 'refused', reason: 'Merge all is already running for this ticket.' });
    release(false);
    expect(await first).toEqual({ kind: 'cancelled' });
    // The guard is released: a later run is not refused.
    release = () => undefined;
    expect((await mergeAllPrs(store, { ...deps, confirm: async () => false })).kind).toBe('cancelled');
  });
});

describe('mergeTicketPr head guard', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const PR_HEAD = '952a97b54aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const gitAhead = (count: string, code = 0): { git: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: `${count}\n`, stderr: '', exitCode: code };
    };
    return { git, calls };
  };
  const seed = (): number => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    return a.id;
  };

  it('refuses to merge when the local head is ahead of the PR head, and runs no merge', async () => {
    const id = seed();
    const { gh, calls } = ghFake({ view: { state: 'OPEN', headRefOid: PR_HEAD } });
    const { git } = gitAhead('1');

    const r = await mergeTicketPr(store, { ticketId: id, repo: 'api', method: 'squash' }, gh, git);

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/1 commit.*not on the pull request/);
    expect(calls.some((c) => c[1] === 'merge')).toBe(false);
  });

  it('pins the PR head it checked with --match-head-commit', async () => {
    const id = seed();
    const { gh, calls } = ghFake({ view: { state: 'MERGED', headRefOid: PR_HEAD } });
    const { git, calls: gitCalls } = gitAhead('0');

    const r = await mergeTicketPr(store, { ticketId: id, repo: 'api', method: 'squash' }, gh, git);

    expect(r.ok).toBe(true);
    expect(calls.find((c) => c[1] === 'merge')).toEqual(['pr', 'merge', PR12, '--squash', '--match-head-commit', PR_HEAD]);
    expect(gitCalls[0]).toEqual(['rev-list', '--count', `${PR_HEAD}..HEAD`]);
  });

  it('merges without a pin when gh does not report a head', async () => {
    const id = seed();
    const { gh, calls } = ghFake({ view: { state: 'MERGED' } });
    const { git } = gitAhead('0');

    await mergeTicketPr(store, { ticketId: id, repo: 'api', method: 'squash' }, gh, git);

    expect(calls.find((c) => c[1] === 'merge')).toEqual(['pr', 'merge', PR12, '--squash']);
  });
});
