import type { Store } from '../../store/db.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { setStage } from '../../store/stages.js';
import { nowIso } from '../../model/time.js';
import { openPr, findOpenPr, defaultGhRunner, type GhRunner } from '../../integrations/github.js';
import {
  commitAllIfDirty,
  hasChangesFrom,
  pushBranch,
  defaultGitRunner,
  type GitRunner,
} from '../../integrations/git.js';
import { checkMergeable } from '../mergeCheck.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { mergeOpStatus } from '../../model/mergeCheckView.js';
import type { WorktreeView } from '../../store/dashboard.js';
import type { ArtifactConventions, Manifest } from '../../manifest/types.js';
import { resolveBaselineBranchForPath } from '../../manifest/baselineBranch.js';
import {
  renderArtifactTemplate,
  usesDescription,
  type ArtifactTemplateContext,
} from '../artifactConventions.js';
import { buildPrDescriptionPrompt, sanitizePrDescription } from '../prDescription.js';
import { resolveRepoScope, resolveTicketType } from '../conventionContext.js';

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
  /** Current manifest, read when ship starts rather than captured at ticket creation. */
  manifest?: Manifest;
  /** Direct injection retained for host-agnostic callers and focused tests. */
  conventions?: ArtifactConventions;
}

export interface ShippedPr {
  repo: string;
  number: number | null;
  url: string;
}

export interface ShipResult {
  prs: ShippedPr[];
}

/**
 * Ask the agent (cheap model) for a PR description; falls back to the title.
 *
 * The answer is sanitized, not trusted: an agent asked a chat-shaped question
 * answers with chat-shaped scaffolding (a "no PR open yet … copy-paste ready"
 * status line, a preamble, the whole body inside a code fence), and this text
 * goes straight into public GitHub metadata. `prDescription.ts` owns both halves
 * — the prompt that asks for a clean body and the filter that enforces it.
 */
async function describePr(
  adapter: AgentAdapter,
  cwd: string,
  title: string,
): Promise<string> {
  const r = await adapter.runHeadless({
    prompt: buildPrDescriptionPrompt(title),
    cwd,
  });
  return sanitizePrDescription(r.raw, title);
}

/**
 * Record, for every worktree, whether its branch still merges into its base.
 *
 * Runs for EVERY worktree, including one whose PR already existed and was skipped
 * above: mergeability goes stale on its own — the base moves under a PR nobody
 * touched — so a re-ship that skipped the PR work is exactly when a refreshed
 * answer matters most. This is also the whole staleness story (F4): the check is
 * re-run on every ship and the row is overwritten, so there is never a second,
 * older answer to accidentally read.
 *
 * A conflict does NOT fail the stage. `ship` has no `failed` edge, so treating one
 * as a failure would park the ticket at `ship` with no way out — and a retry
 * cannot resolve a conflict, only a human rebase can. Conflict state is recorded
 * and surfaced; the shipping itself succeeded, because the PR exists.
 *
 * Never throws for the same reason: `checkMergeable` already converts every git
 * failure into `unknown`, and a store failure here must not sink a ship that
 * otherwise worked. Observability is not allowed to break the operation it
 * observes.
 */
async function recordMergeChecks(
  store: Store,
  ticketId: number,
  worktrees: readonly WorktreeView[],
  git: GitRunner,
  onProgress: ShipProgress,
  manifest?: Manifest,
): Promise<void> {
  for (const wt of worktrees) {
    onProgress({ repo: wt.repo, step: 'merge', status: 'run' });
    try {
      const baseRef = manifest
        ? resolveBaselineBranchForPath(manifest, wt.repo)
        : wt.baseRef;
      const check = await checkMergeable(git, wt.path, baseRef);
      setMergeCheck(store, {
        ...check,
        ticketId,
        repo: wt.repo,
        baseRef,
        checkedAt: nowIso(),
      });
      // Matches the status `shipInside` will read back from the persisted row,
      // so the live event and the post-hoc render never disagree.
      onProgress({ repo: wt.repo, step: 'merge', status: mergeOpStatus(check.state) });
    } catch {
      // Already-degraded state: nothing is recorded for this repo, and a missing
      // row renders as nothing rather than as "clean".
      onProgress({ repo: wt.repo, step: 'merge', status: 'note', detail: 'check failed' });
    }
  }
}

/** One step of ship's per-repo work, in the order it happens. */
export type ShipStep = 'commit' | 'push' | 'describe' | 'pr' | 'merge';

/**
 * One structured progress event. `note` marks a step that was not (re-)run —
 * an idempotent retry adopting an already-open PR — so the live view never
 * claims work happened that didn't.
 */
export interface ShipStepEvent {
  repo: string;
  step: ShipStep;
  status: 'run' | 'pass' | 'fail' | 'note';
  detail?: string;
}

/**
 * Structured progress emitted as the ship progresses. Deliberately
 * non-throwing at the call sites (the caller's UI is observing, not controlling)
 * — a broken observer must never sink a ship that otherwise works.
 */
export type ShipProgress = (event: ShipStepEvent) => void;

