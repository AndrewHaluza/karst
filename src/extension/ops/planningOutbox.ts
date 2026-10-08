import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import {
  countPending,
  getProposal,
  insertProposal,
  updateProposalPayload,
  validateProposalDependsOn,
  type PlanningProposal,
} from '../../store/planningProposals.js';
import { MAX_PROPOSAL_BYTES, validateProposal, type Proposal } from '../../planning/proposal.js';
import { planningOutboxDir } from '../../planning/preamble.js';
import { refreshProposalIndex } from './planningIndex.js';
import type { Notify } from './notify.js';

/**
 * Host ingestion of planning proposals (vscode-free). A planning agent has no
 * DB access: `karst draft propose` drops `<uuid>.json` into the session's
 * scratch `outbox/`, and this scan claims, bounds, validates and inserts each
 * one as a PENDING proposal — the user decides later. The scan is synchronous;
 * the watcher/poll that triggers it is the binding's job. Nothing outside the
 * outbox dir is ever moved, read or unlinked.
 */

export const PLANNING_OUTBOX_RATE_CAP = 20;
export const PLANNING_CLAIM_STALE_MS = 5 * 60_000;

const PROPOSAL_NAME = /^[0-9a-f-]{36}\.json$/;
const CLAIM_NAME = /^\.claim-.+-([0-9a-f-]{36}\.json)$/;

export interface PlanningOutboxDeps {
  store: Store;
  projectId(): number | undefined;
  /** Non-archived sessions of this window's project — the ONLY dirs scanned. */
  sessions(): { id: number; scratch: string }[];
  /** Repository names in the live manifest; undefined = unknown (non-empty repos rejected). */
  knownRepos(): string[] | undefined;
  windowId: string;
  now(): number;
  fs?: typeof nodeFs;
  notify: Notify;
  debug?: (line: string) => void;
  /** A new draft (`change` undefined) or an in-place revision (`'updated'`). */
  onProposal(p: PlanningProposal, change?: 'updated'): void;
}

export interface PlanningOutbox {
  scan(): void;
}

type Read = { ok: true; value: Proposal } | { ok: false; reason: string };

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

