import type { Manifest } from '../../manifest/types.js';
import type { GitRunner } from '../../integrations/git.js';
import type { BlockerKind } from '../../model/types.js';
import { resolveBaselineBranchForPath } from '../../manifest/baselineBranch.js';
import { canonicalPath } from '../../runtime/pathScope.js';

export interface ReviewWorktree {
  /** Repository path persisted on the worktree row. */
  repo: string;
  path: string;
  baseRef: string | null;
  /**
   * The ticket's branch (`worktrees.branch`), when known. Change probes and
   * the gate-lane scope blocks diff `origin/<base>...<branch>` BY NAME so a
   * worktree checked out on the base branch (or a session in the main
   * checkout) reads the ticket's real changes instead of a silent empty
   * `...HEAD` (fu1). Absent → fall back to `HEAD`.
   */
  branch?: string | null;
}

export interface ReviewTarget extends ReviewWorktree {
  /** Manifest entries backed by this worktree (several for a monorepo). */
  names: string[];
}

/**
 * What `selectReviewTargets` resolved: the affected targets, or that karst
 * could not even ask which targets are affected. `unavailable` is
 * environmental (an unreachable remote, a broken git) — never a verdict about
 * the ticket's code — so a caller must route it to a park, not a pass or fail.
 */
export type TargetSelection =
  | { kind: 'targets'; targets: ReviewTarget[]; unmapped: readonly string[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };

/**
 * One repository a gate stage runs against: the worktree, plus every manifest
 * entry backed by it.
 *
 * Both gate stages resolve the same thing, so it is described once here and
 * aliased by each (`UatTarget`, `ReviewGateTarget`) — the stages stay free to
 * diverge later without a second copy of the collapsing rule below.
 */
export interface GateTarget {
  /** The repository path the worktree row carries. */
  repo: string;
  /** The ticket's worktree for that repository — where the gates run. */
  path: string;
  /** Every manifest entry backed by this worktree (several for a monorepo). */
  names: string[];
}

/**
 * Collapse selected targets to one per repository PATH, unioning their names.
 *
 * Two `repositories:` entries sharing a path are one monorepo with one worktree
 * — running the gates twice in the same directory answers the same question
 * twice. This also absorbs a duplicated `worktrees` row for one path (stale
 * data, a double write): every name that maps to the path is preserved and
 * merged, never dropped, because service identity stays keyed by repository
 * NAME (distinct ports, distinct `servers` rows) and per-repository gate
 * overrides are keyed by that same name.
 */
export function dedupeTargetsByRepoPath(targets: readonly ReviewTarget[]): GateTarget[] {
  const byPath = new Map<string, GateTarget>();
  for (const target of targets) {
    const key = canonicalPath(target.repo);
    const existing = byPath.get(key);
    if (existing) {
      for (const name of target.names) {
        if (!existing.names.includes(name)) existing.names.push(name);
      }
      continue;
    }
    byPath.set(key, { repo: target.repo, path: target.path, names: [...target.names] });
  }
  return [...byPath.values()];
}

/**
 * Whether one worktree changed, or that karst could not determine it.
 */
type ChangeProbe =
  | { kind: 'changed'; changed: boolean }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };

/**
 * Timeout for remote git operations (fetch) that may hang when the remote is
 * unreachable. The fetch is optional — a timeout falls back to the local branch
 * for comparison, which is a deterministic baseline even without the latest
 * remote state.
 */
const GIT_REMOTE_TIMEOUT_MS = 30_000;

