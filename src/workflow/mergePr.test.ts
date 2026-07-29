import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listPrsByTicket } from '../store/dashboard.js';
import type { GhRunner } from '../integrations/github.js';
import { mergeTicketPr } from './mergePr.js';

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

    expect(r).toEqual({ ok: true, status: 'merged', reason: '' });
    expect(calls[0]).toEqual(['pr', 'merge', PR12, '--squash']);
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

    expect(r).toEqual({ ok: true, status: 'merged', reason: '' });
    expect(listPrsByTicket(store, a.id)[0]!.mergedAt).toBe('2026-07-28T09:30:00Z');
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

    expect(r).toEqual({ ok: true, status: 'merged', reason: '' });
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
