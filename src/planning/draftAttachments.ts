import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { MAX_PASTE_BYTES, validateAttachment } from '../attachments/ingest.js';
import { attachmentsRoot } from '../attachments/paths.js';
import { MIRROR_MAX_BYTES } from '../agent/bridge/mirror.js';
import type { HostAttachment } from '../store/planningProposals.js';
import { MAX_WARNING_CHARS, clipToken } from './draftQualityChecks.js';
import type { ProposalAttachment } from './proposal.js';

/** The most bytes the host keeps for one draft. */
export const MAX_DRAFT_BYTES = 25 * 1024 * 1024;

export type RefusalReason =
  | 'missing'
  | 'outside'
  | 'link'
  | 'not a file'
  | 'hardlink'
  | 'too large'
  | 'type'
  | 'draft cap';

export interface SnapshotArgs {
  storageDir: string;
  /** The session's `KARST_ARTIFACTS` directory. */
  artifactsDir: string;
  proposalId: number;
  entries: readonly ProposalAttachment[];
}

export interface SnapshotResult {
  list: HostAttachment[];
  warnings: string[];
}

/** `<storage>/attachments/draft-<id>`: the host copy of one draft's files. */
export function draftAttachmentDir(storageDir: string, proposalId: number): string {
  return join(attachmentsRoot(storageDir), `draft-${proposalId}`);
}

class Refused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(reason);
  }
}

/** A warning of at most MAX_WARNING_CHARS: the file name is clipped, the rest is fixed. */
function warning(prefix: string, name: string, suffix: string): string {
  return `${prefix}${clipToken(name, Math.max(8, MAX_WARNING_CHARS - prefix.length - suffix.length))}${suffix}`;
}

const refusal = (name: string, reason: RefusalReason): string => warning('attachment refused: ', name, ` (${reason})`);

interface Candidate {
  bytes: Buffer;
  name: string;
}

/** Read one file with every confinement check; throw `Refused` on any failure. */
async function readConfined(artifactsReal: string, artifactsDir: string, rel: string, usedBytes: number): Promise<Candidate> {
  const joined = resolve(artifactsDir, rel);
  const name = basename(joined);
  if (!joined.startsWith(resolve(artifactsDir) + sep)) throw new Refused('outside');
  let first;
  try {
    first = await lstat(joined);
  } catch {
    throw new Refused('missing');
  }
  if (first.isSymbolicLink()) throw new Refused('link');
  let real: string;
  try {
    real = await realpath(joined);
  } catch {
    throw new Refused('missing');
  }
  if (!real.startsWith(artifactsReal + sep)) throw new Refused('outside');
  if (!first.isFile()) throw new Refused('not a file');
  if (first.nlink > 1) throw new Refused('hardlink');
  if (first.size > MAX_PASTE_BYTES) throw new Refused('too large');
  if (validateAttachment(name).ok === false) throw new Refused('type');
  if (usedBytes + first.size > MAX_DRAFT_BYTES) throw new Refused('draft cap');

  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Refused('link');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Refused('not a file');
    if (st.dev !== first.dev || st.ino !== first.ino) throw new Refused('link');
    const buf = Buffer.alloc(Math.min(st.size, MAX_PASTE_BYTES) + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await handle.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > MAX_PASTE_BYTES) throw new Refused('too large');
    if (usedBytes + n > MAX_DRAFT_BYTES) throw new Refused('draft cap');
    return { bytes: buf.subarray(0, n), name };
  } finally {
    await handle.close();
  }
}

async function writeBlob(dir: string, storedName: string, bytes: Buffer): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${storedName}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const h = await open(tmp, 'w', 0o600);
    try {
      await h.writeFile(bytes);
    } finally {
      await h.close();
    }
    await rename(tmp, join(dir, storedName));
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/**
 * Copy the files a draft lists into host-owned storage. Never throws: a refused
 * or failed entry becomes one warning and the others still copy. Every artifact
 * read is realpath-confined, link-free, single-link and dev/ino matched.
 */
export async function snapshotDraftAttachments(args: SnapshotArgs): Promise<SnapshotResult> {
  const list: HostAttachment[] = [];
  const warnings: string[] = [];
  let artifactsReal: string;
  try {
    artifactsReal = await realpath(args.artifactsDir);
  } catch {
    for (const e of args.entries) warnings.push(refusal(basename(e.path), 'missing'));
    return { list, warnings };
  }
  const dir = draftAttachmentDir(args.storageDir, args.proposalId);
  let used = 0;
  for (const entry of args.entries) {
    const label = basename(entry.path);
    try {
      const { bytes, name } = await readConfined(artifactsReal, args.artifactsDir, entry.path, used);
      const v = validateAttachment(name, bytes.length);
      if (!v.ok) throw new Refused('type');
      const storedName = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${v.extension}`;
      used += bytes.length;
      if (list.some((x) => x.storedName === storedName && x.name === name)) continue;
      await writeBlob(dir, storedName, bytes);
      const item: HostAttachment = { name, storedName, kind: v.kind, byteSize: bytes.length };
      if (entry.note !== undefined) item.note = entry.note;
      if (entry.binding !== undefined) item.binding = entry.binding;
      list.push(item);
      if (bytes.length > MIRROR_MAX_BYTES) warnings.push(warning('attachment >2 MB, not in sandbox: ', name, ''));
    } catch (e) {
      warnings.push(refusal(label, e instanceof Refused ? e.reason : 'missing'));
    }
  }
  return { list, warnings };
}

/** Remove the blobs of a draft that the `keep` list no longer names. */
export async function pruneDraftAttachments(
  storageDir: string,
  proposalId: number,
  keep: readonly HostAttachment[],
): Promise<void> {
  const dir = draftAttachmentDir(storageDir, proposalId);
  const names = new Set(keep.map((a) => a.storedName));
  let present: string[];
  try {
    present = await readdir(dir);
  } catch {
    return;
  }
  for (const f of present) if (!names.has(f)) await rm(join(dir, f), { force: true });
}

/** Remove the whole host copy of a draft (accept or discard). */
export async function removeDraftAttachments(storageDir: string, proposalId: number): Promise<void> {
  await rm(draftAttachmentDir(storageDir, proposalId), { recursive: true, force: true });
}
