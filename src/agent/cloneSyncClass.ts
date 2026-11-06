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

/**
 * Shell fragment for the clone side of a sync (sbx and docker share it). Needs `$g` (git with the clone's safe.directory),
 * `$br` (the branch) and the host's candidate commits as the positional args. It sets `$ex` to the first candidate the clone
 * has, as a bundle exclusion, so the bundle carries only what the host lacks (a thin bundle) and the host fetch stores a small
 * pack, not a copy of the history. A tip equal to the candidate excludes its parents (git refuses an empty bundle).
 * No candidate in the clone: `$ex` stays empty and the bundle is full.
 */
export const THIN_BUNDLE_EXCLUDE =
  'tip=$($g rev-parse "$br"); ex=; for c in "$@"; do [ -n "$c" ] || continue; $g cat-file -e "$c^{commit}" 2>/dev/null || continue; '
  + 'if [ "$tip" = "$c" ]; then ex="^$c^@"; else ex="^$c"; fi; break; done; ';

/**
 * Commits the host has that the clone may have too, best first: the worktree HEAD, then the tip fetched by the last sync
 * (the clone has it even when the host moved on with its own commits). Unresolvable ones are left out.
 */
export async function hostBundleHaves(git: (args: string[]) => Promise<{ code: number; stdout: string }>, branch: string): Promise<string[]> {
  const found: string[] = [];
  for (const args of [['rev-parse', 'HEAD'], ['rev-parse', '--verify', '--quiet', `${sandboxHeadRef(branch)}^{commit}`]]) {
    const out = await git(args);
    const sha = out.stdout.trim();
    if (out.code === 0 && SHA.test(sha) && !found.includes(sha)) found.push(sha);
  }
  return found;
}
