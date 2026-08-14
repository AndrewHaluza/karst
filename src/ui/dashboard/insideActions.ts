import type { Store } from '../../store/db.js';
import { getProcessRunById } from '../../store/processRuns.js';
import { getPrById } from '../../store/prs.js';
import { getFindingById } from '../../store/reviewFindings.js';
import { getShipCommitById } from '../../store/shipRuns.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { getUatFindingById } from '../../store/uatFindings.js';
import { getTicket } from '../../store/tickets.js';
import { canonicalPath, isPathUnder } from '../../runtime/pathScope.js';
import type { StageKey } from '../../model/types.js';
import type {
  EvidenceRow,
  InsideEvidenceTarget,
  TypedInsideAction,
} from '../../model/inside/types.js';

export type { InsideEvidenceTarget };

/**
 * The typed-action seam (Task 13): the host half of the inside actions the
 * process views offer.
 *
 * A process row's `action` carries ONLY an opaque, snapshot-scoped action id.
 * The webview posts that id back; `dispatchInsideAction` resolves it through
 * the registry for the CURRENT snapshot and dispatches the STORED host-only
 * target — a client-supplied kind, repo, path, PR number, SHA, stage or
 * process id can never affect what runs, because none of them is accepted from
 * the message.
 *
 * Host-only targets identify RECORDED objects (a finding's row id, a PR's
 * rowid, a ship commit's id, a stage run, a process run). Every dispatch
 * re-loads the row by that id and proves it belongs to the registry's ticket
 * before doing anything. File opens additionally prove the resolved path is a
 * canonical descendant of the repo's registered worktree — symlinks resolved,
 * missing leaves appended onto the deepest existing ancestor — before the host
 * is handed a path to open.
 */

/** The host-owned capability a process row may carry. */
export type InsideActionTarget =
  | {
      kind: 'open-file';
      ticketId: number;
      evidence: { source: 'review-finding' | 'uat-finding'; id: number };
    }
  | { kind: 'open-pr'; ticketId: number; prId: number }
  | { kind: 'open-commit'; ticketId: number; shipCommitId: number }
  | { kind: 'open-stage-log'; ticketId: number; stageKey: StageKey }
  | { kind: 'resume-stage'; ticketId: number; stageKey: StageKey }
  | { kind: 'open-full-evidence'; ticketId: number; processRunId: number }
  | {
      kind: 'open-bounded-evidence';
      ticketId: number;
      title: string;
      rows: readonly EvidenceRow[];
    }
  // Graph controls (Slice 3 Task 11). `session.runId` is a RECORDED
  // planner-run / node-run row id — the dispatch re-loads it and proves it
  // belongs to the registry's ticket before the host focuses anything. Stop
  // is offered only while a live graph run exists for the ticket.
  | {
      kind: 'graph-open-session';
      ticketId: number;
      session: { kind: 'planner' | 'node'; runId: number };
    }
  | { kind: 'graph-stop'; ticketId: number }
  | { kind: 'graph-confirm'; ticketId: number; graphRunId: number }
  // Slice 4 Task 4: discard an ambiguous node run (`launch-unknown` /
  // `termination-unknown`). The nodeRunId is a RECORDED node-run row id — the
  // dispatch re-loads it and proves it belongs to the registry's ticket; the
  // discard module's own transaction is the status gate.
  | { kind: 'graph-discard-node'; ticketId: number; nodeRunId: number }
  // Slice 6 Task 4: edit an editable agent node's per-node overrides before
  // claiming. The nodeRunId is a RECORDED node-run row id; the dispatch proves
  // it belongs to this ticket. The override WRITE's own claim gate (the
  // node-run status CAS in `store/graph/nodeRuns.ts`) is the real authority —
  // this dispatch only opens the editor surface, so a stale control can never
  // mutate a launch that claiming already froze.
  | { kind: 'graph-edit-override'; ticketId: number; nodeRunId: number };

/** Longest accepted action id. Ids are `snapshot-<n>:action-<n>`; this is slack. */
export const MAX_ACTION_ID_CHARS = 96;

const ACTION_ID_PATTERN = /^snapshot-(\d+):action-(\d+)$/;

/**
 * The snapshot-scoped allowlist. Built fresh for every authoritative dashboard
 * snapshot and REPLACED atomically with it; disposed with the panel. An id
 * resolves only against the CURRENT generation for the SAME ticket — an id
 * from a superseded snapshot or a different ticket is unknown, never dispatched.
 */
