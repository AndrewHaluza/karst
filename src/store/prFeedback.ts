import type { Store } from './db.js';
import { parseThreadComments, serializeThreadComments } from '../model/prReview.js';
import type {
  PrFeedbackSnapshot,
  PrReviewAuthor,
  PrReviewSubmission,
  PrReviewThread,
  PrThreadComment,
} from '../model/prReview.js';

/** One `pr_feedback` row, camel-cased for the store's consumers. */
export interface PrFeedbackRow {
  id: number;
  ticketId: number;
  repo: string;
  /** v58: the URL the feedback was read from; part of the reconcile's scope. */
  prUrl: string;
  kind: 'thread' | 'review';
  upstreamKey: string;
  threadNodeId: string | null;
  upstreamUpdatedAt: string | null;
  state: string | null;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalCommitId: string | null;
  subjectType: string | null;
  author: PrReviewAuthor;
  body: string;
  comments: PrThreadComment[];
  firstSeenAt: string;
  lastSeenAt: string;
  absentAt: string | null;
  /**
   * v59: the recovery round that adopted this feedback, or null when nothing
   * has picked it up yet. This — not GitHub's `isResolved` — is the local
   * done-signal, because karst never writes to GitHub.
   */
  recoveryRoundId: number | null;
}

export interface ReconcilePrFeedbackOpts {
  ticketId: number;
  repo: string;
  prUrl: string;
  snapshot: PrFeedbackSnapshot;
  at: string;
  /**
   * Whether a row present locally and absent from the snapshot may be stamped
   * `absent_at`. Defaults to true. A TRUNCATED probe must pass false: its
   * snapshot is an incomplete set, and marking what it did not read absent would
   * claim the reviewer withdrew feedback that merely fell past the page size.
   */
  markAbsent?: boolean;
  /** '[merge]'-prefixed decision logging. */
  debug?: (message: string) => void;
}

export interface ReconcilePrFeedbackResult {
  inserted: number;
  updated: number;
  markedAbsent: number;
  reappeared: number;
  unchanged: number;
}

/** The raw `pr_feedback` shape — snake_case, SQLite integers for booleans. */
interface PrFeedbackDbRow {
  id: number;
  ticket_id: number;
  repo: string;
  pr_url: string;
  kind: string;
  upstream_key: string;
  thread_node_id: string | null;
  upstream_updated_at: string | null;
  state: string | null;
  is_resolved: number;
  is_outdated: number;
  path: string | null;
  line: number | null;
  start_line: number | null;
  original_line: number | null;
  original_commit_id: string | null;
  subject_type: string | null;
  author_login: string;
  author_type: string;
  author_association: string;
  body: string;
  comments: string | null;
  first_seen_at: string;
  last_seen_at: string;
  absent_at: string | null;
  recovery_round_id: number | null;
}

/** One upstream item flattened to the columns the reconcile writes. */
interface IncomingFeedback {
  kind: 'thread' | 'review';
  upstreamKey: string;
  threadNodeId: string | null;
  upstreamUpdatedAt: string | null;
  state: string | null;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalCommitId: string | null;
  subjectType: string | null;
  author: PrReviewAuthor;
  body: string;
  comments: PrThreadComment[];
}

function fromThread(thread: PrReviewThread): IncomingFeedback {
  return {
    kind: 'thread',
    upstreamKey: thread.upstreamKey,
    threadNodeId: thread.nodeId,
    upstreamUpdatedAt: thread.updatedAt,
    state: null,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    line: thread.line,
    startLine: thread.startLine,
    originalLine: thread.originalLine,
    originalCommitId: thread.originalCommitId,
    subjectType: thread.subjectType,
    author: thread.author,
    body: thread.body,
    comments: thread.comments,
  };
}

