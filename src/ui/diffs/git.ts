import type { GitRunner } from '../../integrations/git.js';
import { OUTPUT_TRUNCATION_MARKER } from '../../runtime/boundedOutput.js';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type DiffSource =
  | { kind: 'empty'; label: string }
  | { kind: 'git'; revision: string; path: string; label: string }
  | { kind: 'index'; path: string; label: string }
  | { kind: 'working'; path: string; label: string };

export interface DiffTarget {
  repoLabel: string;
  groupLabel: string;
  displayPath: string;
  left: DiffSource;
  right: DiffSource;
  binaryCheck:
    | { kind: 'commit'; parent: string; commit: string; path: string }
    | { kind: 'staged'; path: string }
    | { kind: 'unstaged'; path: string }
    | { kind: 'untracked'; path: string };
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

export const DIFF_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const targetWorktrees = new WeakMap<DiffTarget, string>();

export class TextDiffUnavailableError extends Error {
  constructor(reason: string) {
    super(`Text diff is unavailable: ${reason}`);
    this.name = 'TextDiffUnavailableError';
  }
}

interface ParsedFile {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
}

interface CommitHeader {
  hash: string;
  shortHash: string;
  author: string;
  authoredAt: string;
  subject: string;
}

function rejectTruncated(output: string): void {
  if (output.includes(OUTPUT_TRUNCATION_MARKER)) {
    throw new Error('Git output is incomplete because it was truncated');
  }
}

function required(fields: string[], cursor: number, what: string): string {
  const value = fields[cursor];
  if (value === undefined || value === '') throw new Error(`Incomplete Git ${what} record`);
  return value;
}

/** Strictly parses Git's -z --name-status output without interpreting filenames. */
export function parseNameStatus(output: string): ParsedFile[] {
  rejectTruncated(output);
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const parsed: ParsedFile[] = [];

  for (let cursor = 0; cursor < fields.length;) {
    const token = required(fields, cursor++, 'name-status');
    const code = token[0];
    if (code === 'R' || code === 'C') {
      const oldPath = required(fields, cursor++, 'rename');
      const path = required(fields, cursor++, 'rename');
      parsed.push({ status: code === 'R' ? 'renamed' : 'modified', path, oldPath });
      continue;
    }

    const path = required(fields, cursor++, 'name-status');
    parsed.push({
      status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
      path,
      oldPath: null,
    });
  }

  return parsed;
}

/** Parses the five NUL-delimited fields emitted by the log command used below. */
export function parseCommitHeaders(output: string): CommitHeader[] {
  rejectTruncated(output);
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 5 !== 0) throw new Error('Incomplete Git commit record');

  const commits: CommitHeader[] = [];
  for (let cursor = 0; cursor < fields.length; cursor += 5) {
    commits.push({
      hash: required(fields, cursor, 'commit'),
      shortHash: required(fields, cursor + 1, 'commit'),
      author: required(fields, cursor + 2, 'commit'),
      authoredAt: required(fields, cursor + 3, 'commit'),
      subject: fields[cursor + 4]!,
    });
  }
  return commits;
}

function sourceEmpty(label: string): DiffSource {
  return { kind: 'empty', label };
}