export async function shipTicket(
  store: Store,
  opts: ShipOpts,
  gh: GhRunner = defaultGhRunner,
  adapter?: AgentAdapter,
  git: GitRunner = defaultGitRunner,
  onProgress: ShipProgress = () => {},
): Promise<ShipResult> {
  const ticket = getTicket(store, opts.ticketId);
  const worktrees = listWorktreesByTicket(store, opts.ticketId);
  const title = ticket.title ?? ticket.key ?? `Ticket ${opts.ticketId}`;
  const key = ticket.key ?? String(opts.ticketId);
  const conventions = opts.conventions ?? opts.manifest?.conventions;

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
        // Nothing ran this time — say so for every step this repo skips,
        // rather than leaving commit/push looking like they are still "to
        // come" (the old free-text channel simply skipped this repo entirely).
        const descriptionTemplate = conventions?.pullRequestDescription;
        const wouldDescribe = Boolean(
          adapter && (!descriptionTemplate || usesDescription(descriptionTemplate)),
        );
        const skipped: ShipStep[] = wouldDescribe
          ? ['commit', 'push', 'describe', 'pr']
          : ['commit', 'push', 'pr'];
        for (const step of skipped) {
          onProgress({
            repo: wt.repo,
            step,
            status: 'note',
            detail: 'existing PR already open — not re-shipped',
          });
        }
        continue;
      }
      // Push FIRST. `gh pr create` refuses a branch that exists only on this
      // machine ("you must first push the current branch to a remote"), and every
      // ticket works on a fresh worktree branch — so the branch is always
      // local-only until now. Before the model call, too: a push that cannot
      // succeed makes the PR impossible, and paying for a description first buys
      // prose for a PR that will never exist.
      // Commit before push: a stage marker means the agent thinks it is done, not
      // that it committed. Work left in the worktree would push an empty branch and
      // `gh pr create` would fail with "No commits between main and karst/…".
      const templateContext: ArtifactTemplateContext = {
        id: opts.ticketId,
        key,
        title,
        repo: wt.repo,
        type: resolveTicketType(ticket, conventions),
        scope: resolveRepoScope(opts.manifest, wt.repo),
      };
      const commitMessage = conventions?.commitMessage
        ? renderArtifactTemplate(
            'commitMessage',
            conventions.commitMessage,
            templateContext,
          )
        : title;
      const prTitle = conventions?.pullRequestTitle
        ? renderArtifactTemplate(
            'pullRequestTitle',
            conventions.pullRequestTitle,
            templateContext,
          )
        : title;

      onProgress({ repo: wt.repo, step: 'commit', status: 'run' });
      await commitAllIfDirty(git, wt.path, commitMessage);
      onProgress({ repo: wt.repo, step: 'commit', status: 'pass' });

      const base = opts.manifest
        ? resolveBaselineBranchForPath(opts.manifest, wt.repo)
        : wt.baseRef ?? undefined;
      if (base && !(await hasChangesFrom(git, wt.path, base))) {
        onProgress({
          repo: wt.repo,
          step: 'push',
          status: 'note',
          detail: `no push needed — no changes from ${base}`,
        });
        if (adapter) {
          onProgress({
            repo: wt.repo,
            step: 'describe',
            status: 'note',
            detail: `no description needed — no changes from ${base}`,
          });
        }
        onProgress({
          repo: wt.repo,
          step: 'pr',
          status: 'note',
          detail: `no PR needed — no changes from ${base}`,
        });
        continue;
      }

      onProgress({ repo: wt.repo, step: 'push', status: 'run' });
      await pushBranch(git, wt.path);
      onProgress({ repo: wt.repo, step: 'push', status: 'pass' });

      // The `prs` table only knows about PRs karst itself opened, so a PR opened
      // by hand — or by a run whose row was lost — used to make ship fail with
      // gh's "a pull request for branch … already exists", permanently: openPr
      // threw before the insert below, so the local check above could never
      // absorb the retry, and ship has no `failed` edge to advance out of. An
      // open PR is what ship is FOR. Adopt it; the push above already gave it
      // the new commits.
      //
      // Probing BEFORE the create rather than rescuing after it also keeps
      // `describePr` from paying for prose describing a PR that already exists.
      onProgress({ repo: wt.repo, step: 'pr', status: 'run' });
      const existing = await findOpenPr(gh, wt.path);
      const descriptionTemplate = conventions?.pullRequestDescription;
      if (
        existing &&
        adapter &&
        (!descriptionTemplate || usesDescription(descriptionTemplate))
      ) {
        onProgress({
          repo: wt.repo,
          step: 'describe',
          status: 'note',
          detail: 'existing PR already open — description not regenerated',
        });
      }
      let opened = existing;
      if (!opened) {
        let body: string;
        if (descriptionTemplate) {
          let description = prTitle;
          if (usesDescription(descriptionTemplate) && adapter) {
            onProgress({ repo: wt.repo, step: 'describe', status: 'run' });
            description = await describePr(adapter, wt.path, prTitle);
            onProgress({ repo: wt.repo, step: 'describe', status: 'pass' });
          }
          body = renderArtifactTemplate(
            'pullRequestDescription',
            descriptionTemplate,
            { ...templateContext, description },
          );
        } else if (adapter) {
          onProgress({ repo: wt.repo, step: 'describe', status: 'run' });
          body = await describePr(adapter, wt.path, prTitle);
          onProgress({ repo: wt.repo, step: 'describe', status: 'pass' });
        } else {
          body = prTitle;
        }
        opened = await openPr(gh, { cwd: wt.path, title: prTitle, body, base });
      }
      onProgress({ repo: wt.repo, step: 'pr', status: 'pass' });
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

  // Every branch is now pushed, so the merge probe measures what a reviewer would
  // actually see on the PR. Deliberately outside the try above: a failure here is
  // not a ship failure, and this must not reach the catch that parks the ticket.
  await recordMergeChecks(store, opts.ticketId, worktrees, git, onProgress, opts.manifest);

  // PRs opened → ship passes → done. Unaffected by merge state, by design.
  transition(store, opts.ticketId, 'ship', { kind: 'passed' });

  return { prs };
}
