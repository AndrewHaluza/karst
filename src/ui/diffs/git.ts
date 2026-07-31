import { lstat as fsLstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitRunner } from '../../integrations/git.js';
import {
  fingerprintAt,
  registerDiffTargetSnapshot,
  type IndexExpectation,
  type WorkingExpectation,
} from './diffResources.js';
import type {
  CommitHeader,
  FileChangeStatus,
  ParsedFile,
} from './gitParsers.js';
import {
  parseCommitHeaders,
  parseNameStatus,
  parseStageTwoEntries,
  parseStageZeroEntries,
} from './gitParsers.js';

export {
  parseCommitHeaders,
  parseNameStatus,
  parseStageZeroEntries,
};
export type { FileChangeStatus } from './gitParsers.js';
export {
  DIFF_CONTENT_MAX_BYTES,
  prepareDiff,
  StaleDiffTargetError,
  TextDiffUnavailableError,
} from './diffResources.js';
export type {
  ResourceStat,
  WorkingFileAccess,
} from './diffResources.js';

export type DiffSource =
  | { kind: 'empty'; label: string }
  | { kind: 'git'; revision: string; path: string; label: string }
  | { kind: 'index'; blob: string; path: string; label: string }
  | { kind: 'working'; path: string; label: string };

export interface DiffTarget {
  repoLabel: string;
  groupLabel: string;
  displayPath: string;
  left: DiffSource;
  right: DiffSource;
}

export interface InspectedFile {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
  target: DiffTarget;
}

export interface InspectedCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
  files: InspectedFile[];
}

export interface WorktreeSpec {
  label: string;
  path: string;
  branch: string | null;
  baseRef: string | null;
}

export interface InspectedWorktree {
  spec: WorktreeSpec;
  commits: InspectedCommit[];
  staged: InspectedFile[];
  unstaged: InspectedFile[];
  untracked: InspectedFile[];
}

export type PreparedDiffResource =
  | { kind: 'virtual'; label: string; content: string }
  | { kind: 'file'; label: string; path: string };