function fromReview(review: PrReviewSubmission): IncomingFeedback {
  return {
    kind: 'review',
    upstreamKey: review.upstreamKey,
    threadNodeId: null,
    upstreamUpdatedAt: review.updatedAt,
    state: review.state,
    isResolved: false,
    isOutdated: false,
    path: null,
    line: null,
    startLine: null,
    originalLine: null,
    originalCommitId: null,
    subjectType: null,
    author: review.author,
    body: review.body,
    comments: [],
  };
}

/**
 * Every incoming item: one per thread, plus one per review that carries a body.
 * An empty-bodied review is skipped — its verdict is already on the snapshot's
 * decision and its inline asks are the threads.
 */
function incomingItems(snapshot: PrFeedbackSnapshot): IncomingFeedback[] {
  return [
    ...snapshot.threads.map(fromThread),
    ...snapshot.reviews.filter((r) => r.body.trim() !== '').map(fromReview),
  ];
}

/**
 * Whether an existing row and an incoming item differ.
 *
 * The explicit null branch is required: `null !== null` is false, so a null
 * change-detector would otherwise read as unchanged forever. With no detector,
 * re-reading is the only safe answer.
 */
function changed(existing: PrFeedbackDbRow, incoming: IncomingFeedback): boolean {
  if (incoming.upstreamUpdatedAt === null) return true;
  if (incoming.upstreamUpdatedAt !== existing.upstream_updated_at) return true;
  if (incoming.isResolved !== (existing.is_resolved !== 0)) return true;
  if (incoming.isOutdated !== (existing.is_outdated !== 0)) return true;
  if (incoming.line !== existing.line) return true;
  if (incoming.path !== existing.path) return true;
  if (incoming.body !== existing.body) return true;
  return false;
}

function writeParams(item: IncomingFeedback, at: string) {
  return {
    kind: item.kind,
    upstreamKey: item.upstreamKey,
    threadNodeId: item.threadNodeId,
    upstreamUpdatedAt: item.upstreamUpdatedAt,
    state: item.state,
    isResolved: item.isResolved ? 1 : 0,
    isOutdated: item.isOutdated ? 1 : 0,
    path: item.path,
    line: item.line,
    startLine: item.startLine,
    originalLine: item.originalLine,
    originalCommitId: item.originalCommitId,
    subjectType: item.subjectType,
    authorLogin: item.author.login,
    authorType: item.author.typeName,
    authorAssociation: item.author.association,
    body: item.body,
    comments: serializeThreadComments(item.comments),
    lastSeenAt: at,
  };
}

function rowToFeedback(r: PrFeedbackDbRow): PrFeedbackRow {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    repo: r.repo,
    prUrl: r.pr_url,
    kind: r.kind === 'review' ? 'review' : 'thread',
    upstreamKey: r.upstream_key,
    threadNodeId: r.thread_node_id,
    upstreamUpdatedAt: r.upstream_updated_at,
    state: r.state,
    isResolved: r.is_resolved !== 0,
    isOutdated: r.is_outdated !== 0,
    path: r.path,
    line: r.line,
    startLine: r.start_line,
    originalLine: r.original_line,
    originalCommitId: r.original_commit_id,
    subjectType: r.subject_type,
    author: {
      login: r.author_login,
      typeName: r.author_type,
      association: r.author_association,
    },
    body: r.body,
    comments: parseThreadComments(r.comments),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    absentAt: r.absent_at,
    recoveryRoundId: r.recovery_round_id,
  };
}

/**
 * Reconcile one successful probe's snapshot into `pr_feedback`.
 *
 * The whole sweep is ONE transaction, so an interrupted run never leaves a
 * half-reconciled PR. Repeated sweeps converge: a new upstream id inserts, a
 * changed one updates, and an id absent from a SUCCESSFUL probe is stamped
 * `absent_at` rather than deleted — withdrawn feedback is evidence. Rows are
 * scoped by `(ticket_id, repo, pr_url)`: a superseded PR url's rows are left
 * untouched, because marking them absent would claim the reviewer withdrew
 * something they did not.
 */
