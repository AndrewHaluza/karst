import * as nodeFs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * The host-owned proposal index a planning session can read.
 *
 * A planning agent has no DB access: it files `<uuid>.json` into the session's
 * `outbox/`, the host ingests it, and the host writes `<scratch>/proposals.json`
 * listing what it knows — `{id, uuid, title, status, updatedAt}` per proposal.
 * `uuid` is the file that last produced the entry, so `karst draft propose` can
 * poll for the id the host assigned to the file it just wrote; `karst draft
 * list` reads the same file to show the session its drafts. Pure fs — no store,
 * no vscode — so the CLI and the host share one shape.
 *
 * The host also tells the agent what it found. An entry carries `warnings`
 * (absent when there are none) and `checking: true` while an async host check
 * (the commit probe) still runs. A file the host REJECTS gets
 * `<scratch>/outbox-rejections/<uuid>.json` with the reason, so `draft
 * propose` fails at once with that reason. The host writes these files and
 * never reads their contents back.
 *
 * It is a CONVENIENCE, not a trust boundary: the scratch dir is writable by a
 * shell-capable agent, so the id it reads back is only ever used to address the
 * agent's own drafts.
 */

export const PROPOSAL_INDEX_NAME = 'proposals.json';

/**
 * The index is read on the extension host's event loop, so its read is BOUNDED
 * like the outbox's: the scratch dir is agent-writable, and an unbounded
 * `readFileSync` + `JSON.parse` on a multi-GB file would block or OOM the host
 * (an OOM is not catchable). 1 MiB is far above any real session's index (a
 * few hundred bytes per proposal) yet small enough to parse without a hitch.
 */
export const MAX_PROPOSAL_INDEX_BYTES = 1 << 20;

export type ProposalIndexStatus = 'pending' | 'accepted' | 'discarded';

export interface ProposalIndexEntry {
  id: number;
  /** The outbox file's uuid that created or last revised this proposal. */
  uuid: string;
  title: string;
  status: ProposalIndexStatus;
  updatedAt: string;
  /** The host warnings on the draft; absent when it has none. */
  warnings?: string[];
  /** True while an async host check on this uuid still runs; absent otherwise. */
  checking?: boolean;
}

/** The index file for a session's scratch dir. */
export function proposalIndexPath(scratch: string): string {
  return join(scratch, PROPOSAL_INDEX_NAME);
}

const STATUSES: readonly string[] = ['pending', 'accepted', 'discarded'];

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((w) => typeof w === 'string');

function isEntry(v: unknown): v is ProposalIndexEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'number' &&
    Number.isInteger(e.id) &&
    typeof e.uuid === 'string' &&
    typeof e.title === 'string' &&
    typeof e.status === 'string' &&
    STATUSES.includes(e.status) &&
    typeof e.updatedAt === 'string' &&
    (e.warnings === undefined || isStringArray(e.warnings)) &&
    (e.checking === undefined || typeof e.checking === 'boolean')
  );
}

/**
 * Read at most `max` bytes, and only from a regular file: `O_NOFOLLOW` refuses a symlink and `O_NONBLOCK` refuses to hang on a
 * FIFO, so a hostile scratch entry degrades to "no index", never a blocked or
 * crashed host. Returns `undefined` when the file is absent, unreadable, not a
 * regular file, or over the cap.
 */
