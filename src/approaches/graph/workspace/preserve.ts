/**
 * Preserve the work of a node clone (T1323, `@arch:GRAPH-AUTORECOVERY`).
 *
 * A node's work lives only in its workspace clone. A relaunch replaces the
 * clone, and a replan drain cancels the node run; without this module the work
 * is deleted with the directory. The work is kept as a BINARY patch per
 * repository beneath the graph run's artifact root:
 *
 *   <artifactRoot>/preserved/<nodeRunId>/<repoName>.patch
 *   <artifactRoot>/preserved/<nodeRunId>/<repoName>.paths.json
 *
 * The recipe is proven against a commit, staged and unstaged edits, a deletion,
 * a rename, an untracked file and a binary file; a gitignored file stays out,
 * like `captureUntrackedPaths`.
 *
 * `git add -A --intent-to-add` must not touch the clone's own index, so every
 * git call runs with `GIT_INDEX_FILE` pointing at a TEMPORARY COPY of it
 * (`git rev-parse --git-path index` names it). The diff is written to a file
 * with `--output=`; it is never read back from stdout.
 *
 * The patch is written beside the target and renamed into place, so a failed
 * diff never destroys an older good patch. An empty diff writes nothing and
 * keeps the older patch.
 *
 * Host-agnostic: store, git runner and artifact root are injected; no vscode,
 * no `spawnSync`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isPathUnder } from '../../../runtime/pathScope.js';
import { describeGitFailure, type GitRunner } from '../../../integrations/git.js';
import {
  nodeRunBaseHeads,
  workspacesForNode,
  type WorkspaceRow,
} from '../../../store/graph/nodeRuns.js';
import type { GraphDb } from '../../../store/graph/transitions.js';

/** One repository clone this preserve call may salvage, with its base commit. */
export interface PreserveDomain {
  repoName: string;
  baseCommit: string;
}

export interface PreserveWorkInput {
  graphRunId: number;
  nodeRunId: number;
  /**
   * The clones this call may preserve. Absent → the node run's recorded base
   * heads are matched against each clone's HEAD (the drain-cancel path).
   */
  domains?: readonly PreserveDomain[];
}

export type PreserveWorkResult =
  | { kind: 'preserved'; repos: string[] }
  | { kind: 'nothing' }
  | { kind: 'failed'; reason: string };

/** One repository's preserved work, for the replan reasons document. */
export interface PreservedWorkEntry {
  repoName: string;
  patchPath: string;
  paths: string[];
}

export interface RestoreWorkInput {
  graphRunId: number;
  nodeRunId: number;
  repoName: string;
  cwd: string;
}

export type RestoreWorkResult =
  | { kind: 'restored'; patchPath: string }
  | { kind: 'none' }
  | { kind: 'failed'; reason: string };

export interface PreserveDeps {
  db: GraphDb;
  git: GitRunner;
  /** The graph run's artifact root, the SAME root `writeSnapshot` uses. */
  artifactRoot: (graphRunId: number) => string;
  debug?: (message: string) => void;
}

export interface RestoreDeps {
  git: GitRunner;
  artifactRoot: (graphRunId: number) => string;
  debug?: (message: string) => void;
}

/** `<artifactRoot>/preserved/<nodeRunId>/`. */
export function preservedDir(artifactRoot: string, nodeRunId: number): string {
  return join(artifactRoot, 'preserved', String(nodeRunId));
}

let tempSeq = 0;

/**
 * A repository name is a single file-name component. A name that would leave
 * the preserved directory (a separator, `..`, an empty name) is refused rather
 * than sanitized: silently renaming it would lose the mapping to the repo.
 */
function repoFileStem(repoName: string): string | null {
  if (repoName === '' || repoName === '.' || repoName === '..') return null;
  if (repoName.includes('/') || repoName.includes('\\') || repoName.includes('\0')) return null;
  return repoName;
}

