/** How the clone's head (FETCH_HEAD) relates to the host worktree's HEAD. */
export type CloneRelation = 'ahead' | 'behind' | 'diverged';

/** Reply of {@link BEHIND_SUMMARY}: the clone is behind the host, so there is nothing to bring. */
export const BEHIND_SUMMARY = 'host ahead, nothing to bring';

/**
 * Classify before merging, one rule for the sbx and docker runners.
 * `ahead` (also equal): host HEAD is an ancestor of FETCH_HEAD → fast-forward.
 * `behind`: FETCH_HEAD is an ancestor of host HEAD → nothing to bring; the host → clone refresh catches up.
 * `diverged`: neither → refused, never forced.
 */
export async function classifyCloneRelation(isAncestor: (older: string, newer: string) => Promise<boolean>): Promise<CloneRelation> {
  if (await isAncestor('HEAD', 'FETCH_HEAD')) return 'ahead';
  if (await isAncestor('FETCH_HEAD', 'HEAD')) return 'behind';
  return 'diverged';
}