function readRegularFileBounded(path: string, max: number, fs: typeof nodeFs): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return undefined;
    const buf = Buffer.allocUnsafe(stat.size + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > max) return undefined;
    return buf.toString('utf8', 0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

/** The index, or `[]` when it is missing, unreadable, oversized or malformed. */
export function readProposalIndex(scratch: string, fs: typeof nodeFs = nodeFs): ProposalIndexEntry[] {
  const text = readRegularFileBounded(proposalIndexPath(scratch), MAX_PROPOSAL_INDEX_BYTES, fs);
  if (text === undefined) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(raw) ? raw.filter(isEntry) : [];
}

/** Replace the index atomically (tmp + rename) so a reader never sees a partial file. */
export function writeProposalIndex(
  scratch: string,
  entries: readonly ProposalIndexEntry[],
  fs: typeof nodeFs = nodeFs,
): void {
  fs.mkdirSync(scratch, { recursive: true });
  const tmp = join(scratch, `.${PROPOSAL_INDEX_NAME}.tmp-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(entries), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, proposalIndexPath(scratch));
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort — the rename is the atomic step
    }
    throw e;
  }
}

/** The dir under the session scratch that holds one file per rejected outbox file. */
export const OUTBOX_REJECTIONS_DIR = 'outbox-rejections';
/** The host keeps at most this many rejection files for each session (oldest pruned first). */
export const MAX_OUTBOX_REJECTIONS = 20;
/** The CLI reads a rejection file only up to this size. */
export const MAX_OUTBOX_REJECTION_BYTES = 1 << 16;
/** The host stores at most this many characters of a rejection reason. */
export const MAX_REJECTION_REASON_CHARS = 2000;
/** An outbox file uuid: the same alphabet the host scan accepts. No path separator can pass. */
export const PROPOSAL_UUID = /^[0-9a-f-]{36}$/;
const REJECTION_NAME = /^[0-9a-f-]{36}\.json$/;

export interface OutboxRejectionEntry {
  uuid: string;
  reason: string;
  rejectedAt: string;
}

export function outboxRejectionsDir(scratch: string): string {
  return join(scratch, OUTBOX_REJECTIONS_DIR);
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

function isRejection(v: unknown, uuid: string): v is OutboxRejectionEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.uuid === uuid && typeof e.reason === 'string' && typeof e.rejectedAt === 'string';
}

/**
 * The host's rejection of the outbox file `uuid`, or `undefined` when there is
 * none, or when the file is not a bounded regular file of the right shape.
 */
export function readOutboxRejection(
  scratch: string,
  uuid: string,
  fs: typeof nodeFs = nodeFs,
): OutboxRejectionEntry | undefined {
  if (!PROPOSAL_UUID.test(uuid)) return undefined;
  const text = readRegularFileBounded(join(outboxRejectionsDir(scratch), `${uuid}.json`), MAX_OUTBOX_REJECTION_BYTES, fs);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRejection(raw, uuid) ? raw : undefined;
}

/**
 * Create the rejections dir when it is missing, and return it only when it is
 * a real directory at its own realpath. The scratch dir is agent-writable: a
 * symlinked dir would let the host write or prune files outside the scratch.
 */
function verifiedRejectionsDir(scratch: string, fs: typeof nodeFs): string {
  const dir = outboxRejectionsDir(scratch);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
  if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== join(fs.realpathSync(scratch), OUTBOX_REJECTIONS_DIR)) {
    throw new Error(`${OUTBOX_REJECTIONS_DIR} is not a plain directory`);
  }
  return dir;
}

/**
 * Delete the oldest rejection files past the cap. Metadata only (readdir +
 * lstat): the host never reads an agent-writable file back. Only regular files
 * with a `<uuid>.json` name are counted or deleted. A prune failure is
 * ignored on purpose: the rejection itself is already written.
 */
function pruneOutboxRejections(dir: string, keep: string, fs: typeof nodeFs): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const files = names
    .filter((name) => REJECTION_NAME.test(name) && name !== keep)
    .flatMap((name) => {
      try {
        const st = fs.lstatSync(join(dir, name));
        return st.isFile() ? [{ name, mtimeMs: st.mtimeMs }] : [];
      } catch {
        return [];
      }
    });
  const excess = files.length + 1 - MAX_OUTBOX_REJECTIONS;
  if (excess <= 0) return;
  const oldest = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name)).slice(0, excess);
  for (const f of oldest) {
    try {
      fs.unlinkSync(join(dir, f.name));
    } catch {
      // best effort — the next write prunes again
    }
  }
}

/**
 * Write one rejection atomically (tmp `wx` 0600, then rename) and prune the
 * oldest files past `MAX_OUTBOX_REJECTIONS`. One file for each uuid, so two
 * windows never read-modify-write a shared file. Throws on a failed write.
 */
export function writeOutboxRejection(
  scratch: string,
  entry: OutboxRejectionEntry,
  fs: typeof nodeFs = nodeFs,
): void {
  if (!PROPOSAL_UUID.test(entry.uuid)) throw new Error(`invalid proposal uuid ${JSON.stringify(entry.uuid)}`);
  const dir = verifiedRejectionsDir(scratch, fs);
  const body: OutboxRejectionEntry = {
    uuid: entry.uuid,
    reason: entry.reason.slice(0, MAX_REJECTION_REASON_CHARS),
    rejectedAt: entry.rejectedAt,
  };
  const name = `${entry.uuid}.json`;
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, join(dir, name));
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort — the rename is the atomic step
    }
    throw e;
  }
  pruneOutboxRejections(dir, name, fs);
}

export interface WaitForProposalIdOpts {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
  fs?: typeof nodeFs;
}

export const PROPOSAL_ID_TIMEOUT_MS = 10_000;
const PROPOSAL_ID_POLL_MS = 100;

function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type WaitForProposalResultOpts = WaitForProposalIdOpts;

export type ProposalResult =
  | { kind: 'ingested'; id: number; warnings: string[]; checksPending?: true }
  | { kind: 'rejected'; reason: string }
  | { kind: 'timeout' };

/**
 * Poll (bounded) for the host's answer to the outbox file `uuid`. A rejection
 * file returns `rejected` at once. An index entry returns `ingested` once it
 * is no longer `checking`. At the deadline an entry that is still checking
 * returns `ingested` with `checksPending: true`; no entry returns `timeout`.
 * Synchronous by design: the CLI's `runCli` is synchronous and this is the
 * one bounded wait it makes.
 */
export function waitForProposalResult(
  scratch: string,
  uuid: string,
  opts: WaitForProposalResultOpts = {},
): ProposalResult {
  const timeoutMs = opts.timeoutMs ?? PROPOSAL_ID_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? PROPOSAL_ID_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  for (;;) {
    const rejected = readOutboxRejection(scratch, uuid, opts.fs);
    if (rejected) return { kind: 'rejected', reason: rejected.reason };
    const found = readProposalIndex(scratch, opts.fs).find((e) => e.uuid === uuid);
    if (found && found.checking !== true) return { kind: 'ingested', id: found.id, warnings: found.warnings ?? [] };
    const remaining = deadline - now();
    if (remaining <= 0) {
      return found
        ? { kind: 'ingested', id: found.id, warnings: found.warnings ?? [], checksPending: true }
        : { kind: 'timeout' };
    }
    sleep(Math.min(intervalMs, remaining));
  }
}

/** The host-assigned id of the outbox file `uuid`, or `undefined` on a rejection or a timeout. */
export function waitForProposalId(
  scratch: string,
  uuid: string,
  opts: WaitForProposalIdOpts = {},
): number | undefined {
  const result = waitForProposalResult(scratch, uuid, opts);
  return result.kind === 'ingested' ? result.id : undefined;
}
