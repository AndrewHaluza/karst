/** How the clone's head (the resolved sandbox sha) relates to the host worktree's HEAD. */
export type CloneRelation = 'ahead' | 'behind' | 'diverged';

/** Reply of {@link BEHIND_SUMMARY}: the clone is behind the host, so there is nothing to bring. */
export const BEHIND_SUMMARY = 'host ahead, nothing to bring';

const SHA = /^[0-9a-f]{40,64}$/;

/** Private ref the sandbox bundle is fetched into. FETCH_HEAD is one file per worktree that every fetch truncates, so it is never read. */
export const sandboxHeadRef = (branch: string): string => `refs/karst/sandbox/${branch}`;

/** Host git args that fetch the sandbox bundle's branch into {@link sandboxHeadRef} and leave FETCH_HEAD alone. */
export const fetchSandboxBundleArgs = (bundlePath: string, branch: string): string[] =>
  ['fetch', '--no-write-fetch-head', bundlePath, `+refs/heads/${branch}:${sandboxHeadRef(branch)}`];

export type SandboxHead = { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly reason: string };

/** Resolve the private ref to a sha ONCE; every later step uses that sha. Unreadable is an error, never `diverged`. */
export async function resolveSandboxHead(git: (args: string[]) => Promise<{ code: number; stdout: string }>, branch: string): Promise<SandboxHead> {
  const out = await git(['rev-parse', '--verify', '--quiet', `${sandboxHeadRef(branch)}^{commit}`]);
  const sha = out.stdout.trim();
  return out.code === 0 && SHA.test(sha) ? { ok: true, sha } : { ok: false, reason: 'cannot read the sandbox head' };
}

/**
 * Classify before merging, one rule for the sbx and docker runners.
 * `ahead` (also equal): host HEAD is an ancestor of the sandbox sha → fast-forward.
 * `behind`: the sandbox sha is an ancestor of host HEAD → nothing to bring; the host → clone refresh catches up.
 * `diverged`: neither → refused, never forced.
 */
export async function classifyCloneRelation(sandboxSha: string, isAncestor: (older: string, newer: string) => Promise<boolean>): Promise<CloneRelation> {
  if (await isAncestor('HEAD', sandboxSha)) return 'ahead';
  if (await isAncestor(sandboxSha, 'HEAD')) return 'behind';
  return 'diverged';
}