export interface PreparedDiff {
  title: string;
  left: PreparedDiffResource;
  right: PreparedDiffResource;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function abortError(): Error {
  const error = new Error('Git inspection was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function sourceEmpty(label: string): DiffSource {
  return { kind: 'empty', label };
}

function workingPath(spec: WorktreeSpec, path: string): string {
  const root = resolve(spec.path);
  const candidate = resolve(join(spec.path, path));
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ''
    || fromRoot === '..'
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw new Error(`Git inspection for ${spec.label} rejected an out-of-worktree path`);
  }
  return candidate;
}

function registerTarget(
  spec: WorktreeSpec,
  head: string,
  groupLabel: string,
  file: ParsedFile,
  left: DiffSource,
  right: DiffSource,
  index: readonly IndexExpectation[] = [],
  working: readonly WorkingExpectation[] = [],
): DiffTarget {
  const target: DiffTarget = {
    repoLabel: spec.label,
    groupLabel,
    displayPath: file.path,
    left,
    right,
  };
  registerDiffTargetSnapshot(target, {
    cwd: spec.path,
    head,
    index: dedupeIndex(index),
    working: dedupeWorking(working),
  });
  return target;
}

function dedupeIndex(entries: readonly IndexExpectation[]): IndexExpectation[] {
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}

function dedupeWorking(entries: readonly WorkingExpectation[]): WorkingExpectation[] {
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}

function requiredIndexBlob(
  entries: ReadonlyMap<string, string>,
  spec: WorktreeSpec,
  path: string,
): string {
  const blob = entries.get(path);
  if (!blob) {
    throw new Error(`Git inspection failed for ${spec.label}: index blob is missing for ${path}`);
  }
  return blob;
}

function commitFile(
  spec: WorktreeSpec,
  head: string,
  commit: CommitHeader,
  parent: string,
  file: ParsedFile,
): InspectedFile {
  const oldPath = file.oldPath ?? file.path;
  const target = registerTarget(
    spec,
    head,
    `${commit.shortHash} ${commit.subject}`,
    file,
    file.status === 'added'
      ? sourceEmpty(parent)
      : { kind: 'git', revision: parent, path: oldPath, label: parent },
    file.status === 'deleted'
      ? sourceEmpty(commit.shortHash)
      : { kind: 'git', revision: commit.hash, path: file.path, label: commit.shortHash },
  );
  return { ...file, target };
}

function stagedFile(
  spec: WorktreeSpec,
  head: string,
  entries: ReadonlyMap<string, string>,
  file: ParsedFile,
): InspectedFile {
  const oldPath = file.oldPath ?? file.path;
  const indexBlob =
    file.status === 'deleted' ? null : requiredIndexBlob(entries, spec, file.path);
  const expectations: IndexExpectation[] = [{ path: file.path, blob: indexBlob }];
  if (file.oldPath) expectations.push({ path: file.oldPath, blob: null });

  return {
    ...file,
    target: registerTarget(
      spec,
      head,
      'Staged Changes',
      file,
      file.status === 'added'
        ? sourceEmpty('HEAD')
        : { kind: 'git', revision: head, path: oldPath, label: 'HEAD' },
      file.status === 'deleted'
        ? sourceEmpty('Index')
        : { kind: 'index', blob: indexBlob!, path: file.path, label: 'Index' },
      expectations,
    ),
  };
}

async function unstagedFile(
  spec: WorktreeSpec,
  head: string,
  entries: ReadonlyMap<string, string>,
  file: ParsedFile,
  signal?: AbortSignal,
): Promise<InspectedFile> {
  const oldPath = file.oldPath ?? file.path;
  const indexBlob = entries.get(oldPath) ?? null;
  if (file.status !== 'added' && indexBlob === null) {
    throw new Error(`Git inspection failed for ${spec.label}: index blob is missing for ${oldPath}`);
  }
  const currentPath = workingPath(spec, file.path);
  const currentFingerprint =
    file.status === 'deleted' ? null : await fingerprintAt(currentPath, fsLstat, signal);
  if (file.status !== 'deleted' && currentFingerprint === null) {
    throw new Error(`Git inspection failed for ${spec.label}: working file is missing for ${file.path}`);
  }
  const indexExpectations: IndexExpectation[] = [{ path: oldPath, blob: indexBlob }];
  const workingExpectations: WorkingExpectation[] = [{
    path: currentPath,
    fingerprint: currentFingerprint,
  }];
  if (file.oldPath) {
    indexExpectations.push({ path: file.path, blob: entries.get(file.path) ?? null });
    workingExpectations.push({
      path: workingPath(spec, file.oldPath),
      fingerprint: null,
    });
  }

  return {
    ...file,
    target: registerTarget(
      spec,
      head,
      'Unstaged Changes',
      file,
      file.status === 'added'
        ? sourceEmpty('Index')
        : { kind: 'index', blob: indexBlob!, path: oldPath, label: 'Index' },
      file.status === 'deleted'
        ? sourceEmpty('Working Tree')
        : { kind: 'working', path: currentPath, label: 'Working Tree' },
      indexExpectations,
      workingExpectations,
    ),
  };
}

/**
 * An unmerged path has NO stage-zero index entry, so it can never be routed
 * through `requiredIndexBlob`. It is compared as "ours" (index stage two, or
 * empty when our side has none) against the working tree, which is where the
 * conflict markers live. One conflicted path degrades one row, never the
 * whole worktree.
 */
async function conflictedFile(
  spec: WorktreeSpec,
  head: string,
  ourBlob: string | null,
  path: string,
  signal?: AbortSignal,
): Promise<InspectedFile> {
  const file: ParsedFile = { status: 'modified', path, oldPath: null, conflicted: true };
  const currentPath = workingPath(spec, path);
  const currentFingerprint = await fingerprintAt(currentPath, fsLstat, signal);
  return {
    ...file,
    target: registerTarget(
      spec,
      head,
      'Merge Conflicts',
      file,
      ourBlob === null
        ? sourceEmpty('Ours')
        : { kind: 'index', blob: ourBlob, path, label: 'Ours' },
      currentFingerprint === null
        ? sourceEmpty('Working Tree')
        : { kind: 'working', path: currentPath, label: 'Working Tree' },
      [{ path, blob: null }],
      [{ path: currentPath, fingerprint: currentFingerprint }],
    ),
  };
}

async function untrackedFile(
  spec: WorktreeSpec,
  head: string,
  path: string,
  signal?: AbortSignal,
): Promise<InspectedFile> {
  const file: ParsedFile = { status: 'added', path, oldPath: null };
  const currentPath = workingPath(spec, path);
  const currentFingerprint = await fingerprintAt(currentPath, fsLstat, signal);
  if (currentFingerprint === null) {
    throw new Error(`Git inspection failed for ${spec.label}: untracked file is missing for ${path}`);
  }
  return {
    ...file,
    target: registerTarget(
      spec,
      head,
      'Untracked Files',
      file,
      sourceEmpty('Empty'),
      { kind: 'working', path: currentPath, label: 'Working Tree' },
      [{ path, blob: null }],
      [{ path: currentPath, fingerprint: currentFingerprint }],
    ),
  };
}

async function gitText(
  git: GitRunner,
  args: string[],
  spec: WorktreeSpec,
  what: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const result = await git(args, spec.path, { signal });
  throwIfAborted(signal);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || `git exit ${result.exitCode}`;
    throw new Error(`Git inspection failed for ${spec.label}: git ${what}: ${reason}`);
  }
  if (result.stdoutTruncated) {
    throw new Error(`Git inspection failed for ${spec.label}: git ${what} output was truncated`);
  }
  return result.stdout;
}

async function firstParent(
  git: GitRunner,
  spec: WorktreeSpec,
  commit: string,
  signal?: AbortSignal,
): Promise<string> {
  const output = await gitText(
    git,
    ['rev-list', '--parents', '-n', '1', commit],
    spec,
    'rev-list',
    signal,
  );
  const parts = output.trim().split(/\s+/);
  if (parts[0] !== commit) {
    throw new Error(`Git inspection failed for ${spec.label}: malformed parent for ${commit}`);
  }
  return parts[1] ?? EMPTY_TREE;
}

