import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Manifest } from '../../manifest/types.js';
import type { ArtifactBaseline } from '../../model/artifacts.js';
import {
  GIT_TERMINATION_GRACE_MS,
  GIT_TIMEOUT_MS,
  runGitBytes,
  type GitBytesRunner,
} from '../../integrations/git.js';
import { latestBaselineDecisions } from '../../store/baselineDecisions.js';
import { baselineState, type BaselineEntry } from '../../workflow/gates/baselineReview.js';
import { deriveBaselineEntries, type BaselineHostDeps } from '../../workflow/gates/baselineReviewTicket.js';

/**
 * The host half of the UAT report's baseline rows (@arch:BASELINE-REVIEW):
 * detection, old-image materialization, and the webview-safe row shape. Free of
 * `vscode` — the URI minting (`asWebviewUri`) is injected.
 */

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** A screenshot can exceed git's default 1 MiB output cap; 16 MiB is far beyond any baseline. */
const OLD_IMAGE_MAX_BYTES = 16 * 1024 * 1024;

const defaultGitBytes: GitBytesRunner = (args, cwd, options) =>
  runGitBytes(args, cwd, GIT_TIMEOUT_MS, OLD_IMAGE_MAX_BYTES, GIT_TERMINATION_GRACE_MS, options?.signal);

/** `<globalStorage>/baseline-review` — where old images are materialized. */
export function baselineReviewRoot(storageDir: string): string {
  return join(storageDir, 'baseline-review');
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** One changed file as the blocked banner reviews it; image URIs are minted per panel. */
export interface BaselineReviewRow {
  /** Position in the host's detection order — the ONLY thing a decision message carries back. */
  index: number;
  path: string;
  /** The path minus the configured glob's static prefix. */
  label: string;
  status: 'added' | 'modified' | 'deleted';
  oldSrc: string | null;
  newSrc: string | null;
  decision: 'pending' | 'approved' | 'rejected';
  reason: string | null;
}

/** The path minus the static directory prefix of the first glob it sits under. */
export function baselineLabel(path: string, globs: readonly string[]): string {
  for (const glob of globs) {
    const wildcard = glob.search(/[*?[{]/);
    const staticPart = wildcard === -1 ? glob : glob.slice(0, wildcard);
    const prefix = staticPart.slice(0, staticPart.lastIndexOf('/') + 1);
    if (prefix !== '' && path.startsWith(prefix) && path.length > prefix.length) {
      return path.slice(prefix.length);
    }
  }
  return path;
}

async function copyInto(dir: string, bytes: Buffer, path: string): Promise<string> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const file = join(dir, `${sha}${extname(path).toLowerCase()}`);
  if (!existsSync(file)) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, bytes);
  }
  return file;
}

/**
 * Copy the OLD image (`git show <merge-base>:<path>`) into the extension's
 * storage, content-addressed so a re-render is free. Null when git has no such
 * blob. The file name is a hash and an extension — nothing the agent controls
 * ever becomes a path segment.
 */
async function materializeOld(
  deps: { gitBytes?: GitBytesRunner },
  entry: BaselineEntry,
  dir: string,
): Promise<string | null> {
  const gitBytes = deps.gitBytes ?? defaultGitBytes;
  const shown = await gitBytes(['show', `${entry.mergeBase}:${entry.path}`], entry.cwd);
  if (shown.exitCode !== 0 || shown.stdoutTruncated) return null;
  return copyInto(dir, shown.stdout, entry.path);
}

/**
 * Copy the NEW image (the working-tree file) next to the old one, so the
 * panel's only resource root is the fixed storage directory — worktrees come
 * and go, and the webview is never granted a path into one.
 */
async function materializeNew(
  deps: { readFile?: (absPath: string) => Promise<Buffer> },
  entry: BaselineEntry,
  dir: string,
): Promise<string | null> {
  const read = deps.readFile ?? ((abs: string) => readFile(abs));
  try {
    return await copyInto(dir, await read(join(entry.cwd, entry.path)), entry.path);
  } catch {
    return null;
  }
}

export interface BaselineRowsInput extends BaselineHostDeps {
  gitBytes?: GitBytesRunner;
  ticketId: number;
  /** `<globalStorage>/baseline-review` — the old-image root, added to localResourceRoots. */
  storageRoot: string;
  /** `webview.asWebviewUri(Uri.file(p)).toString()`, minted per panel. */
  toUri: (absPath: string) => string;
}

/** What the dashboard manager calls: rows for one ticket, URIs minted for ONE panel. */
export type BaselineRowsLoader = (
  ticketId: number,
  toUri: (absPath: string) => string,
) => Promise<BaselineReviewRow[]>;

export function buildBaselineRowsLoader(
  deps: Omit<BaselineHostDeps, 'manifest'> & {
    manifest: () => Manifest | undefined;
    storageRoot: string;
  },
): BaselineRowsLoader {
  return (ticketId, toUri) =>
    loadBaselineRows({ ...deps, manifest: deps.manifest(), ticketId, toUri });
}

/** The report rows for a ticket's changed baselines; `[]` when the feature is off or nothing changed. */
export async function loadBaselineRows(input: BaselineRowsInput): Promise<BaselineReviewRow[]> {
  const entries = await deriveBaselineEntries(input, input.ticketId);
  if (entries.length === 0) return [];
  const globs = input.manifest?.uat?.baselineReview?.paths ?? [];
  const latest = latestBaselineDecisions(input.store, input.ticketId);
  const dir = join(input.storageRoot, String(input.ticketId));
  const rows: BaselineReviewRow[] = [];
  for (const [index, entry] of entries.entries()) {
    const image = isImagePath(entry.path);
    const oldFile =
      image && entry.status !== 'added' ? await materializeOld(input, entry, dir) : null;
    const newFile =
      image && entry.status !== 'deleted' ? await materializeNew(input, entry, dir) : null;
    const state = baselineState(entry, latest);
    rows.push({
      index,
      path: entry.path,
      label: baselineLabel(entry.path, globs),
      status: entry.status,
      oldSrc: oldFile ? input.toUri(oldFile) : null,
      newSrc: newFile ? input.toUri(newFile) : null,
      decision: state.kind,
      reason: state.kind === 'rejected' ? state.reason : null,
    });
  }
  return rows;
}


/**
 * Overlay the loaded rows: the banner gets them whole (images, indices), the UAT
 * report only a read-only list (@arch:SHELF) — no images, no indices.
 */
export function withBaselines<S extends { artifacts: ReadonlyArray<{ id: string }> }>(
  state: S,
  rows: readonly BaselineReviewRow[],
): S & { baselineReview: BaselineReviewRow[] } {
  const listed: ArtifactBaseline[] = rows.map((r) => ({
    path: r.path,
    status: r.status,
    decision: r.decision,
    reason: r.reason,
  }));
  return {
    ...state,
    baselineReview: [...rows],
    artifacts: rows.length === 0
      ? [...state.artifacts]
      : state.artifacts.map((a) => (a.id === 'uat-report' ? { ...a, baselines: listed } : a)),
  };
}