/** The base commit this clone was cut from, or null when none is recorded. */
async function baseCommitFor(
  deps: PreserveDeps,
  row: WorkspaceRow,
  input: PreserveWorkInput,
): Promise<string | null> {
  if (input.domains) {
    const domain = input.domains.find((d) => d.repoName === row.repo_name);
    return domain && domain.baseCommit !== '' ? domain.baseCommit : null;
  }
  const heads = nodeRunBaseHeads(deps.db, input.nodeRunId);
  if (heads.length === 0) return null;
  const head = await deps.git(['rev-parse', 'HEAD'], row.cwd);
  const headSha = head.exitCode === 0 ? head.stdout.trim() : '';
  const exact = heads.find((h) => h.commit === headSha);
  if (exact) return exact.commit;
  // The agent may have committed on top of the base; the base is the recorded
  // head that is still an ancestor of HEAD.
  for (const candidate of heads) {
    if (candidate.commit === '') continue;
    const ancestor = await deps.git(
      ['merge-base', '--is-ancestor', candidate.commit, 'HEAD'],
      row.cwd,
    );
    if (ancestor.exitCode === 0) return candidate.commit;
  }
  return null;
}

async function indexPathOf(deps: PreserveDeps, cwd: string): Promise<string | null> {
  const result = await deps.git(['rev-parse', '--git-path', 'index'], cwd);
  if (result.exitCode !== 0) return null;
  const p = result.stdout.trim();
  if (p === '') return null;
  return isAbsolute(p) ? p : join(cwd, p);
}