export function reconcilePrFeedback(
  store: Store,
  opts: ReconcilePrFeedbackOpts,
): ReconcilePrFeedbackResult {
  const { ticketId, repo, prUrl, snapshot, at, markAbsent: mayMarkAbsent = true, debug } = opts;
  debug?.(`[merge] pr feedback reconcile ticket ${ticketId} ${repo} ${prUrl}`);

  const readExisting = store.db.prepare(
    'SELECT * FROM pr_feedback WHERE ticket_id = ? AND repo = ? AND pr_url = ?',
  );
  const insert = store.db.prepare(
    `INSERT INTO pr_feedback
       (ticket_id, repo, pr_url, kind, upstream_key, thread_node_id, upstream_updated_at,
        state, is_resolved, is_outdated, path, line, start_line, original_line,
        original_commit_id, subject_type, author_login, author_type, author_association,
        body, comments, first_seen_at, last_seen_at, absent_at)
     VALUES
       (@ticketId, @repo, @prUrl, @kind, @upstreamKey, @threadNodeId, @upstreamUpdatedAt,
        @state, @isResolved, @isOutdated, @path, @line, @startLine, @originalLine,
        @originalCommitId, @subjectType, @authorLogin, @authorType, @authorAssociation,
        @body, @comments, @firstSeenAt, @lastSeenAt, @absentAt)`,
  );
  const update = store.db.prepare(
    `UPDATE pr_feedback SET
       kind = @kind,
       thread_node_id = @threadNodeId,
       upstream_updated_at = @upstreamUpdatedAt,
       state = @state,
       is_resolved = @isResolved,
       is_outdated = @isOutdated,
       path = @path,
       line = @line,
       start_line = @startLine,
       original_line = @originalLine,
       original_commit_id = @originalCommitId,
       subject_type = @subjectType,
       author_login = @authorLogin,
       author_type = @authorType,
       author_association = @authorAssociation,
       body = @body,
       comments = @comments,
       last_seen_at = @lastSeenAt,
       absent_at = NULL
     WHERE id = @id`,
  );
  const touch = store.db.prepare(
    'UPDATE pr_feedback SET last_seen_at = @lastSeenAt WHERE id = @id',
  );
  const reappear = store.db.prepare(
    'UPDATE pr_feedback SET absent_at = NULL, last_seen_at = @lastSeenAt WHERE id = @id',
  );
  const markAbsent = store.db.prepare(
    'UPDATE pr_feedback SET absent_at = @at WHERE id = @id',
  );

  const apply = store.db.transaction((): ReconcilePrFeedbackResult => {
    const existing = readExisting.all(ticketId, repo, prUrl) as PrFeedbackDbRow[];
    const byKey = new Map<string, PrFeedbackDbRow>();
    for (const row of existing) byKey.set(row.upstream_key, row);

    const incoming = incomingItems(snapshot);
    const incomingKeys = new Set(incoming.map((item) => item.upstreamKey));

    let inserted = 0;
    let updated = 0;
    let markedAbsent = 0;
    let reappeared = 0;
    let unchanged = 0;

    for (const item of incoming) {
      const row = byKey.get(item.upstreamKey);
      const params = writeParams(item, at);
      if (!row) {
        insert.run({ ...params, ticketId, repo, prUrl, firstSeenAt: at, absentAt: null });
        inserted += 1;
        continue;
      }
      if (changed(row, item)) {
        // The UPDATE clears absent_at: a row the probe saw again is present
        // upstream whether or not its content moved, so a changed row that had
        // been stamped absent must not stay hidden.
        update.run({ ...params, id: row.id });
        if (row.absent_at !== null) reappeared += 1;
        updated += 1;
        continue;
      }
      if (row.absent_at !== null) {
        reappear.run({ id: row.id, lastSeenAt: at });
        reappeared += 1;
        continue;
      }
      touch.run({ id: row.id, lastSeenAt: at });
      unchanged += 1;
    }

    for (const row of existing) {
      if (mayMarkAbsent && !incomingKeys.has(row.upstream_key) && row.absent_at === null) {
        markAbsent.run({ id: row.id, at });
        markedAbsent += 1;
      }
    }

    return { inserted, updated, markedAbsent, reappeared, unchanged };
  });

  const result = apply();
  debug?.(
    `[merge] pr feedback reconcile ticket ${ticketId} ${repo}: inserted=${result.inserted} ` +
      `updated=${result.updated} markedAbsent=${result.markedAbsent} ` +
      `reappeared=${result.reappeared} unchanged=${result.unchanged}`,
  );
  return result;
}

