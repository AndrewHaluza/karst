/**
 * A PR's human review feedback, as karst models it.
 *
 * This is the COMPLETE, un-truncated record of a PR's review feedback. It is the
 * deliberate opposite of `model/prComments.ts`, a lossy display cache (newest-20,
 * 2000-char bodies) — the difference exists because this data is ACTED ON by an
 * agent, not merely shown. Feedback is bounded only well above what a reader
 * needs, and nothing here is dropped just because it is inconvenient to render.
 *
 * Pure: no store, no clock, no I/O, no gh. Any GH/GitHub shape that reaches the
 * exported normalisers is untrusted, so every one of them degrades rather than
 * throws.
 */

export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

/**
 * gh types `reviewDecision` as a Go string, so "no decision" arrives as '' and
 * never as null. Anything unrecognised — '' included — normalises to null.
 */
export function normalizeReviewDecision(raw: unknown): PrReviewDecision {
  if (raw !== 'APPROVED' && raw !== 'CHANGES_REQUESTED' && raw !== 'REVIEW_REQUIRED') return null;
  return raw;
}

/**
 * All five review states GitHub can emit.
 *
 * `PENDING` is an unsubmitted draft visible only to its author, so a poller never
 * observes it; it is listed so an unexpected value is not silently coerced.
 */
export type PrReviewState =
  | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface PrReviewAuthor {
  login: string;
  /** GraphQL __typename: 'User' | 'Bot' | 'Organization' | 'Mannequin' | '' when absent. */
  typeName: string;
  /** OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE | '' when absent. */
  association: string;
}

/**
 * A GraphQL author node plus its sibling `authorAssociation`, degraded to strings.
 *
 * Bot detection keys off `__typename`, never a `[bot]` login suffix: a GitHub App
 * acting for a user appears as that user.
 */
export function normalizeAuthor(raw: unknown, association: unknown): PrReviewAuthor {
  if (typeof raw !== 'object' || raw === null) return { login: '', typeName: '', association: '' };
  const record = raw as Record<string, unknown>;
  return {
    login: typeof record.login === 'string' ? record.login : '',
    typeName: typeof record.__typename === 'string' ? record.__typename : '',
    association: typeof association === 'string' ? association : '',
  };
}

/**
 * A PR thread can run long, but this is a record to act on, not a display list:
 * the cap is far above what a reviewer would write.
 */
export const MAX_THREAD_COMMENTS = 50;

/**
 * An order of magnitude above `prComments.ts`'s display cap because this text is
 * an agent's instruction, not a preview. Truncation appends '…'.
 */
export const MAX_REVIEW_BODY = 20000;

export interface PrThreadComment {
  databaseId: number | null;
  author: PrReviewAuthor;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PrReviewThread {
  /** PRRT_… — call-scoped, kept for a future resolveReviewThread, never a key. */
  nodeId: string;
  /** Stable databaseId of the thread's first comment, as text. The durable key. */
  upstreamKey: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  /** Recomputed against the current diff; NULL once outdated. Advisory only. */
  line: number | null;
  /** Multi-line asks carry a start; NULL for single-line. */
  startLine: number | null;
  /** The anchor that survives a push. */
  originalLine: number | null;
  originalCommitId: string | null;
  /** 'LINE' or 'FILE' — a FILE comment has line null BY DESIGN, not by error. */
  subjectType: string;
  author: PrReviewAuthor;
  /**
   * The FIRST comment's body, truncated to MAX_REVIEW_BODY — the reviewer's
   * original point. The reconcile's change detector compares this, and
   * `pr_feedback.body` is NOT NULL, so it is required, never optional.
   */
  body: string;
  comments: PrThreadComment[];
  /** Greatest updatedAt across the thread's comments; the change detector. */
  updatedAt: string | null;
}

export interface PrReviewSubmission {
  upstreamKey: string;
  state: PrReviewState | null;
  body: string;
  author: PrReviewAuthor;
  /** When the review was posted. Informational; NOT the change detector. */
  submittedAt: string | null;
  /**
   * Moves when the reviewer edits the review body. This is what maps to
   * `pr_feedback.upstream_updated_at` — never `submittedAt`, or the reconcile's
   * null branch would report an edit on every sweep forever.
   */
  updatedAt: string | null;
}

/** The whole of one PR's feedback, as one successful probe saw it. */
export interface PrFeedbackSnapshot {
  decision: PrReviewDecision;
  reviews: PrReviewSubmission[];
  threads: PrReviewThread[];
}

/**
 * A failed probe is represented by `null`, not by an all-unknown object, and there
 * is deliberately NO `UNKNOWN_PR_FEEDBACK` value.
 *
 * `UNKNOWN_PR_DETAIL` exists because `PrDetail` is applied field-by-field and a
 * partial update is safe. A feedback snapshot is reconciled as one SET: a partial
 * or "unknown" set would make the reconcile mark every live row absent. The caller
 * must therefore write NOTHING for a null, which is only possible if "failed" and
 * "succeeded with no feedback" are distinguishable answers.
 */

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
}