function workingPath(spec: WorktreeSpec, path: string): string {
  const root = resolve(spec.path);
  const candidate = resolve(join(spec.path, path));
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Git inspection for ${spec.label} rejected an out-of-worktree path`);
  }
  return candidate;
}

function trackedTarget(
  spec: WorktreeSpec,
  groupLabel: string,
  file: ParsedFile,
  left: DiffSource,
  right: DiffSource,
  binaryCheck: DiffTarget['binaryCheck'],
): DiffTarget {
  const target: DiffTarget = {
    repoLabel: spec.label,
    groupLabel,
    displayPath: file.path,
    left,
    right,
    binaryCheck,
  };
  targetWorktrees.set(target, spec.path);
  return target;
}

function commitFile(
  spec: WorktreeSpec,
  commit: CommitHeader,
  parent: string,
  file: ParsedFile,
): InspectedFile {
  const oldPath = file.oldPath ?? file.path;
  const target = trackedTarget(
    spec,
    `${commit.shortHash} ${commit.subject}`,
    file,
    file.status === 'added'
      ? sourceEmpty(parent)
      : { kind: 'git', revision: parent, path: oldPath, label: parent },
    file.status === 'deleted'
      ? sourceEmpty(commit.shortHash)
      : { kind: 'git', revision: commit.hash, path: file.path, label: commit.shortHash },
    { kind: 'commit', parent, commit: commit.hash, path: file.path },
  );
  return { ...file, target };
}

function stagedFile(spec: WorktreeSpec, file: ParsedFile): InspectedFile {
  const oldPath = file.oldPath ?? file.path;
  return {
    ...file,
    target: trackedTarget(
      spec,
      'Staged Changes',
      file,
      file.status === 'added'
        ? sourceEmpty('HEAD')
        : { kind: 'git', revision: 'HEAD', path: oldPath, label: 'HEAD' },
      file.status === 'deleted'
        ? sourceEmpty('Index')
        : { kind: 'index', path: file.path, label: 'Index' },
      { kind: 'staged', path: file.path },
    ),
  };
}

function unstagedFile(spec: WorktreeSpec, file: ParsedFile): InspectedFile {
  const oldPath = file.oldPath ?? file.path;
  return {
    ...file,
    target: trackedTarget(
      spec,
      'Unstaged Changes',
      file,
      file.status === 'added'
        ? sourceEmpty('Index')
        : { kind: 'index', path: oldPath, label: 'Index' },
      file.status === 'deleted'
        ? sourceEmpty('Working Tree')
        : { kind: 'working', path: workingPath(spec, file.path), label: 'Working Tree' },
      { kind: 'unstaged', path: file.path },
    ),
  };
}

function untrackedFile(spec: WorktreeSpec, path: string): InspectedFile {
  const file: ParsedFile = { status: 'added', path, oldPath: null };
  return {
    ...file,
    target: trackedTarget(
      spec,
      'Untracked Files',
      file,
      sourceEmpty('Empty'),
      { kind: 'working', path: workingPath(spec, path), label: 'Working Tree' },
      { kind: 'untracked', path },
    ),
  };
}

async function gitText(
  git: GitRunner,
  args: string[],
  spec: WorktreeSpec,
  what: string,
): Promise<string> {
  const result = await git(args, spec.path);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || `git exit ${result.exitCode}`;
    throw new Error(`Git inspection failed for ${spec.label}: git ${what}: ${reason}`);
  }
  if (result.stdout.includes(OUTPUT_TRUNCATION_MARKER)) {
    throw new Error(`Git inspection failed for ${spec.label}: git ${what} output was truncated`);
  }
  return result.stdout;
}

async function firstParent(
  git: GitRunner,
  spec: WorktreeSpec,
  commit: string,
): Promise<string> {
  const output = await gitText(git, ['rev-list', '--parents', '-n', '1', commit], spec, 'rev-list');
  const parts = output.trim().split(/\s+/);
  if (parts[0] !== commit) {
    throw new Error(`Git inspection failed for ${spec.label}: malformed parent for ${commit}`);
  }
  return parts[1] ?? EMPTY_TREE;
}

export async function inspectWorktree(
  git: GitRunner,
  spec: WorktreeSpec,
): Promise<InspectedWorktree> {
  if (!spec.baseRef) throw new Error(`Git inspection failed for ${spec.label}: recorded base is missing`);

  const head = await gitText(git, ['rev-parse', '--verify', 'HEAD^{commit}'], spec, 'rev-parse HEAD');
  const base = await gitText(
    git,
    ['rev-parse', '--verify', `${spec.baseRef}^{commit}`],
    spec,
    'rev-parse base',
  );
  const mergeBase = await gitText(
    git,
    ['merge-base', head.trim(), base.trim()],
    spec,
    'merge-base',
  );
  const commitHeaders = parseCommitHeaders(
    await gitText(
      git,
      [
        'log',
        '--first-parent',
        '-z',
        '--format=%H%x00%h%x00%an%x00%aI%x00%s',
        `${mergeBase.trim()}..HEAD`,
      ],
      spec,
      'log',
    ),
  );

  const commits: InspectedCommit[] = [];
  for (const header of commitHeaders) {
    const parent = await firstParent(git, spec, header.hash);
    const files = parseNameStatus(
      await gitText(
        git,
        ['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '-M', parent, header.hash],
        spec,
        'diff-tree',
      ),
    ).map((file) => commitFile(spec, header, parent, file));
    commits.push({ ...header, files });
  }

  const staged = parseNameStatus(
    await gitText(
      git,
      ['diff', '--cached', '--name-status', '-z', '-M', 'HEAD'],
      spec,
      'staged diff',
    ),
  ).map((file) => stagedFile(spec, file));
  const unstaged = parseNameStatus(
    await gitText(git, ['diff', '--name-status', '-z', '-M'], spec, 'unstaged diff'),
  ).map((file) => unstagedFile(spec, file));
  const untrackedOutput = await gitText(
    git,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    spec,
    'untracked files',
  );
  const untrackedPaths = untrackedOutput.split('\0');
  if (untrackedPaths.at(-1) === '') untrackedPaths.pop();
  const untracked = untrackedPaths.map((path) => {
    if (!path) throw new Error(`Git inspection failed for ${spec.label}: incomplete untracked path`);
    return untrackedFile(spec, path);
  });

  return { spec, commits, staged, unstaged, untracked };
}

export async function prepareDiff(
  git: GitRunner,
  target: DiffTarget,
  workingFile: {
    stat(path: string): Promise<{ size: number }>;
    read(path: string): Promise<Buffer>;
  },
): Promise<PreparedDiff> {
  const cwd = targetWorktrees.get(target);
  if (!cwd) throw new TextDiffUnavailableError('the worktree for this diff is unknown');

  const run = async (args: string[]): Promise<string> => {
    try {
      const result = await git(args, cwd);
      if (result.exitCode !== 0) {
        const reason = result.stderr.trim() || result.stdout.trim() || `git exit ${result.exitCode}`;
        throw new TextDiffUnavailableError(reason);
      }
      if (result.stdout.includes(OUTPUT_TRUNCATION_MARKER)) {
        throw new TextDiffUnavailableError('Git output was truncated');
      }
      return result.stdout;
    } catch (error) {
      if (error instanceof TextDiffUnavailableError) throw error;
      throw new TextDiffUnavailableError(error instanceof Error ? error.message : String(error));
    }
  };

  const assertSize = (size: number): void => {
    if (!Number.isFinite(size) || size < 0) throw new TextDiffUnavailableError('resource size is invalid');
    if (size > DIFF_CONTENT_MAX_BYTES) {
      throw new TextDiffUnavailableError(`resource exceeds ${DIFF_CONTENT_MAX_BYTES} bytes`);
    }
  };

  const statWorking = async (path: string): Promise<void> => {
    try {
      assertSize((await workingFile.stat(path)).size);
    } catch (error) {
      if (error instanceof TextDiffUnavailableError) throw error;
      throw new TextDiffUnavailableError(error instanceof Error ? error.message : String(error));
    }
  };

  const readWorking = async (path: string): Promise<Buffer> => {
    try {
      const content = await workingFile.read(path);
      assertSize(content.byteLength);
      return content;
    } catch (error) {
      if (error instanceof TextDiffUnavailableError) throw error;
      throw new TextDiffUnavailableError(error instanceof Error ? error.message : String(error));
    }
  };

  const objectSize = async (object: string): Promise<void> => {
    const sizeText = await run(['cat-file', '-s', object]);
    const size = Number.parseInt(sizeText.trim(), 10);
    if (!/^\d+$/.test(sizeText.trim())) {
      throw new TextDiffUnavailableError('Git returned an invalid object size');
    }
    assertSize(size);
  };

  const resourceLabel = (source: DiffSource): string => {
    const path = source.kind === 'empty' ? target.displayPath : source.path;
    const comparison =
      source.kind === 'empty'
        ? 'empty'
        : source.kind === 'index'
          ? 'index'
          : source.kind === 'working'
            ? 'working tree'
            : source.revision === 'HEAD'
              ? 'HEAD'
              : source.label.slice(0, 7);
    return `${basename(path)} (${comparison})`;
  };

  const resource = async (source: DiffSource): Promise<PreparedDiffResource> => {
    if (source.kind === 'empty') {
      return { kind: 'virtual', label: resourceLabel(source), content: '' };
    }
    if (source.kind === 'working') {
      await statWorking(source.path);
      await readWorking(source.path);
      return { kind: 'file', label: resourceLabel(source), path: source.path };
    }

    const object = source.kind === 'git' ? `${source.revision}:${source.path}` : `:${source.path}`;
    await objectSize(object);
    const content = await run(['show', object]);
    if (Buffer.byteLength(content) > DIFF_CONTENT_MAX_BYTES) {
      throw new TextDiffUnavailableError(`resource exceeds ${DIFF_CONTENT_MAX_BYTES} bytes`);
    }
    return { kind: 'virtual', label: resourceLabel(source), content };
  };

  if (target.binaryCheck.kind === 'untracked') {
    const path = target.binaryCheck.path;
    await statWorking(path);
    const prefix = (await readWorking(path)).subarray(0, 8 * 1024);
    if (prefix.includes(0)) throw new TextDiffUnavailableError('untracked file is binary');
  } else {
    const args =
      target.binaryCheck.kind === 'commit'
        ? [
            'diff',
            '--numstat',
            target.binaryCheck.parent,
            target.binaryCheck.commit,
            '--',
            target.binaryCheck.path,
          ]
        : target.binaryCheck.kind === 'staged'
          ? ['diff', '--cached', '--numstat', 'HEAD', '--', target.binaryCheck.path]
          : ['diff', '--numstat', '--', target.binaryCheck.path];
    if ((await run(args)).split('\n').some((line) => line.startsWith('-\t-'))) {
      throw new TextDiffUnavailableError('Git reports a binary file');
    }
  }

  return {
    title: `${target.repoLabel} · ${target.groupLabel} · ${target.displayPath}`,
    left: await resource(target.left),
    right: await resource(target.right),
  };
}