function readPaths(file: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Write the work of every clone this node run still has on disk as a binary
 * patch. A clone with a ledger row but no recorded base head is a FAILURE: its
 * work cannot be written, and a caller must never delete it.
 */
export async function preserveNodeWork(
  deps: PreserveDeps,
  input: PreserveWorkInput,
): Promise<PreserveWorkResult> {
  const onDisk = workspacesForNode(deps.db, input.nodeRunId).filter((row) => existsSync(row.cwd));
  if (onDisk.length === 0) return { kind: 'nothing' };

  const root = deps.artifactRoot(input.graphRunId);
  if (root === '') {
    return { kind: 'failed', reason: `no artifact root for graph run ${input.graphRunId}` };
  }
  const dir = preservedDir(root, input.nodeRunId);
  const preserved: string[] = [];

  for (const row of onDisk) {
    const stem = repoFileStem(row.repo_name);
    if (stem === null) {
      return {
        kind: 'failed',
        reason: `unsafe repository name for a preserved patch: ${JSON.stringify(row.repo_name)}`,
      };
    }
    const patchPath = join(dir, `${stem}.patch`);
    const pathsPath = join(dir, `${stem}.paths.json`);
    if (!isPathUnder(patchPath, dir) || !isPathUnder(pathsPath, dir)) {
      return {
        kind: 'failed',
        reason: `repository name leaves the preserved directory: ${JSON.stringify(row.repo_name)}`,
      };
    }
    const base = await baseCommitFor(deps, row, input);
    if (base === null) {
      return {
        kind: 'failed',
        reason: `node run ${input.nodeRunId} has no recorded base head for ${row.repo_name} — its work cannot be preserved`,
      };
    }
    const indexPath = await indexPathOf(deps, row.cwd);
    if (indexPath === null) {
      return {
        kind: 'failed',
        reason: `cannot resolve the git index of ${row.repo_name} in ${row.cwd}`,
      };
    }

    mkdirSync(dir, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}-${tempSeq++}`;
    const tempIndex = join(tmpdir(), `karst-preserve-index-${stamp}`);
    const tempPatch = join(dir, `.${stem}.patch.tmp-${stamp}`);
    const tempPaths = join(dir, `.${stem}.paths.tmp-${stamp}`);
    try {
      // Intent-to-add on a COPY: the clone's own index must not change, and
      // `git diff <base>` only sees an untracked file once it is in an index.
      copyFileSync(indexPath, tempIndex);
      const env = { GIT_INDEX_FILE: tempIndex };
      const add = await deps.git(['add', '-A', '--intent-to-add'], row.cwd, { env });
      if (add.exitCode !== 0) {
        return {
          kind: 'failed',
          reason: describeGitFailure(`git add -A --intent-to-add in ${row.repo_name}`, add),
        };
      }
      const diff = await deps.git(
        [
          'diff',
          '--binary',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          `--output=${tempPatch}`,
          base,
        ],
        row.cwd,
        { env },
      );
      if (diff.exitCode !== 0) {
        return {
          kind: 'failed',
          reason: describeGitFailure(`git diff --binary ${base} in ${row.repo_name}`, diff),
        };
      }
      // An empty diff writes nothing — and does NOT delete an older good patch.
      if (!existsSync(tempPatch) || statSync(tempPatch).size === 0) {
        deps.debug?.(`[graph] preserve: node run ${input.nodeRunId}/${row.repo_name} has no work to keep`);
        continue;
      }
      const names = await deps.git(
        ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', base],
        row.cwd,
        { env },
      );
      if (names.exitCode !== 0) {
        return {
          kind: 'failed',
          reason: describeGitFailure(`git diff --name-only ${base} in ${row.repo_name}`, names),
        };
      }
      const paths = names.stdout.split('\0').filter((p) => p !== '');
      writeFileSync(tempPaths, JSON.stringify(paths));
      // Paths first, then the patch: a reader that sees the patch sees its list.
      renameSync(tempPaths, pathsPath);
      renameSync(tempPatch, patchPath);
      preserved.push(row.repo_name);
      deps.debug?.(
        `[graph] preserve: node run ${input.nodeRunId}/${row.repo_name} → ${patchPath} (${paths.length} paths)`,
      );
    } finally {
      rmSync(tempIndex, { force: true });
      rmSync(tempPatch, { force: true });
      rmSync(tempPaths, { force: true });
    }
  }

  return preserved.length > 0 ? { kind: 'preserved', repos: preserved } : { kind: 'nothing' };
}

/** Every preserved patch of one node run, in repository-name order. */
export function readPreservedWork(
  deps: Pick<PreserveDeps, 'artifactRoot'>,
  input: { graphRunId: number; nodeRunId: number },
): PreservedWorkEntry[] {
  const root = deps.artifactRoot(input.graphRunId);
  if (root === '') return [];
  const dir = preservedDir(root, input.nodeRunId);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const entries: PreservedWorkEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.patch')) continue;
    const repoName = name.slice(0, -'.patch'.length);
    if (repoName === '' || repoName.startsWith('.')) continue;
    entries.push({
      repoName,
      patchPath: join(dir, name),
      paths: readPaths(join(dir, `${repoName}.paths.json`)),
    });
  }
  return entries;
}

/**
 * Apply the preserved patch of one repository to a FRESH clone at the same base
 * commit. The work lands uncommitted — the node checks it and continues. A
 * patch that does not apply leaves the clone clean and is KEPT for a human.
 */
export async function restoreNodeWork(
  deps: RestoreDeps,
  input: RestoreWorkInput,
): Promise<RestoreWorkResult> {
  const root = deps.artifactRoot(input.graphRunId);
  if (root === '') return { kind: 'none' };
  const stem = repoFileStem(input.repoName);
  if (stem === null) return { kind: 'none' };
  const dir = preservedDir(root, input.nodeRunId);
  const patchPath = join(dir, `${stem}.patch`);
  if (!isPathUnder(patchPath, dir) || !existsSync(patchPath)) return { kind: 'none' };

  const check = await deps.git(['apply', '--check', '--binary', patchPath], input.cwd);
  if (check.exitCode !== 0) {
    const reason = describeGitFailure(`git apply --check of ${input.repoName}`, check);
    deps.debug?.(
      `[graph] preserve: node run ${input.nodeRunId}/${input.repoName} patch does not apply — ${reason}`,
    );
    return { kind: 'failed', reason };
  }
  const apply = await deps.git(
    ['apply', '--binary', '--whitespace=nowarn', patchPath],
    input.cwd,
  );
  if (apply.exitCode !== 0) {
    // Reset the clone to a clean state; the patch is kept for a human.
    await deps.git(['reset', '--hard', '-q', 'HEAD'], input.cwd);
    await deps.git(['clean', '-fd', '-q'], input.cwd);
    const reason = describeGitFailure(`git apply of ${input.repoName}`, apply);
    deps.debug?.(
      `[graph] preserve: node run ${input.nodeRunId}/${input.repoName} patch failed after a good check — ${reason}`,
    );
    return { kind: 'failed', reason };
  }
  deps.debug?.(
    `[graph] preserve: node run ${input.nodeRunId}/${input.repoName} restored from ${patchPath}`,
  );
  return { kind: 'restored', patchPath };
}
