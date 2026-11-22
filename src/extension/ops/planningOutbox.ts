import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import {
  countPending,
  getProposal,
  insertProposal,
  setProposalBaseShas,
  setProposalWarnings,
  updateProposalPayload,
  validateProposalDependsOn,
  type PlanningProposal,
} from '../../store/planningProposals.js';
import { MAX_PROPOSAL_BYTES, validateProposal, type Proposal } from '../../planning/proposal.js';
import { updateTicketFields } from '../../store/tickets.js';
import { planningArtifactsDir, planningOutboxDir } from '../../planning/preamble.js';
import { draftQualityWarnings, extractReferencedPaths } from '../../planning/draftQualityChecks.js';
import {
  archWarnings,
  commitWarnings,
  missingPathWarnings,
  overlapWarnings,
  sensitivePathWarning,
  type CommitExists,
  type GitBatch,
  type PathRepoTarget,
} from './planningConstraintChecks.js';
import { listOverlapCandidates } from '../../store/draftOverlap.js';
import { formatId } from '../../model/entityId.js';
import { recordOutboxRejection, refreshProposalIndex } from './planningIndex.js';
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
const JSON_SUFFIX_LENGTH = '.json'.length;

/** The uuid of a validated `<uuid>.json` outbox name. */
const uuidOf = (proposal: string): string => proposal.slice(0, -JSON_SUFFIX_LENGTH);

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
  /** Repo names → their distinct repoPaths, for the constraint checks; absent = path checks skipped. */
  repoPaths?(names: string[]): string[];
  /** Repo names → base commit shas (planned base, host-side); absent = no shas recorded. */
  resolveBaseShas?(repos: readonly string[]): Promise<Record<string, string>>;
  /** Async `git cat-file` probe for commit constraints; absent = commit check skipped. */
  commitExists?: CommitExists;
  /** Repo names → distinct (repoPath, base branch) targets for the path probe; absent = path check skipped. */
  pathTargets?(names: string[]): PathRepoTarget[];
  /** Async `git cat-file --batch-check`, one per target; absent = path check skipped. */
  gitBatch?: GitBatch;
  /** A late (async) check added warnings or base shas to a stored proposal. */
  onWarnings?(p: PlanningProposal): void;
}

export interface PlanningOutbox {
  scan(): void;
  /**
   * The proposal ids whose async host checks still run. Every index refresh
   * (also an accept or a discard of a sibling draft) must pass this set, or
   * it strips `checking: true` and `draft propose` returns too early.
   */
  checkingIds(): ReadonlySet<number>;
}

