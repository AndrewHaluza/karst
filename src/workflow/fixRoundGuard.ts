import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GitRunner } from '../integrations/git.js';
import type { Store } from '../store/db.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { activeFixRound } from '../store/recoveryRounds.js';
import { fixRoundManifest, listFixRoundHeads, recordFixCommitSha, recordFixRoundHeads, recordFixRoundManifest, type FixRoundHead } from '../store/fixRoundHeads.js';

export const NO_NEW_COMMIT_REASON =
  'no new commit since this fix round started — fix what the brief reports, commit, then fire the marker' +
  ' — or, for a fix only in the operator manifest, change the manifest file recorded for this round';

/** sha256 of the file's bytes, or null when it cannot be read. */
function manifestSha(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null; // unreadable → the caller records nothing / keeps the refusal
  }
}

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
  manifestPath: string | null = null,
): Promise<void> {
  const heads: FixRoundHead[] = [];
  for (const w of listWorktreesByTicket(store, ticketId)) {
    const headSha = await headOf(git, w.path);
    if (headSha !== null) heads.push({ worktreePath: w.path, headSha });
  }
  recordFixRoundHeads(store, roundId, heads);
  const sha = manifestPath === null ? null : manifestSha(manifestPath);
  if (manifestPath !== null && sha !== null) recordFixRoundManifest(store, roundId, manifestPath, sha);
}

/**
 * Refuse the `stage fix pass` marker when no recorded worktree HEAD moved since the
 * round opened, unless the operator manifest file changed (it is git-ignored, so it
 * cannot be committed). No active round, no snapshot, or an unreadable HEAD → allowed.
 */
export async function assertFixHasNewCommit(store: Store, ticketId: number, git: GitRunner): Promise<void> {
  const round = activeFixRound(store, ticketId);
  if (round === null) return;
  const recorded = listFixRoundHeads(store, round.id);
  if (recorded.length === 0) return;
  for (const r of recorded) {
    const now = await headOf(git, r.worktreePath);
    if (now === null) return;
    if (now !== r.headSha) {
      recordFixCommitSha(store, round.id, now);
      return;
    }
  }
  const manifest = fixRoundManifest(store, round.id);
  const manifestHint = manifest === null ? '' : ` (a change to the manifest at ${manifest.path})`;
  if (manifest !== null) {
    const nowSha = manifestSha(manifest.path);
    if (nowSha !== null && nowSha !== manifest.sha) return; // manifest-only fix: no commit exists, so no fix_commit_sha
  }
  throw new Error(`cannot mark this stage done: ${NO_NEW_COMMIT_REASON}${manifestHint}`);
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
  manifestPath: string | null,
  onError: (err: unknown) => void,
  next: () => void,
): void {
  const snapshot = roundId === null ? Promise.resolve() : snapshotFixRoundHeads(store, ticketId, roundId, git, manifestPath);
  void snapshot.catch(onError).then(next);
}