/** Every path whose index entry a pending row may need, new and old alike. */
function indexPathsOf(...groups: readonly ParsedFile[][]): string[] {
  const paths = new Set<string>();
  for (const group of groups) {
    for (const file of group) {
      paths.add(file.path);
      if (file.oldPath) paths.add(file.oldPath);
    }
  }
  return [...paths];
}

/**
 * `:(literal)` is mandatory: a path containing `*`, `?`, `[` or a leading `:`
 * would otherwise be read as a glob or as pathspec magic and match the wrong
 * entries — or none, which reads as a missing index blob.
 */
async function readIndexEntries(
  git: GitRunner,
  spec: WorktreeSpec,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  if (paths.length === 0) return '';
  return gitText(
    git,
    ['ls-files', '--stage', '-z', '--', ...paths.map((path) => `:(literal)${path}`)],
    spec,
    'index entries',
    signal,
  );
}

export async function inspectWorktree(
  git: GitRunner,
  spec: WorktreeSpec,
  signal?: AbortSignal,
): Promise<InspectedWorktree> {
  if (!spec.baseRef) {
    throw new Error(`Git inspection failed for ${spec.label}: recorded base is missing`);
  }

  const head = (
    await gitText(
      git,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      spec,
      'rev-parse HEAD',
      signal,
    )
  ).trim();
  const base = (
    await gitText(
      git,
      ['rev-parse', '--verify', `${spec.baseRef}^{commit}`],
      spec,
      'rev-parse base',
      signal,
    )
  ).trim();
  const mergeBase = (
    await gitText(git, ['merge-base', head, base], spec, 'merge-base', signal)
  ).trim();
  const commitHeaders = parseCommitHeaders(
    await gitText(
      git,
      [
        'log',
        '--first-parent',
        '-z',
        '--format=%H%x00%h%x00%an%x00%aI%x00%s',
        `${mergeBase}..${head}`,
      ],
      spec,
      'log',
      signal,
    ),
  );

  const commits: InspectedCommit[] = [];
  for (const header of commitHeaders) {
    const parent = await firstParent(git, spec, header.hash, signal);
    const files = parseNameStatus(
      await gitText(
        git,
        ['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '-M', parent, header.hash],
        spec,
        'diff-tree',
        signal,
      ),
    ).map((file) => commitFile(spec, head, header, parent, file));
    commits.push({ ...header, files });
  }

  const stagedFiles = parseNameStatus(
    await gitText(
      git,
      ['diff', '--cached', '--name-status', '-z', '-M', head],
      spec,
      'staged diff',
      signal,
    ),
  );
  const unstagedFiles = parseNameStatus(
    await gitText(git, ['diff', '--name-status', '-z', '-M'], spec, 'unstaged diff', signal),
  );
  // Read the index for the changed paths only: an unscoped `ls-files --stage`
  // scales with REPOSITORY size and is the one command here that can exceed the
  // runner's output bound on a large repo, turning the worktree into an error.
  const indexOutput = await readIndexEntries(
    git,
    spec,
    indexPathsOf(stagedFiles, unstagedFiles),
    signal,
  );
  const indexEntries = parseStageZeroEntries(indexOutput);
  const ourEntries = parseStageTwoEntries(indexOutput);
  // A conflicted path is reported by BOTH pending commands; list it exactly once.
  const conflictedPaths = new Set(
    [...stagedFiles, ...unstagedFiles].filter((file) => file.conflicted).map((file) => file.path),
  );
  const pending = (file: ParsedFile): boolean => !conflictedPaths.has(file.path);

  const staged = stagedFiles
    .filter(pending)
    .map((file) => stagedFile(spec, head, indexEntries, file));
  const unstaged = await Promise.all(
    unstagedFiles
      .filter(pending)
      .map(async (file) => unstagedFile(spec, head, indexEntries, file, signal)),
  );
  const conflicted = await Promise.all(
    [...conflictedPaths].map(
      async (path) => conflictedFile(spec, head, ourEntries.get(path) ?? null, path, signal),
    ),
  );
  const untrackedOutput = await gitText(
    git,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    spec,
    'untracked files',
    signal,
  );
  const untrackedPaths = untrackedOutput.split('\0');
  if (untrackedPaths.at(-1) === '') untrackedPaths.pop();
  // `async` so a rejected path still reaches Promise.all instead of orphaning
  // the untrackedFile promises already created at lower indexes.
  const untracked = await Promise.all(untrackedPaths.map(async (path) => {
    if (!path) throw new Error(`Git inspection failed for ${spec.label}: incomplete untracked path`);
    return untrackedFile(spec, head, path, signal);
  }));

  throwIfAborted(signal);
  return { spec, commits, staged, unstaged: [...unstaged, ...conflicted], untracked };
}