export class InsideActionRegistry {
  private readonly targets = new Map<string, InsideActionTarget>();
  private next = 0;

  constructor(
    private readonly generation: number,
    private readonly ticketId: number,
  ) {}

  /** Mint an id for a target and remember it. The view receives only the id + kind. */
  register(target: InsideActionTarget): TypedInsideAction {
    const actionId = `snapshot-${this.generation}:action-${this.next}`;
    this.next += 1;
    this.targets.set(actionId, target);
    return { actionId, kind: target.kind };
  }

  /** Resolve an opaque id to its target, or null for unknown/stale/foreign ids. */
  resolve(actionId: string): InsideActionTarget | null {
    const match = ACTION_ID_PATTERN.exec(actionId);
    if (!match) return null;
    if (Number(match[1]) !== this.generation) return null;
    const target = this.targets.get(actionId);
    if (target === undefined) return null;
    if (target.ticketId !== this.ticketId) return null;
    return target;
  }

  /** Drop every capability — panel disposal must never leave stale ids live. */
  dispose(): void {
    this.targets.clear();
  }
}

/** The injected filesystem surface — realpath is what resolves existing symlinks. */
export interface InsideFileFs {
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
}

export interface InsideActionHost {
  openFile(path: string): void | Promise<void>;
  openPr(ticketId: number, prId: number): void | Promise<void>;
  openCommit(ticketId: number, shipCommitId: number): void | Promise<void>;
  resumeStage(ticketId: number, stageKey: StageKey): void | Promise<void>;
  openFullEvidence(ticketId: number, processRunId: number): void | Promise<void>;
  openBoundedEvidence(
    ticketId: number,
    title: string,
    rows: readonly EvidenceRow[],
  ): void | Promise<void>;
  /**
   * Focus the terminal of a LIVE planner/node session. Never spawns: the
   * dispatch has already proven the run row exists and belongs to the ticket.
   */
  graphOpenSession(
    ticketId: number,
    session: { kind: 'planner' | 'node'; runId: number },
  ): void | Promise<void>;
  /** Signal the coordinator to drain the ticket's live graph run. */
  graphStop(ticketId: number): void | Promise<void>;
  /** Confirm a compiled graph plan that is durably awaiting the user. */
  graphConfirm(ticketId: number, graphRunId: number): void | Promise<void>;
  /**
   * Discard an ambiguous node run (launch-unknown/termination-unknown) — the
   * ONE explicit exit for an unprovable process. The dispatch has already
   * proven the run row belongs to the ticket; the discard module's own
   * transaction is the status gate, so a second window's discard is a no-op.
   */
  graphDiscardNode(ticketId: number, nodeRunId: number): void | Promise<void>;
  /**
   * Open the override editor for an editable agent node (ready / blocked /
   * failed-to-launch) BEFORE claiming. The dispatch has already proven the run
   * row belongs to the ticket; the store's claim gate is the write's
   * authority, so this host callback never mutates anything itself.
   */
  graphEditOverride(ticketId: number, nodeRunId: number): void | Promise<void>;
}