export function createPlanningOutbox(deps: PlanningOutboxDeps): PlanningOutbox {
  const fs = deps.fs ?? nodeFs;
  const debug = (line: string): void => deps.debug?.(`[planning] ${line}`);

  /** The outbox path, only when it is a real dir at exactly the expected place. */
  function verifiedDir(sessionId: number, scratch: string): string | undefined {
    let expected: string;
    try {
      expected = planningOutboxDir(fs.realpathSync(scratch));
      if (!fs.lstatSync(expected).isDirectory() || fs.realpathSync(expected) !== expected) {
        throw Object.assign(new Error('not a real directory'), { code: 'EBADDIR' });
      }
    } catch (e) {
      if (errCode(e) === 'ENOENT') return undefined;
      deps.notify.warn(`Karst: planning session #${sessionId} outbox is not a plain directory; skipped.`);
      debug(`session ${sessionId}: outbox rejected (${errCode(e) ?? String(e)})`);
      return undefined;
    }
    return expected;
  }

  /** Atomically take `name` for this window; undefined when someone else has it. */
  function claim(dir: string, name: string, proposal: string): string | undefined {
    const claimed = join(dir, `.claim-${deps.windowId}-${proposal}`);
    try {
      fs.renameSync(join(dir, name), claimed);
    } catch (e) {
      debug(`claim ${name}: lost (${errCode(e) ?? 'error'})`);
      return undefined;
    }
    const t = deps.now() / 1000;
    try {
      fs.lutimesSync(claimed, t, t);
    } catch (e) {
      debug(`claim ${name}: touch failed (${errCode(e) ?? 'error'})`);
    }
    return claimed;
  }

  function readBounded(path: string): Read {
    let fd: number;
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (e) {
      return { ok: false, reason: `cannot open (${errCode(e) ?? 'error'}; symlinks are refused)` };
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
      if (st.size > MAX_PROPOSAL_BYTES) return { ok: false, reason: `too large (over ${MAX_PROPOSAL_BYTES} bytes)` };
      const buf = Buffer.alloc(MAX_PROPOSAL_BYTES + 1);
      let len = 0;
      for (let n = -1; n !== 0 && len < buf.length; len += n) n = fs.readSync(fd, buf, len, buf.length - len, null);
      if (len > MAX_PROPOSAL_BYTES) return { ok: false, reason: `too large (over ${MAX_PROPOSAL_BYTES} bytes)` };
      return parse(buf.subarray(0, len));
    } finally {
      fs.closeSync(fd);
    }
  }

  function parse(bytes: Uint8Array): Read {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (e) {
      return { ok: false, reason: e instanceof TypeError ? 'not valid UTF-8' : 'not valid JSON' };
    }
    const v = validateProposal(raw);
    if (!v.ok) return v;
    const known = deps.knownRepos();
    const unknown = v.value.repos.filter((r) => !known?.includes(r));
    if (unknown.length > 0) {
      return { ok: false, reason: known ? `unknown repositories ${unknown.join(', ')}` : 'repositories cannot be checked (no manifest)' };
    }
    return v;
  }

  /** Unlink and warn about a claimed file the host refused, naming the reason. */
  function reject(sessionId: number, claimed: string, proposal: string, reason: string): void {
    remove(claimed);
    debug(`session ${sessionId}: ${proposal} rejected (${reason})`);
    deps.notify.warn(`Karst: planning session #${sessionId} proposal rejected — ${reason}.`);
  }

  /**
   * Refresh the session index, swallowing a failure: the store write already
   * committed, and the index is a convenience. Throwing here would skip the
   * claim removal and the announcement, leaving the file to be re-claimed and
   * the proposal inserted a second time.
   */
  function safeRefresh(sessionId: number, scratch: string): void {
    try {
      refreshProposalIndex(deps.store, sessionId, scratch, { fs });
    } catch (e) {
      debug(`session ${sessionId}: proposal index refresh failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  function ingest(sessionId: number, scratch: string, claimed: string, proposal: string): void {
    const read = readBounded(claimed);
    if (!read.ok) {
      reject(sessionId, claimed, proposal, read.reason);
      return;
    }
    const { id: requestedId, ...payload } = read.value;
    const uuid = proposal.replace(/\.json$/, '');

    // Dependencies name host proposal ids of THIS session: an unknown id, a
    // discarded one, a foreign session's, or an edge that would close a cycle
    // is refused before anything is written.
    const depReason = validateProposalDependsOn(
      deps.store,
      sessionId,
      requestedId,
      read.value.dependsOn ?? [],
    );
    if (depReason) {
      reject(sessionId, claimed, proposal, depReason);
      return;
    }

    // In-place revision: only a pending proposal of THIS session may be
    // replaced. A miss (unknown id, another session, or already resolved) is
    // refused and writes nothing — the agent is told to re-read `draft list`.
    if (requestedId !== undefined) {
      const existing = getProposal(deps.store, requestedId);
      const reason =
        !existing
          ? `no proposal #${requestedId}`
          : existing.sessionId !== sessionId
            ? `proposal #${requestedId} belongs to another session`
            : existing.status !== 'pending'
              ? `proposal #${requestedId} is ${existing.status}`
              : undefined;
      if (reason) {
        reject(sessionId, claimed, proposal, reason);
        return;
      }
      updateProposalPayload(deps.store, requestedId, payload, uuid);
      safeRefresh(sessionId, scratch);
      remove(claimed);
      const row = getProposal(deps.store, requestedId);
      if (row) deps.onProposal(row, 'updated');
      debug(`session ${sessionId}: ${proposal} → proposal ${requestedId} updated`);
      return;
    }

    // A new draft: the per-session pending cap applies only here — an update
    // replaces an existing row and never grows the pending count.
    if (countPending(deps.store, sessionId) >= PLANNING_OUTBOX_RATE_CAP) {
      reject(
        sessionId,
        claimed,
        proposal,
        `session already has ${PLANNING_OUTBOX_RATE_CAP} pending proposals`,
      );
      return;
    }
    const id = insertProposal(deps.store, sessionId, payload, uuid);
    safeRefresh(sessionId, scratch);
    remove(claimed);
    const row = getProposal(deps.store, id);
    if (row) deps.onProposal(row);
    debug(`session ${sessionId}: ${proposal} → proposal ${id}`);
  }

  function remove(path: string): void {
    try {
      fs.unlinkSync(path);
    } catch (e) {
      debug(`unlink ${path}: ${errCode(e) ?? 'error'}`);
    }
  }

  function isStale(path: string): boolean {
    try {
      return deps.now() - fs.lstatSync(path).mtimeMs > PLANNING_CLAIM_STALE_MS;
    } catch {
      return false;
    }
  }

  function scanSession(sessionId: number, scratch: string): void {
    const dir = verifiedDir(sessionId, scratch);
    if (!dir) return;
    for (const name of fs.readdirSync(dir)) {
      const proposal = PROPOSAL_NAME.test(name) ? name : CLAIM_NAME.exec(name)?.[1];
      if (!proposal) continue;
      if (proposal !== name && !isStale(join(dir, name))) continue;
      const claimed = claim(dir, name, proposal);
      if (claimed) ingest(sessionId, scratch, claimed, proposal);
    }
  }

  return {
    scan(): void {
      if (deps.projectId() === undefined) return;
      for (const s of deps.sessions()) {
        try {
          scanSession(s.id, s.scratch);
        } catch (e) {
          debug(`session ${s.id}: scan failed (${errCode(e) ?? String(e)})`);
        }
      }
    },
  };
}