type Read = { ok: true; value: Proposal } | { ok: false; reason: string };

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createPlanningOutbox(deps: PlanningOutboxDeps): PlanningOutbox {
  const fs = deps.fs ?? nodeFs;
  const debug = (line: string): void => deps.debug?.(`[planning] ${line}`);
  /**
   * In-flight async checks: proposal id → the outbox uuid they check. Only the
   * check of the CURRENT uuid may clear the latch, so a late answer for a
   * revised draft does not clear the latch of the newer check.
   */
  const checking = new Map<number, string>();
  const checkingIds = (): ReadonlySet<number> => new Set(checking.keys());

  /**
   * Base shas need git, so they land on the stored row once the async resolve
   * answers — the same late pattern the commit probe uses. The draft is ingested
   * at once with no shas; a failure or an empty resolve keeps what is already
   * recorded (an earlier value on a revise, `{}` on a new draft) and only logs.
   * Never throws and never blocks `scan()`.
   *
   * A human can ACCEPT the draft before the resolve answers, in which case
   * `markProposalAccepted` has already copied the (then-empty) shas onto the
   * ticket; the resolved shas then patch the TICKET, so accepting early does
   * not leave it with none.
   */
  function resolveBaseShasLate(id: number, uuid: string, p: Proposal): void {
    if (!deps.resolveBaseShas) return;
    void Promise.resolve()
      .then(() => deps.resolveBaseShas!(p.repos))
      .then((shas) => {
        if (Object.keys(shas).length === 0) return; // nothing found: keep what is recorded
        const cur = getProposal(deps.store, id);
        // A revise or a resolution since ingest owns the row now.
        if (!cur || cur.sourceUuid !== uuid) return;
        if (cur.status === 'pending') {
          setProposalBaseShas(deps.store, id, shas);
          const row = getProposal(deps.store, id);
          if (row) deps.onWarnings?.(row);
          return;
        }
        if (cur.status === 'accepted' && cur.ticketId !== null) {
          updateTicketFields(deps.store, cur.ticketId, { baseShas: shas });
        }
      })
      .catch((e: unknown) => debug(`base sha resolution failed: ${e instanceof Error ? e.message : String(e)}`));
  }

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
      deps.notify.warn(`The outbox of planning session ${formatId('plan', sessionId)} is not a plain directory, so Karst skipped it.`);
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

  /** Unlink and warn about a claimed file the host refused, naming the reason; tell the CLI why. */
  function reject(sessionId: number, scratch: string, claimed: string, proposal: string, reason: string): void {
    remove(claimed);
    safeRecordRejection(sessionId, scratch, uuidOf(proposal), reason);
    debug(`session ${sessionId}: ${proposal} rejected (${reason})`);
    deps.notify.warn(`A draft of planning session ${formatId('plan', sessionId)} was rejected (${reason}).`);
  }

  /**
   * Write the rejection file `draft propose` polls, swallowing a failure: the
   * rejection itself stands, and the CLI then falls back to its timeout.
   */
  function safeRecordRejection(sessionId: number, scratch: string, uuid: string, reason: string): void {
    try {
      recordOutboxRejection(scratch, uuid, reason, deps.now(), { fs });
    } catch (e) {
      debug(`session ${sessionId}: rejection record for ${uuid} failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /**
   * Refresh the session index, swallowing a failure: the store write already
   * committed, and the index is a convenience. Throwing here would skip the
   * claim removal and the announcement, leaving the file to be re-claimed and
   * the proposal inserted a second time.
   */
  function safeRefresh(sessionId: number, scratch: string): void {
    try {
      refreshProposalIndex(deps.store, sessionId, scratch, { fs, checkingIds: checkingIds() });
    } catch (e) {
      debug(`session ${sessionId}: proposal index refresh failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /** True when the session's artifacts dir holds a Markdown file. Reads names only, never content. */
  function hasPlanArtifact(scratch: string): boolean {
    try {
      return fs.readdirSync(planningArtifactsDir(scratch)).some((n) => n.endsWith('.md'));
    } catch (e) {
      if (errCode(e) !== 'ENOENT') debug(`artifacts dir unreadable (${errCode(e) ?? 'error'})`);
      return false;
    }
  }

  /** Overlap with open drafts and tickets; a store failure skips the check with a debug line. */
  function overlapOf(p: Proposal, id: number | undefined): string[] {
    const projectId = deps.projectId();
    if (projectId === undefined) return [];
    try {
      return overlapWarnings(p, listOverlapCandidates(deps.store, projectId, id, p.dependsOn ?? []));
    } catch (e) {
      debug(`overlap check for ${id === undefined ? 'a new draft' : formatId('draft', id)} skipped (${messageOf(e)})`);
      return [];
    }
  }

  /**
   * Warnings computable without spawning anything: design keys, sensitive code
   * with no rule, draft quality (`@arch:DRAFT-QUALITY`) and overlap. `id` is the
   * revised draft, undefined for a new one.
   */
  function quickWarnings(p: Proposal, scratch: string, id: number | undefined): string[] {
    const paths = deps.repoPaths?.(p.repos) ?? [];
    return [
      ...archWarnings(p.constraints ?? [], paths, debug),
      ...sensitivePathWarning(p),
      ...draftQualityWarnings(p, { hasPlanArtifact: hasPlanArtifact(scratch) }),
      ...overlapOf(p, id),
    ];
  }

  /** The commit probe runs when a probe and repo paths exist. */
  function commitProbeRuns(p: Proposal): boolean {
    return deps.commitExists !== undefined && (deps.repoPaths?.(p.repos) ?? []).length > 0;
  }

  /** The path probe input, or undefined when it does not run (no batch, no target, or no edited path). */
  function pathProbe(p: Proposal): { paths: string[]; targets: PathRepoTarget[] } | undefined {
    if (!deps.gitBatch) return undefined;
    const targets = deps.pathTargets?.(p.repos) ?? [];
    const paths = extractReferencedPaths(p.description).existing;
    return targets.length > 0 && paths.length > 0 ? { paths, targets } : undefined;
  }

  /** True when an async check (commit or path probe) will run for this draft. */
  function willVerify(p: Proposal): boolean {
    return commitProbeRuns(p) || pathProbe(p) !== undefined;
  }

  /**
   * The git-backed warnings (unknown commits, paths missing at base) land on
   * the stored row once BOTH probes settle, in one write. The `finally` ALWAYS
   * clears this uuid's latch and refreshes the index (also with no extra
   * warning, and on an error), so `checking: true` never sticks.
   */
  function verifyAsync(sessionId: number, scratch: string, id: number, uuid: string, p: Proposal): void {
    if (!willVerify(p)) return;
    const probe = pathProbe(p);
    const commits = commitProbeRuns(p)
      ? commitWarnings(p.constraints ?? [], deps.repoPaths!(p.repos), deps.commitExists!, debug)
      : Promise.resolve<string[]>([]);
    const missing = probe ? missingPathWarnings(probe.paths, probe.targets, deps.gitBatch!, debug) : Promise.resolve<string[]>([]);
    void Promise.allSettled([commits, missing])
      .then((settled) => {
        const extra = settled.flatMap((s) => {
          if (s.status === 'fulfilled') return s.value;
          debug(`async check for proposal ${id} failed (${messageOf(s.reason)})`);
          return [];
        });
        if (extra.length === 0) return;
        const cur = getProposal(deps.store, id);
        // A revise or resolution since ingest owns the warnings now.
        if (!cur || cur.status !== 'pending' || cur.sourceUuid !== uuid) return;
        setProposalWarnings(deps.store, id, [...cur.warnings, ...extra]);
        const row = getProposal(deps.store, id);
        if (row) deps.onWarnings?.(row);
      })
      .catch((e: unknown) => debug(`async checks for proposal ${id} failed (${messageOf(e)})`))
      .finally(() => {
        if (checking.get(id) !== uuid) return;
        checking.delete(id);
        safeRefresh(sessionId, scratch);
      });
  }

  function ingest(sessionId: number, scratch: string, claimed: string, proposal: string): void {
    const read = readBounded(claimed);
    if (!read.ok) {
      reject(sessionId, scratch, claimed, proposal, read.reason);
      return;
    }
    const { id: requestedId, ...payload } = read.value;
    const uuid = uuidOf(proposal);

    // Dependencies name drafts of ANY session of this project or its open
    // tickets (`T<n>`): an unknown id, a discarded draft, another project's id,
    // a closed ticket, or an edge that would close a cycle is refused before
    // anything is written.
    const depReason = validateProposalDependsOn(
      deps.store,
      sessionId,
      requestedId,
      read.value.dependsOn ?? [],
    );
    if (depReason) {
      reject(sessionId, scratch, claimed, proposal, depReason);
      return;
    }

    // In-place revision: only a pending proposal of THIS session may be
    // replaced. A miss (unknown id, another session, or already resolved) is
    // refused and writes nothing — the agent is told to re-read `draft list`.
    if (requestedId !== undefined) {
      const existing = getProposal(deps.store, requestedId);
      const reason =
        !existing
          ? `no draft ${formatId('draft', requestedId)}`
          : existing.sessionId !== sessionId
            ? `draft ${formatId('draft', requestedId)} belongs to another session`
            : existing.status !== 'pending'
              ? `draft ${formatId('draft', requestedId)} is ${existing.status}`
              : undefined;
      if (reason) {
        reject(sessionId, scratch, claimed, proposal, reason);
        return;
      }
      updateProposalPayload(deps.store, requestedId, payload, uuid, quickWarnings(read.value, scratch, requestedId));
      // A revise owns the latch: drop the old uuid's latch first, then set it
      // again only when this revision runs its own async check.
      checking.delete(requestedId);
      if (willVerify(read.value)) checking.set(requestedId, uuid);
      safeRefresh(sessionId, scratch);
      remove(claimed);
      const row = getProposal(deps.store, requestedId);
      if (row) deps.onProposal(row, 'updated');
      resolveBaseShasLate(requestedId, uuid, read.value);
      verifyAsync(sessionId, scratch, requestedId, uuid, read.value);
      debug(`session ${sessionId}: ${proposal} → proposal ${requestedId} updated`);
      return;
    }

    // A new draft: the per-session pending cap applies only here — an update
    // replaces an existing row and never grows the pending count.
    if (countPending(deps.store, sessionId) >= PLANNING_OUTBOX_RATE_CAP) {
      reject(
        sessionId,
        scratch,
        claimed,
        proposal,
        `session already has ${PLANNING_OUTBOX_RATE_CAP} pending proposals`,
      );
      return;
    }
    const id = insertProposal(deps.store, sessionId, payload, uuid, quickWarnings(read.value, scratch, undefined));
    // Set the latch BEFORE the first index write, so `draft propose` never
    // sees this entry without `checking` while the probe still runs.
    if (willVerify(read.value)) checking.set(id, uuid);
    safeRefresh(sessionId, scratch);
    remove(claimed);
    const row = getProposal(deps.store, id);
    if (row) deps.onProposal(row);
    resolveBaseShasLate(id, uuid, read.value);
    verifyAsync(sessionId, scratch, id, uuid, read.value);
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
    checkingIds,
  };
}
