import type { GitRunner } from '../integrations/git.js';
import type { Store } from '../store/db.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { activeFixRound } from '../store/recoveryRounds.js';
import { listFixRoundHeads, recordFixRoundHeads, type FixRoundHead } from '../store/fixRoundHeads.js';

export const NO_NEW_COMMIT_REASON =
  'no new commit since this fix round started — fix what the brief reports, commit, then fire the marker';

async function headOf(git: GitRunner, cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', 'HEAD'], cwd);
  const sha = r.stdout.trim();
  return r.exitCode === 0 && sha !== '' ? sha : null;
}

/**
 * Snapshot each worktree's HEAD for the fix round (host side). Called before the
 * brief reaches the agent. A worktree whose HEAD cannot be read is skipped, so the
 * guard never refuses on a probe it could not answer. For a sandbox ticket the host
 * branch reflects the last sync, so the snapshot can only be older than the
 * sandbox's real HEAD — the guard errs towards accepting.
 */
export async function snapshotFixRoundHeads(
  store: Store,
  ticketId: number,
  roundId: number,
  git: GitRunner,
): Promise<void> {
  const heads: FixRoundHead[] = [];
  for (const w of listWorktreesByTicket(store, ticketId)) {
    const headSha = await headOf(git, w.path);
    if (headSha !== null) heads.push({ worktreePath: w.path, headSha });
  }
  recordFixRoundHeads(store, roundId, heads);
}

/**
 * Refuse the `stage fix pass` marker when no recorded worktree HEAD moved since the
 * round opened. No active round, no snapshot, or an unreadable HEAD → allowed.
 */
export async function assertFixHasNewCommit(store: Store, ticketId: number, git: GitRunner): Promise<void> {
  const round = activeFixRound(store, ticketId);
  if (round === null) return;
  const recorded = listFixRoundHeads(store, round.id);
  if (recorded.length === 0) return;
  for (const r of recorded) {
    const now = await headOf(git, r.worktreePath);
    if (now === null || now !== r.headSha) return;
  }
  throw new Error(`cannot mark this stage done: ${NO_NEW_COMMIT_REASON}`);
}

/**
 * Snapshot BEFORE `next` (which delivers the brief), so the agent cannot commit
 * ahead of the snapshot. A failed snapshot is reported and never blocks the fix.
 * `roundId` null = untracked fix, nothing to snapshot.
 */
export function snapshotThenResume(
  store: Store,
  ticketId: number,
  roundId: number | null,
  git: GitRunner,
  onError: (err: unknown) => void,
  next: () => void,
): void {
  const snapshot = roundId === null ? Promise.resolve() : snapshotFixRoundHeads(store, ticketId, roundId, git);
  void snapshot.catch(onError).then(next);
}
