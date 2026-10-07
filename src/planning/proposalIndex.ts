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
}

/** The index file for a session's scratch dir. */
export function proposalIndexPath(scratch: string): string {
  return join(scratch, PROPOSAL_INDEX_NAME);
}

const STATUSES: readonly string[] = ['pending', 'accepted', 'discarded'];

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
    typeof e.updatedAt === 'string'
  );
}

/**
 * Read the index at most `MAX_PROPOSAL_INDEX_BYTES` and only from a regular
 * file: `O_NOFOLLOW` refuses a symlink and `O_NONBLOCK` refuses to hang on a
 * FIFO, so a hostile scratch entry degrades to "no index", never a blocked or
 * crashed host. Returns `undefined` when the file is absent, unreadable, not a
 * regular file, or over the cap.
 */
function readIndexBounded(path: string, fs: typeof nodeFs): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PROPOSAL_INDEX_BYTES) return undefined;
    const buf = Buffer.allocUnsafe(stat.size + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_PROPOSAL_INDEX_BYTES) return undefined;
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
  const text = readIndexBounded(proposalIndexPath(scratch), fs);
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

/**
 * Poll the index (bounded) for the entry whose `uuid` matches, returning its
 * proposal id or `undefined` on timeout. Synchronous by design: the CLI's
 * `runCli` is synchronous and this is the one bounded wait it makes.
 */
export function waitForProposalId(
  scratch: string,
  uuid: string,
  opts: WaitForProposalIdOpts = {},
): number | undefined {
  const timeoutMs = opts.timeoutMs ?? PROPOSAL_ID_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? PROPOSAL_ID_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  for (;;) {
    const found = readProposalIndex(scratch, opts.fs).find((e) => e.uuid === uuid);
    if (found) return found.id;
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    sleep(Math.min(intervalMs, remaining));
  }
}