async function hasReviewChanges(
  git: GitRunner,
  cwd: string,
  base: string,
  branch?: string | null,
  fetchTimeoutMs: number = GIT_REMOTE_TIMEOUT_MS,
): Promise<ChangeProbe> {
  // Agents are allowed to leave implementation work uncommitted until ship.
  // Porcelain includes staged, unstaged, and untracked files, so review cannot
  // pass merely because HEAD itself has not moved yet.
  const status = await git(['status', '--porcelain'], cwd);
  if (status.exitCode !== 0) {
    return {
      kind: 'unavailable',
      blocker: 'capability-missing',
      reason: `cannot determine review changes in ${cwd}: ${status.stderr || status.stdout || `git status exited ${status.exitCode}`}`,
    };
  }
  if (status.stdout.trim().length > 0) return { kind: 'changed', changed: true };

  // Prefer the fresh remote baseline. If fetch is unavailable or hangs, the
  // local branch is still a deterministic comparison when it exists; unlike
  // ship's conservative helper, a fetch failure must not label every repo as
  // changed. The timeout prevents an unreachable remote from stalling the
  // entire gate stage indefinitely (the hanging process is left to the OS TCP
  // timeout — it is a child of the extension host and will be cleaned up).
  const fetchTimeout = () =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) =>
      setTimeout(
        () => resolve({ exitCode: 1, stdout: '', stderr: 'git fetch timed out' }),
        fetchTimeoutMs,
      ),
    );
  const fetched = await Promise.race([git(['fetch', 'origin', base], cwd), fetchTimeout()]);
  const compare = fetched.exitCode === 0 ? `origin/${base}` : base;
  // Also fetch the feature branch so the diff head resolves against the remote
  // state — a local branch ref that is behind the remote produces an empty diff
  // even though the remote branch holds the ticket's actual work. Fall back to
  // the local branch name when the fetch fails.
  const fetchedBranch =
    branch && branch.trim() !== ''
      ? await Promise.race([git(['fetch', 'origin', branch], cwd), fetchTimeout()])
      : null;
  // Diff against the ticket's branch BY NAME when it is known: a worktree
  // checked out on the base branch must still read as "changed" when the
  // ticket branch holds work — `...HEAD` there would read empty (fu1). Absent
  // a branch, fall back to the checkout's HEAD.
  const head =
    branch && branch.trim() !== ''
      ? fetchedBranch && fetchedBranch.exitCode === 0
        ? `origin/${branch}`
        : branch
      : 'HEAD';
  const diff = await git(['diff', '--quiet', `${compare}...${head}`], cwd);
  if (diff.exitCode === 0) return { kind: 'changed', changed: false };
  if (diff.exitCode === 1) return { kind: 'changed', changed: true };
  const reason = diff.stderr || diff.stdout || fetched.stderr || fetched.stdout;
  return {
    kind: 'unavailable',
    blocker: 'capability-missing',
    reason: `cannot determine review changes in ${cwd}: ${reason || `git diff exited ${diff.exitCode}`}`,
  };
}

export interface SelectReviewTargetsOptions {
  /**
   * Timeout for the remote git fetch in target planning. A hung fetch (e.g.
   * unreachable remote) falls back to the local branch for comparison. Tests
   * pass a short value to avoid waiting for the real 30-second timeout.
   */
  gitFetchTimeoutMs?: number;
}

/**
 * Select worktrees whose review checks can answer something about this ticket.
 *
 * Directly changed repositories seed the affected set. The set then expands
 * from a changed dependency to each runnable repository that depends on it,
 * transitively. This is the same direction an API/package change propagates:
 * changing `api` can affect `web`, while changing unrelated `docs` cannot.
 */
export async function selectReviewTargets(
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  git: GitRunner,
  options?: SelectReviewTargetsOptions,
): Promise<TargetSelection> {
  const namesByPath = new Map<string, string[]>();
  for (const [name, repository] of Object.entries(manifest.repositories)) {
    if (repository.enabled === false) continue;
    const key = canonicalPath(repository.repoPath);
    const names = namesByPath.get(key) ?? [];
    names.push(name);
    namesByPath.set(key, names);
  }

  const changed = new Set<string>();
  const unmapped: string[] = [];
  for (const worktree of worktrees) {
    const names = namesByPath.get(canonicalPath(worktree.repo)) ?? [];
    if (names.length === 0) unmapped.push(worktree.repo);
    const base = resolveBaselineBranchForPath(manifest, worktree.repo);
    const probe = await hasReviewChanges(
      git,
      worktree.path,
      base,
      worktree.branch,
      options?.gitFetchTimeoutMs,
    );
    if (probe.kind === 'unavailable') {
      return { kind: 'unavailable', blocker: probe.blocker, reason: probe.reason };
    }
    if (probe.changed) {
      for (const name of names) changed.add(name);
    }
  }

  const affected = new Set(changed);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [name, repository] of Object.entries(manifest.repositories)) {
      if (affected.has(name) || repository.enabled === false || !repository.service) continue;
      if (repository.service.dependsOn.some((relation) => affected.has(relation.target))) {
        affected.add(name);
        expanded = true;
      }
    }
  }

  return {
    kind: 'targets',
    unmapped,
    targets: worktrees.flatMap((worktree) => {
      const names = namesByPath.get(canonicalPath(worktree.repo)) ?? [];
      return names.some((name) => affected.has(name)) ? [{ ...worktree, names }] : [];
    }),
  };
}
