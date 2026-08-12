/**
 * Artifact snapshot protocol (Slice 2 Task 7).
 *
 * This is the TOCTOU / symlink / FIFO class. Validation and copy are ONE
 * operation per file:
 *
 * 1. open with `O_NOFOLLOW | O_NONBLOCK`;
 * 2. `fstat` the OPENED descriptor;
 * 3. reject non-regular files, link count > 1, size over the declared
 *    `maxBytes`, and media-type mismatch;
 * 4. read from that same descriptor into immutable content-addressed
 *    storage — never re-resolve the path.
 *
 * `O_NONBLOCK` makes a FIFO swapped in by a live writer fail immediately
 * instead of hanging the open; `O_NOFOLLOW` makes a symlink swapped in after
 * validation irrelevant, because the descriptor is already opened on the
 * validated object. The read is bounded to the validated size, so a writer
 * appending mid-read cannot push the snapshot past `maxBytes`.
 *
 * The planner process is terminated and its termination PROVEN before its
 * submission snapshot (Slice 3); this module is the file protocol the two
 * flows (planner submission and node completion) share.
 *
 * Locations (Decision 15), both under extension GLOBAL storage, outside
 * every worktree:
 * - artifacts: `<root>/graph/<projectSlug>/<ticketId>/<graphRunId>/artifacts/`
 * - workspaces: `<root>/graph/<projectSlug>/<ticketId>/<graphRunId>/workspaces/<nodeRunId>/<repoName>/`
 *
 * No `KARST_EXCLUDE_RULES` entry is added for them — that is the reason, so a
 * later reader does not "fix" a missing rule.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';

export type SnapshotMediaType = 'text/markdown' | 'application/json' | 'text/plain';

export interface SnapshotSpec {
  /** The path to snapshot (planner artifact or node output). */
  path: string;
  maxBytes: number;
  mediaType: SnapshotMediaType;
}

export type SnapshotFailureCode =
  | 'missing'
  | 'not-regular'
  | 'hardlinked'
  | 'oversize'
  | 'media-mismatch';

export type SnapshotResult =
  | { ok: true; sha256: string; size: number }
  | { ok: false; code: SnapshotFailureCode; reason: string };

/** The graph run's byte subtree under global storage (Decision 15). */
export function graphRunDir(
  globalStorageRoot: string,
  projectSlug: string,
  ticketId: number,
  graphRunId: number,
): string {
  return join(
    globalStorageRoot,
    'graph',
    projectSlug,
    String(ticketId),
    String(graphRunId),
  );
}

/** Immutable artifact snapshots for one graph run. */
export function artifactRootDir(
  globalStorageRoot: string,
  projectSlug: string,
  ticketId: number,
  graphRunId: number,
): string {
  return join(
    graphRunDir(globalStorageRoot, projectSlug, ticketId, graphRunId),
    'artifacts',
  );
}

/** Isolated node workspaces for one graph run. */
export function workspaceRootDir(
  globalStorageRoot: string,
  projectSlug: string,
  ticketId: number,
  graphRunId: number,
): string {
  return join(
    graphRunDir(globalStorageRoot, projectSlug, ticketId, graphRunId),
    'workspaces',
  );
}

/** True when the declared text media type does not match the bytes. */
export function mediaMismatch(bytes: Uint8Array, mediaType: SnapshotMediaType): boolean {
  if (bytes.includes(0)) return true;
  if (mediaType === 'application/json') {
    try {
      JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Validate-and-copy ONE file through ONE descriptor into content-addressed
 * storage under `snapshotDir` (the `artifacts/` root). The stored name is the
 * SHA-256 of the validated bytes; a partial write never appears under that
 * name (temp file + rename). Never re-resolves the source path.
 */
export function snapshotFile(spec: SnapshotSpec, snapshotDir: string): SnapshotResult {
  let fd: number | undefined;
  try {
    try {
      fd = openSync(spec.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      // O_NOFOLLOW makes a symlink fail the open with ELOOP — the object at
      // the path is not a regular file, not absent.
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        return { ok: false, code: 'not-regular', reason: `${spec.path} is a symlink` };
      }
      return { ok: false, code: 'missing', reason: `cannot open ${spec.path}` };
    }
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, code: 'not-regular', reason: `${spec.path} is not a regular file` };
    }
    if (stat.nlink > 1) {
      return { ok: false, code: 'hardlinked', reason: `${spec.path} has ${stat.nlink} links` };
    }
    if (stat.size > spec.maxBytes) {
      return {
        ok: false,
        code: 'oversize',
        reason: `${spec.path} is ${stat.size} bytes, over the declared ${spec.maxBytes}`,
      };
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, bytes, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const snapshotBytes = offset === stat.size ? bytes : bytes.subarray(0, offset);
    if (mediaMismatch(snapshotBytes, spec.mediaType)) {
      return {
        ok: false,
        code: 'media-mismatch',
        reason: `${spec.path} bytes do not match declared media type ${spec.mediaType}`,
      };
    }
    const sha256 = createHash('sha256').update(snapshotBytes).digest('hex');
    mkdirSync(snapshotDir, { recursive: true });
    const target = join(snapshotDir, sha256);
    if (!existsSync(target)) {
      const temp = join(snapshotDir, `.tmp-${process.pid}-${Date.now()}`);
      writeFileSync(temp, snapshotBytes);
      renameSync(temp, target);
    }
    return { ok: true, sha256, size: snapshotBytes.length };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type StagingCheckResult =
  | { ok: true }
  | { ok: false; code: 'staging-exists'; path: string };

/**
 * E7: every required output's staging destination must be ABSENT at launch —
 * a stale file must never be accepted as this visit's output. Returns the
 * first existing destination.
 */
export function assertStagingAbsent(
  artifactRoot: string,
  relativePaths: readonly string[],
): StagingCheckResult {
  for (const relative of relativePaths) {
    const target = join(artifactRoot, relative);
    if (existsSync(target)) {
      return { ok: false, code: 'staging-exists', path: target };
    }
  }
  return { ok: true };
}