export type InsideDispatchOutcome =
  | { outcome: 'dispatched' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' };

/**
 * The graph-run statuses Stop may signal on — the coordinator is live and a
 * drain is meaningful. Mirrors the pure projection's own stoppable set; a
 * closed/blocked/stale run is never stopped by this id.
 */
const GRAPH_STOPPABLE_STATUSES: readonly string[] = [
  'planning',
  'awaiting-confirmation',
  'running',
] as const;

/** Prove a planner/node run row belongs to the registry's ticket. */
function graphSessionOwner(
  store: Store,
  kind: 'planner' | 'node',
  runId: number,
  ticketId: number,
): boolean {
  const table = kind === 'planner' ? 'approach_planner_runs' : 'approach_node_runs';
  const row = store.db
    .prepare(
      `SELECT gr.ticket_id AS ticketId
         FROM ${table} r JOIN approach_graph_runs gr ON gr.id = r.graph_run_id
        WHERE r.id = ?`,
    )
    .get(runId) as { ticketId: number } | undefined;
  return row !== undefined && row.ticketId === ticketId;
}

function owned<T extends { ticketId: number }>(
  row: T | undefined,
  ticketId: number,
): T | null {
  if (row === undefined) return null;
  return row.ticketId === ticketId ? row : null;
}

/**
 * Resolve an open-file target to a canonical path inside the repo's worktree,
 * or an error naming why it must not be opened.
 *
 * The stored `file` is repo-RELATIVE by contract, but this boundary does not
 * trust the earlier one: an absolute path, a `..` traversal, an empty path, or
 * a path with no mapped worktree is rejected HERE. Symlinks are the real
 * escape: the deepest EXISTING ancestor is canonicalized (realpath resolves
 * any symlink it contains) and the missing tail is re-appended onto that
 * canonical base — the not-yet-existing leaf cannot smuggle a link — then the
 * result must still be a descendant of the canonicalized worktree root.
 */
export function resolveOpenFileTarget(
  store: Store,
  target: Extract<InsideActionTarget, { kind: 'open-file' }>,
  deps: { worktreeForRepo: (repo: string) => string | undefined; fs: InsideFileFs },
): { path: string } | { error: string } {
  const row =
    target.evidence.source === 'review-finding'
      ? getFindingById(store, target.evidence.id)
      : getUatFindingById(store, target.evidence.id);
  if (!row) return { error: 'unknown evidence' };
  if (row.ticketId !== target.ticketId) return { error: 'evidence belongs to another ticket' };

  const file =
    target.evidence.source === 'review-finding'
      ? (row as { file?: string | null }).file ?? null
      : (row as { filePath?: string | null }).filePath ?? null;
  if (file === null || file.length === 0) return { error: 'evidence is not file-scoped' };
  if (file.startsWith('/') || file.startsWith('\\')) return { error: 'absolute path refused' };
  if (file.includes('\0')) return { error: 'path refused' };
  const segments = file.split('/');
  if (segments.some((s) => s === '..')) return { error: 'path traversal refused' };
  if (segments.some((s) => s.length === 0)) return { error: 'path refused' };

  const repo = row.repo;
  if (!repo) return { error: 'evidence is not repository-scoped' };
  const worktree = deps.worktreeForRepo(repo);
  if (!worktree) return { error: 'no worktree registered for the evidence repository' };

  const candidate = `${worktree.replace(/\/+$/, '')}/${segments.join('/')}`;
  const root = canonicalPath(worktree);

  let existing = candidate;
  const missing: string[] = [];
  while (!deps.fs.existsSync(existing)) {
    const parent = existing.replace(/\/[^/]*$/, '');
    if (parent === existing || parent.length === 0) return { error: 'no existing ancestor inside the worktree' };
    missing.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  const canonicalBase = canonicalPath(deps.fs.realpathSync(existing));
  const resolved = missing.length === 0 ? canonicalBase : `${canonicalBase}/${missing.join('/')}`;
  if (!isPathUnder(resolved, root)) return { error: 'path escapes the recorded worktree' };
  return { path: resolved };
}

/**
 * Resolve one opaque action id and dispatch its stored target. Returns
 * `dispatched`, `rejected` (the target failed its checks — reported to the
 * user, never silently dropped), or `unknown` (no such id for this snapshot).
 */
export function dispatchInsideAction(
  store: Store,
  registry: InsideActionRegistry,
  actionId: string,
  deps: {
    host: InsideActionHost;
    worktreeForRepo: (repo: string) => string | undefined;
    fs: InsideFileFs;
  },
): InsideDispatchOutcome {
  const target = registry.resolve(actionId);
  if (target === null) return { outcome: 'unknown' };

  switch (target.kind) {
    case 'open-file': {
      const resolved = resolveOpenFileTarget(store, target, deps);
      if ('error' in resolved) return { outcome: 'rejected', reason: resolved.error };
      void deps.host.openFile(resolved.path);
      return { outcome: 'dispatched' };
    }
    case 'open-pr': {
      const row = owned(getPrById(store, target.prId), target.ticketId);
      if (row === null) return { outcome: 'rejected', reason: 'PR not found for this ticket' };
      void deps.host.openPr(target.ticketId, target.prId);
      return { outcome: 'dispatched' };
    }
    case 'open-commit': {
      const row = owned(getShipCommitById(store, target.shipCommitId), target.ticketId);
      if (row === null) return { outcome: 'rejected', reason: 'commit not found for this ticket' };
      void deps.host.openCommit(target.ticketId, target.shipCommitId);
      return { outcome: 'dispatched' };
    }
    case 'open-stage-log': {
      // The log artifact is recorded on the STAGE row, not the run row — the
      // stage's artifact_path is host-written and host-owned, so the dispatch
      // only proves the ticket owns the stage, then opens that path.
      let artifact: string | null = null;
      try {
        const ticket = getTicket(store, target.ticketId);
        artifact = ticket.stages.find((s) => s.stageKey === target.stageKey)?.artifactPath ?? null;
      } catch {
        return { outcome: 'rejected', reason: 'ticket not found' };
      }
      if (artifact === null || artifact.length === 0) {
        return { outcome: 'rejected', reason: 'no log artifact recorded' };
      }
      void deps.host.openFile(artifact);
      return { outcome: 'dispatched' };
    }
    case 'resume-stage': {
      // Only a stage actually parked on this ticket is resumable: a stale panel
      // or a block cleared since the snapshot must not be resumed by this id.
      if (stageBlock(store, target.ticketId, target.stageKey) === null) {
        return { outcome: 'rejected', reason: 'stage is not blocked' };
      }
      void deps.host.resumeStage(target.ticketId, target.stageKey);
      return { outcome: 'dispatched' };
    }
    case 'open-full-evidence': {
      const row = owned(getProcessRunById(store, target.processRunId), target.ticketId);
      if (row === null) return { outcome: 'rejected', reason: 'process run not found for this ticket' };
      void deps.host.openFullEvidence(target.ticketId, target.processRunId);
      return { outcome: 'dispatched' };
    }
    case 'open-bounded-evidence': {
      void deps.host.openBoundedEvidence(target.ticketId, target.title, target.rows);
      return { outcome: 'dispatched' };
    }
    case 'graph-open-session': {
      // Open reveals a LIVE session's terminal — it never spawns one. The
      // proof is the recorded run row: it must exist and belong to this
      // ticket, or the id is stale/foreign.
      if (!graphSessionOwner(store, target.session.kind, target.session.runId, target.ticketId)) {
        return { outcome: 'rejected', reason: 'session run not found for this ticket' };
      }
      void deps.host.graphOpenSession(target.ticketId, target.session);
      return { outcome: 'dispatched' };
    }
    case 'graph-stop': {
      const row = store.db
        .prepare(
          'SELECT status FROM approach_graph_runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(target.ticketId) as { status: string } | undefined;
      if (row === undefined || !GRAPH_STOPPABLE_STATUSES.includes(row.status)) {
        return { outcome: 'rejected', reason: 'no live graph run to stop' };
      }
      void deps.host.graphStop(target.ticketId);
      return { outcome: 'dispatched' };
    }
    case 'graph-confirm': {
      const row = store.db
        .prepare(
          'SELECT status FROM approach_graph_runs WHERE id = ? AND ticket_id = ?',
        )
        .get(target.graphRunId, target.ticketId) as { status: string } | undefined;
      if (row?.status !== 'awaiting-confirmation') {
        return { outcome: 'rejected', reason: 'graph is not awaiting confirmation' };
      }
      void deps.host.graphConfirm(target.ticketId, target.graphRunId);
      return { outcome: 'dispatched' };
    }
    case 'graph-discard-node': {
      // The discard is offered only on ambiguous runs; the run row must exist
      // and belong to this ticket, or the id is stale/foreign. The discard
      // module's own transaction is the status gate — this dispatch only
      // proves ownership, exactly like graph-open-session.
      if (!graphSessionOwner(store, 'node', target.nodeRunId, target.ticketId)) {
        return { outcome: 'rejected', reason: 'node run not found for this ticket' };
      }
      void deps.host.graphDiscardNode(target.ticketId, target.nodeRunId);
      return { outcome: 'dispatched' };
    }
    case 'graph-edit-override': {
      // The override editor is offered only on editable nodes; the run row
      // must exist and belong to this ticket, or the id is stale/foreign. The
      // store's claim gate is the write's authority — this dispatch only
      // proves ownership and opens the surface.
      if (!graphSessionOwner(store, 'node', target.nodeRunId, target.ticketId)) {
        return { outcome: 'rejected', reason: 'node run not found for this ticket' };
      }
      void deps.host.graphEditOverride(target.ticketId, target.nodeRunId);
      return { outcome: 'dispatched' };
    }
  }
}
