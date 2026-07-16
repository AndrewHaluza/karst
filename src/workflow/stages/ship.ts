import type { Store } from '../../store/db.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { setStage } from '../../store/stages.js';
import { nowIso } from '../../model/time.js';
import { openPr, defaultGhRunner, type GhRunner } from '../../integrations/github.js';
import { pushBranch, defaultGitRunner, type GitRunner } from '../../integrations/git.js';

/**
 * Ship stage (§T4.5, §11, §12). Opens one PR per hot repo — independently, no
 * ordering (cross-repo merge ordering is out of scope) — each with an
 * agent-generated description (cheap model, via the adapter), writes the PR rows
 * to `prs`, then advances the stage to done.
 *
 * [L4] ship (PRs) and done (ticket status) have independent failure modes and
 * live in separate files; they share no state beyond the ticket id.
 */

export interface ShipOpts {
  ticketId: number;
}

export interface ShippedPr {
  repo: string;
  number: number | null;
  url: string;
}

export interface ShipResult {
  prs: ShippedPr[];
}

/** Ask the agent (cheap model) for a PR description; falls back to the title. */
async function describePr(
  adapter: AgentAdapter,
  cwd: string,
  title: string,
): Promise<string> {
  const r = await adapter.runHeadless({
    prompt: `Write a concise pull-request description for the changes in this worktree. Title: ${title}`,
    cwd,
  });
  return r.raw.trim() || title;
}

export async function shipTicket(
  store: Store,
  opts: ShipOpts,
  gh: GhRunner = defaultGhRunner,
  adapter?: AgentAdapter,
  git: GitRunner = defaultGitRunner,
): Promise<ShipResult> {
  const ticket = getTicket(store, opts.ticketId);
  const worktrees = listWorktreesByTicket(store, opts.ticketId);
  const title = ticket.title ?? ticket.key ?? `Ticket ${opts.ticketId}`;

  const insert = store.db.prepare(
    "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, 'open')",
  );
  // Idempotency (§5.3): a re-run after a crash mid-ship must not re-open a PR for
  // a repo already shipped. Skip any worktree with an existing open PR row.
  const existingOpen = store.db.prepare(
    "SELECT repo, number, url FROM prs WHERE ticket_id = ? AND repo = ? AND status = 'open'",
  );

  // A retry re-runs this stage: clear any reason the last attempt recorded, so a
  // stale failure can't outlive the run that fixed it.
  setStage(store, opts.ticketId, 'ship', { status: 'running', verdict: null, endedAt: null });

  const prs: ShippedPr[] = [];
  try {
    for (const wt of worktrees) {
      const prior = existingOpen.get(opts.ticketId, wt.repo) as
        | { repo: string; number: number | null; url: string }
        | undefined;
      if (prior) {
        prs.push({ repo: prior.repo, number: prior.number, url: prior.url });
        continue;
      }
      // Push FIRST. `gh pr create` refuses a branch that exists only on this
      // machine ("you must first push the current branch to a remote"), and every
      // ticket works on a fresh worktree branch — so the branch is always
      // local-only until now. Before the model call, too: a push that cannot
      // succeed makes the PR impossible, and paying for a description first buys
      // prose for a PR that will never exist.
      await pushBranch(git, wt.path);
      const body = adapter ? await describePr(adapter, wt.path, title) : title;
      const opened = await openPr(gh, { cwd: wt.path, title, body });
      insert.run(opts.ticketId, wt.repo, opened.number, opened.url);
      prs.push({ repo: wt.repo, number: opened.number, url: opened.url });
    }
  } catch (err) {
    // Ship has no `failed` edge (graph.ts): a ticket whose PRs did not open has
    // NOT shipped, so it must stay at ship rather than advance. Record the reason
    // on the stage row — that is what the dashboard renders (a red node + the
    // fault card), so a failed ship is visible instead of a ticket that just sits
    // at "running" with the truth buried in the output channel. Re-thrown so the
    // caller still reports it; the PRs already opened stay recorded (idempotent
    // re-run skips them).
    setStage(store, opts.ticketId, 'ship', {
      status: 'failed',
      verdict: err instanceof Error ? err.message : String(err),
      endedAt: nowIso(),
    });
    throw err;
  }

  // PRs opened → ship passes → done.
  transition(store, opts.ticketId, 'ship', { kind: 'passed' });

  return { prs };
}