function asString(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

function asNumberOrNull(raw: unknown): number | null {
  return typeof raw === 'number' ? raw : null;
}

function asStampOrNull(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

function truncateBody(body: string): string {
  return body.length > MAX_REVIEW_BODY ? `${body.slice(0, MAX_REVIEW_BODY)}…` : body;
}

/** A GraphQL `PullRequestReviewComment` node → the stored comment shape. */
function commentFrom(raw: Record<string, unknown>): PrThreadComment {
  return {
    databaseId: asNumberOrNull(raw.databaseId),
    author: normalizeAuthor(raw.author, raw.authorAssociation),
    body: truncateBody(asString(raw.body)),
    createdAt: asStampOrNull(raw.createdAt),
    updatedAt: asStampOrNull(raw.updatedAt),
  };
}

/** A previously serialized `PrThreadComment` → the stored comment shape. */
function storedComment(raw: Record<string, unknown>): PrThreadComment {
  const author = asRecord(raw.author);
  return {
    databaseId: asNumberOrNull(raw.databaseId),
    author: {
      login: author ? asString(author.login) : '',
      typeName: author ? asString(author.typeName) : '',
      association: author ? asString(author.association) : '',
    },
    body: truncateBody(asString(raw.body)),
    createdAt: asStampOrNull(raw.createdAt),
    updatedAt: asStampOrNull(raw.updatedAt),
  };
}

/** The greatest non-empty stamp across every comment; null when none carries one. */
function greatestUpdatedAt(nodes: readonly Record<string, unknown>[]): string | null {
  let greatest: string | null = null;
  for (const node of nodes) {
    const stamp = asStampOrNull(node.updatedAt);
    if (stamp !== null && (greatest === null || stamp > greatest)) greatest = stamp;
  }
  return greatest;
}

/**
 * A GraphQL `PullRequestReviewThread` node → the model, or null when it carries no
 * usable identity.
 *
 * A thread has no author, body or commit of its own; all three come from its FIRST
 * comment (the reviewer's original point — later nodes are replies). Its identity
 * is the first comment that HAS a `databaseId`; a thread with no such comment, or
 * none at all, is DROPPED rather than thrown over. `updatedAt` is the greatest
 * across ALL comments, not the first's: an edit to any reply must move the thread's
 * change detector. Comments beyond `MAX_THREAD_COMMENTS` keep the OLDEST, because
 * the first comment is the actual ask and the tail is discussion.
 */
export function normalizeThread(raw: unknown): PrReviewThread | null {
  const thread = asRecord(raw);
  if (!thread) return null;

  const commentsHolder = asRecord(thread.comments);
  const rawNodes =
    commentsHolder && Array.isArray(commentsHolder.nodes) ? commentsHolder.nodes : [];
  const nodes = rawNodes
    .map(asRecord)
    .filter((node): node is Record<string, unknown> => node !== null);
  if (nodes.length === 0) return null;

  const keyNode = nodes.find((node) => typeof node.databaseId === 'number');
  if (!keyNode) return null;

  const first = nodes[0]!;
  const originalCommit = asRecord(first.originalCommit);

  return {
    nodeId: asString(thread.id),
    upstreamKey: String(keyNode.databaseId),
    isResolved: thread.isResolved === true,
    isOutdated: thread.isOutdated === true,
    path: asString(thread.path) === '' ? null : asString(thread.path),
    line: asNumberOrNull(thread.line),
    startLine: asNumberOrNull(thread.startLine),
    originalLine: asNumberOrNull(thread.originalLine),
    originalCommitId: originalCommit ? asStampOrNull(originalCommit.oid) : null,
    subjectType: asString(thread.subjectType),
    author: normalizeAuthor(first.author, first.authorAssociation),
    body: truncateBody(asString(first.body)),
    comments: nodes.slice(0, MAX_THREAD_COMMENTS).map(commentFrom),
    updatedAt: greatestUpdatedAt(nodes),
  };
}

/** Thread comments → the `pr_feedback.comments` column. */
export function serializeThreadComments(comments: readonly PrThreadComment[]): string {
  return JSON.stringify(comments);
}

/**
 * The `pr_feedback.comments` column → comments. Never throws: a NULL, empty, or
 * malformed column renders as no comments rather than taking a reader down.
 */
export function parseThreadComments(raw: string | null | undefined): PrThreadComment[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(asRecord)
      .filter((comment): comment is Record<string, unknown> => comment !== null)
      .map(storedComment);
  } catch {
    return [];
  }
}