/**
 * A ticket's feedback rows, oldest first. Absent rows are hidden unless
 * `includeAbsent` — a withdrawn thread is evidence, not current feedback.
 */
export function listPrFeedback(
  store: Store,
  ticketId: number,
  opts?: { includeAbsent?: boolean },
): PrFeedbackRow[] {
  const sql =
    opts?.includeAbsent === true
      ? 'SELECT * FROM pr_feedback WHERE ticket_id = ? ORDER BY id'
      : 'SELECT * FROM pr_feedback WHERE ticket_id = ? AND absent_at IS NULL ORDER BY id';
  return store.db
    .prepare(sql)
    .all(ticketId)
    .map((r) => rowToFeedback(r as PrFeedbackDbRow));
}

/** The count of unresolved, non-absent feedback — the open-ask count. */
export function countOpenPrFeedback(store: Store, ticketId: number): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM pr_feedback
        WHERE ticket_id = ? AND absent_at IS NULL AND is_resolved = 0`,
    )
    .get(ticketId) as { n: number };
  return row.n;
}

/** Feedback nothing has adopted yet: live, unresolved, not outdated, no round. */
export function listUnadoptedPrFeedback(store: Store, ticketId: number): PrFeedbackRow[] {
  return store.db
    .prepare(
      `SELECT * FROM pr_feedback
        WHERE ticket_id = ? AND absent_at IS NULL AND is_resolved = 0
          AND is_outdated = 0 AND recovery_round_id IS NULL
        ORDER BY id`,
    )
    .all(ticketId)
    .map((r) => rowToFeedback(r as PrFeedbackDbRow));
}

/**
 * The feedback one round is working on. Ordered repo, then path, then line —
 * with `original_line` NULLs LAST (SQLite orders NULLs first by default, which
 * would put every file-level comment above every line comment). Filters only on
 * `absent_at`, so a round still reports what it was asked to do even after a
 * reviewer resolves or edits the thread, and an upstream deletion drops the row
 * out of the round's list without affecting the round.
 *
 * Positional `?` parameters and no transaction: this runs under the `karst` CLI
 * (`node:sqlite`'s flat shim, `docs/arch/cli.md`).
 */
export function listPrFeedbackForRound(
  store: Store,
  ticketId: number,
  roundId: number,
): PrFeedbackRow[] {
  return store.db
    .prepare(
      `SELECT * FROM pr_feedback
        WHERE ticket_id = ? AND recovery_round_id = ? AND absent_at IS NULL
        ORDER BY repo, path, original_line IS NULL, original_line`,
    )
    .all(ticketId, roundId)
    .map((r) => rowToFeedback(r as PrFeedbackDbRow));
}

/**
 * Adopt every unadopted row into `roundId`. Returns how many were adopted, so a
 * caller can treat 0 as "do not open a round" — the rows were resolved between
 * the availability check and this stamp.
 */
export function adoptPrFeedbackIntoRound(
  store: Store,
  ticketId: number,
  roundId: number,
): number {
  const info = store.db
    .prepare(
      `UPDATE pr_feedback SET recovery_round_id = ?
        WHERE ticket_id = ? AND absent_at IS NULL AND is_resolved = 0
          AND is_outdated = 0 AND recovery_round_id IS NULL`,
    )
    .run(roundId, ticketId);
  return info.changes;
}
