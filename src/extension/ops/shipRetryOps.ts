import type { Store } from '../../store/db.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { headShaOf, type CiActionsInput } from './ciActionsWiring.js';
import { ShipDrainingError } from './reloadWhenIdle.js';
import type { ShipRetryOutcome, ShipRetrySeams } from './autopilotShipRetry.js';

/**
 * The two host seams of the Autopilot ship retry (@arch:AP-11), built here so `extension.ts` stays a binding: the
 * worktree reads of rule 5 and the Retry ship call. vscode-free: the git runner and the saga arrive injected.
 */

export interface ShipRetrySeamDeps {
  readonly store: Store;
  readonly ticketId: number;
  /** The ticket's CI-actions input: its `git` runner reads the ticket's worktrees. */
  readonly ciInput: () => CiActionsInput;
}

/**
 * Rule 5's reads: `git status --porcelain -uall` and HEAD of the repo's ticket worktree. A repo with no registered
 * worktree, or a git that fails, is never clean: the retry does not run.
 */
export function makeShipRetrySeams(d: ShipRetrySeamDeps): ShipRetrySeams {
  const pathOf = new Map(listWorktreesByTicket(d.store, d.ticketId).map((w) => [w.repo, w.path]));
  const input = d.ciInput();
  return {
    worktreeClean: async (repo) => {
      const cwd = pathOf.get(repo);
      if (cwd === undefined) return { ok: false };
      const r = await input.git(['status', '--porcelain', '-uall'], cwd);
      return r.exitCode === 0 ? { ok: true, clean: r.stdout.trim() === '' } : { ok: false };
    },
    localHead: async (repo) => {
      const cwd = pathOf.get(repo);
      return cwd === undefined ? null : headShaOf(input, cwd);
    },
  };
}

export interface RetryShipDeps {
  /** Runs the saga now (a failure is recorded on the ship stage and opens the run). */
  readonly runShip: (repos: readonly string[]) => Promise<void>;
  /** `[ship] autopilot ...` debug line. */
  readonly debug: (message: string) => void;
  readonly label: string;
}

/**
 * The Retry ship seam: `runShipSaga` throws `ShipDrainingError` while the host drains (@arch:DRAIN-01), which is busy,
 * so the next tick retries. Any other throw already recorded the failure on the ship stage and opened that run: the next
 * tick reads it, so the retry counts as sent.
 */
export function makeRetryShip(d: RetryShipDeps): (repos: readonly string[]) => Promise<ShipRetryOutcome> {
  return async (repos) => {
    try {
      await d.runShip(repos);
      return { kind: 'sent' };
    } catch (e) {
      if (e instanceof ShipDrainingError) return { kind: 'busy' };
      d.debug(`[ship] autopilot ticket ${d.label}: the ship retry ended (${e instanceof Error ? e.message : String(e)})`);
      return { kind: 'sent' };
    }
  };
}
