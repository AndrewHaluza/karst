import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import {
  GIT_TERMINATION_GRACE_MS,
  GIT_TIMEOUT_MS,
  runGitBytes,
  type GitBytesRunner,
  type GitRunner,
} from '../../integrations/git.js';
import type {
  DiffSource,
  DiffTarget,
  PreparedDiff,
  PreparedDiffResource,
} from './git.js';

export interface ResourceStat {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isSymbolicLink(): boolean;
}

export interface WorkingFileAccess {
  lstat(path: string): Promise<ResourceStat>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  read(path: string): Promise<Buffer>;
}

export interface ResourceFingerprint {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface IndexExpectation {
  path: string;
  blob: string | null;
}

export interface WorkingExpectation {
  path: string;
  fingerprint: ResourceFingerprint | null;
}

export interface TargetSnapshot {
  cwd: string;
  head: string;
  index: readonly IndexExpectation[];
  working: readonly WorkingExpectation[];
}

export const DIFF_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
const targetSnapshots = new WeakMap<DiffTarget, TargetSnapshot>();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const defaultContentGit: GitBytesRunner = (args, cwd, options) =>
  runGitBytes(
    args,
    cwd,
    GIT_TIMEOUT_MS,
    DIFF_CONTENT_MAX_BYTES,
    GIT_TERMINATION_GRACE_MS,
    options?.signal,
  );

export class TextDiffUnavailableError extends Error {
  constructor(reason: string) {
    super(`Text diff is unavailable: ${reason}`);
    this.name = 'TextDiffUnavailableError';
  }
}

export class StaleDiffTargetError extends Error {
  constructor(reason: string) {
    super(`That change is stale: ${reason}. Refresh ticket changes and try again.`);
    this.name = 'StaleDiffTargetError';
  }
}

function abortError(): Error {
  const error = new Error('Git inspection was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function fingerprint(stat: ResourceStat): ResourceFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function fingerprintsEqual(
  left: ResourceFingerprint | null,
  right: ResourceFingerprint | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function fingerprintAt(
  path: string,
  lstat: (path: string) => Promise<ResourceStat>,
  signal?: AbortSignal,
): Promise<ResourceFingerprint | null> {
  throwIfAborted(signal);
  try {
    const result = fingerprint(await lstat(path));
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Associates context only with the exact host-created target object. */
export function registerDiffTargetSnapshot(
  target: DiffTarget,
  snapshot: TargetSnapshot,
): void {
  targetSnapshots.set(target, snapshot);
}

function stale(reason: string): never {
  throw new StaleDiffTargetError(reason);
}

function failureReason(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): string {
  return result.stderr.trim() || result.stdout.trim() || `git exit ${result.exitCode}`;
}

async function validateTarget(
  git: GitRunner,
  target: DiffTarget,
  snapshot: TargetSnapshot,
  workingFile: WorkingFileAccess,
): Promise<void> {
  const validationGit = async (args: string[], what: string) => {
    try {
      const result = await git(args, snapshot.cwd);
      if (result.stdoutTruncated) {
        throw new TextDiffUnavailableError(`${what} output was truncated`);
      }
      return result;
    } catch (error) {
      if (error instanceof TextDiffUnavailableError) throw error;
      throw new TextDiffUnavailableError(
        `could not validate ${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const headResult = await validationGit(
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    'worktree HEAD',
  );
  if (headResult.exitCode !== 0) {
    throw new TextDiffUnavailableError(failureReason(headResult));
  }
  const currentHead = headResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(currentHead)) {
    throw new TextDiffUnavailableError('Git returned an invalid HEAD object id');
  }
  if (currentHead !== snapshot.head) stale('the worktree HEAD changed');

  for (const expected of snapshot.index) {
    const current = await validationGit(
      ['rev-parse', '--verify', '--quiet', `:./${expected.path}`],
      `index entry for ${expected.path}`,
    );
    let currentBlob: string | null;
    if (current.exitCode === 0) {
      currentBlob = current.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(currentBlob)) {
        throw new TextDiffUnavailableError('Git returned an invalid index object id');
      }
    } else if (
      current.exitCode === 1
      && current.stdout.trim() === ''
      && (current.stderr.trim() === '' || current.stderr.trim() === 'git exited 1')
    ) {
      currentBlob = null;
    } else {
      throw new TextDiffUnavailableError(failureReason(current));
    }
    if (currentBlob !== expected.blob) stale(`the index changed for ${expected.path}`);
  }

  for (const expected of snapshot.working) {
    let current: ResourceFingerprint | null;
    try {
      current = await fingerprintAt(expected.path, workingFile.lstat);
    } catch (error) {
      throw new TextDiffUnavailableError(
        `could not validate the working resource: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!fingerprintsEqual(current, expected.fingerprint)) {
      stale(`the working resource changed for ${target.displayPath}`);
    }
  }
}

function assertSize(size: number): void {
  if (!Number.isFinite(size) || size < 0) {
    throw new TextDiffUnavailableError('resource size is invalid');
  }
  if (size > DIFF_CONTENT_MAX_BYTES) {
    throw new TextDiffUnavailableError(`resource exceeds ${DIFF_CONTENT_MAX_BYTES} bytes`);
  }
}

function decodeText(bytes: Buffer, kind: string): string {
  if (bytes.includes(0)) throw new TextDiffUnavailableError(`${kind} is binary`);
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new TextDiffUnavailableError(`${kind} is not valid UTF-8`);
  }
}

export async function prepareDiff(
  git: GitRunner,
  target: DiffTarget,
  workingFile: WorkingFileAccess,
  gitBytes: GitBytesRunner = defaultContentGit,
): Promise<PreparedDiff> {
  const snapshot = targetSnapshots.get(target);
  if (!snapshot) throw new TextDiffUnavailableError('the worktree for this diff is unknown');
  await validateTarget(git, target, snapshot, workingFile);

  const runText = async (args: string[]): Promise<string> => {
    try {
      const result = await git(args, snapshot.cwd);
      if (result.exitCode !== 0) {
        throw new TextDiffUnavailableError(failureReason(result));
      }
      if (result.stdoutTruncated) {
        throw new TextDiffUnavailableError('Git metadata output was truncated');
      }
      return result.stdout;
    } catch (error) {
      if (
        error instanceof TextDiffUnavailableError
        || error instanceof StaleDiffTargetError
      ) {
        throw error;
      }
      throw new TextDiffUnavailableError(error instanceof Error ? error.message : String(error));
    }
  };

  const fsCall = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof TextDiffUnavailableError
        || error instanceof StaleDiffTargetError
      ) {
        throw error;
      }
      throw new TextDiffUnavailableError(error instanceof Error ? error.message : String(error));
    }
  };

  const realRoot = await fsCall(() => workingFile.realpath(snapshot.cwd));
  const assertWithinRealRoot = (path: string): void => {
    const fromRoot = relative(realRoot, path);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new TextDiffUnavailableError('resource resolves outside the real worktree');
    }
  };

  type PreparedWorking =
    | { kind: 'file'; path: string; bytes: Buffer }
    | { kind: 'symlink'; content: string; bytes: Buffer };
  const preparedWorking = new Map<string, Promise<PreparedWorking>>();
  const prepareWorking = (path: string): Promise<PreparedWorking> => {
    const existing = preparedWorking.get(path);
    if (existing) return existing;
    const preparing = fsCall(async () => {
      const workingCall = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          if (isMissing(error)) stale(`the working resource changed for ${target.displayPath}`);
          throw error;
        }
      };
      if (!isAbsolute(path)) {
        throw new TextDiffUnavailableError('working resource path is not absolute');
      }

      const realParent = await workingCall(() => workingFile.realpath(dirname(path)));
      assertWithinRealRoot(realParent);
      const before = await workingCall(() => workingFile.lstat(path));
      const captured = snapshot.working.find((expected) => expected.path === path);
      if (captured && !fingerprintsEqual(fingerprint(before), captured.fingerprint)) {
        stale(`the working resource changed for ${target.displayPath}`);
      }
      assertSize(before.size);
      if (before.isSymbolicLink()) {
        const content = await workingCall(() => workingFile.readlink(path));
        const after = fingerprint(await workingCall(() => workingFile.lstat(path)));
        if (!fingerprintsEqual(fingerprint(before), after)) {
          stale(`the working resource changed for ${target.displayPath}`);
        }
        const bytes = Buffer.from(content);
        assertSize(bytes.byteLength);
        return { kind: 'symlink' as const, content, bytes };
      }

      const realPath = await workingCall(() => workingFile.realpath(path));
      assertWithinRealRoot(realPath);
      const bytes = await workingCall(() => workingFile.read(realPath));
      const after = fingerprint(await workingCall(() => workingFile.lstat(path)));
      if (!fingerprintsEqual(fingerprint(before), after)) {
        stale(`the working resource changed for ${target.displayPath}`);
      }
      assertSize(bytes.byteLength);
      decodeText(bytes, 'working resource');
      return { kind: 'file' as const, path: realPath, bytes };
    });
    preparedWorking.set(path, preparing);
    return preparing;
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
            : source.label === 'HEAD'
              ? 'HEAD'
              : source.label.slice(0, 7);
    return `${basename(path)} (${comparison})`;
  };

  const gitResource = async (
    source: Extract<DiffSource, { kind: 'git' | 'index' }>,
  ): Promise<string> => {
    const object =
      source.kind === 'git' ? `${source.revision}:${source.path}` : source.blob;
    const sizeText = await runText(['cat-file', '-s', object]);
    const trimmedSize = sizeText.trim();
    if (!/^\d+$/.test(trimmedSize)) {
      throw new TextDiffUnavailableError('Git returned an invalid object size');
    }
    const size = Number.parseInt(trimmedSize, 10);
    assertSize(size);

    const result = await gitBytes(['cat-file', 'blob', object], snapshot.cwd);
    if (result.exitCode !== 0) {
      throw new TextDiffUnavailableError(result.stderr.trim() || `git exit ${result.exitCode}`);
    }
    if (result.stdoutTruncated) {
      throw new TextDiffUnavailableError('Git content output was truncated');
    }
    if (result.stdout.byteLength !== size) {
      throw new TextDiffUnavailableError('Git content length did not match its object size');
    }
    return decodeText(result.stdout, 'Git resource');
  };

  const resource = async (source: DiffSource): Promise<PreparedDiffResource> => {
    if (source.kind === 'empty') {
      return { kind: 'virtual', label: resourceLabel(source), content: '' };
    }
    if (source.kind === 'working') {
      const prepared = await prepareWorking(source.path);
      return prepared.kind === 'symlink'
        ? { kind: 'virtual', label: resourceLabel(source), content: prepared.content }
        : { kind: 'file', label: resourceLabel(source), path: prepared.path };
    }
    return {
      kind: 'virtual',
      label: resourceLabel(source),
      content: await gitResource(source),
    };
  };

  return {
    title: `${target.repoLabel} · ${target.groupLabel} · ${target.displayPath}`,
    left: await resource(target.left),
    right: await resource(target.right),
  };
}
