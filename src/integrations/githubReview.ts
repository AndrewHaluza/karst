import type { GhRunner, GhResult } from './github.js';
import {
  MAX_REVIEW_BODY,
  MAX_THREAD_COMMENTS,
  normalizeAuthor,
  normalizeReviewDecision,
  normalizeThread,
  type PrFeedbackSnapshot,
  type PrReviewState,
  type PrReviewSubmission,
  type PrReviewThread,
} from '../model/prReview.js';

/**
 * The one `gh api graphql` call that reads a PR's human review feedback —
 * decision, submitted reviews, and inline review threads with resolution state.
 *
 * This is karst's first GraphQL call. It goes through the injected `GhRunner`
 * (there is no second spawn site) and NEVER throws: a degraded `gh`, a deleted
 * PR, and a dead network are all expected outcomes and all return `null`.
 *
 * `null` means the probe failed and the caller must write NOTHING. A successful
 * probe that saw no threads returns an empty snapshot instead — the two are
 * deliberately distinguishable because the reconcile treats an empty set as
 * "every live row is now absent".
 */

/**
 * Exported so tests can inspect it. `author{ __typename login }` carries no
 * `... on User` fragment on purpose: a User-restricted fragment silently drops
 * Bot authors.
 *
 * `originalCommit` is on the COMMENT, not the thread. `PullRequestReviewThread`
 * has no `originalCommit`, `author` or `body` field — GitHub rejects unknown
 * fields at query-VALIDATION time, so asking for one on the thread would make
 * EVERY call return `errors` and this whole module a silent, permanent no-op.
 */
export const PR_FEEDBACK_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$threads:Int!,$comments:Int!,$reviews:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewDecision
      reviews(first:$reviews){
        totalCount
        nodes{ fullDatabaseId state body submittedAt updatedAt authorAssociation author{ __typename login } }
      }
      reviewThreads(first:$threads){
        totalCount
        nodes{
          id isResolved isOutdated path line startLine originalLine subjectType
          comments(first:$comments){
            totalCount
            nodes{
              databaseId body createdAt updatedAt authorAssociation
              author{ __typename login }
              originalCommit{ oid }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Page sizes, chosen to stay under the gh output cap (`GH_MAX_OUTPUT_BYTES`,
 * 1 MB). `gh pr view`'s equivalent truncation is invisible; here it is reported
 * so a chatty PR is never silently half-read.
 */
export const THREAD_PAGE = 100;
export const THREAD_COMMENT_PAGE = 50;
export const REVIEW_PAGE = 100;

export interface PrRef {
  owner: string;
  name: string;
  number: number;
}

export interface PrFeedbackTruncation {
  threads: boolean;
  reviews: boolean;
  /** Node ids of threads whose comment list was cut. */
  threadComments: string[];
}

export interface PrFeedbackProbe {
  snapshot: PrFeedbackSnapshot;
  truncated: PrFeedbackTruncation;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
}

function asString(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

function asStampOrNull(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

function asNumber(raw: unknown): number {
  return typeof raw === 'number' ? raw : 0;
}

function truncateBody(body: string): string {
  return body.length > MAX_REVIEW_BODY ? `${body.slice(0, MAX_REVIEW_BODY)}…` : body;
}

/**
 * `PullRequestReview.state` → the model. Anything unrecognised degrades to null
 * rather than being coerced into a state GitHub never emitted.
 */
function asReviewState(raw: unknown): PrReviewState | null {
  if (
    raw === 'APPROVED' ||
    raw === 'CHANGES_REQUESTED' ||
    raw === 'COMMENTED' ||
    raw === 'DISMISSED' ||
    raw === 'PENDING'
  ) {
    return raw;
  }
  return null;
}

/** A `PullRequestReview` node → the submission shape, or null when it has no key. */
function reviewFrom(raw: Record<string, unknown>): PrReviewSubmission | null {
  const key = raw.fullDatabaseId;
  if (key === null || key === undefined) return null;
  return {
    upstreamKey: String(key),
    state: asReviewState(raw.state),
    body: truncateBody(asString(raw.body)),
    author: normalizeAuthor(raw.author, raw.authorAssociation),
    submittedAt: asStampOrNull(raw.submittedAt),
    updatedAt: asStampOrNull(raw.updatedAt),
  };
}

/**
 * Parses https://github.com/<owner>/<name>/pull/<number>; null for anything else.
 *
 * Takes `unknown`, not `string`: `prs.url` is declared `url TEXT` with no NOT
 * NULL, so a row can hand back `null` at runtime despite `SyncablePr.url` being
 * typed `string`.
 */
export function parsePrRef(url: unknown): PrRef | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com') return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(parsed.pathname);
  if (!match) return null;
  const owner = match[1];
  const name = match[2];
  const numberText = match[3];
  if (!owner || !name || !numberText) return null;
  return { owner, name, number: Number(numberText) };
}

/**
 * One GraphQL fetch of a PR's review feedback.
 *
 * Returns `null` when the probe could not see the PR: a non-zero exit, a JSON
 * parse failure, an absent/non-object `pullRequest`, or a payload carrying an
 * `errors` array (a partial set would mark live rows absent). Never throws.
 */
export async function fetchPrReviewState(
  gh: GhRunner,
  ref: PrRef,
  cwd: string,
  debug?: (message: string) => void,
): Promise<PrFeedbackProbe | null> {
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${PR_FEEDBACK_QUERY}`,
    // `-f` (raw string), NOT `-F`: `-F` type-infers, so a repository whose name
    // is all digits would be sent as an Int and rejected by the `String!`
    // declarations. Only the numeric page variables may use `-F`.
    '-f',
    `owner=${ref.owner}`,
    '-f',
    `name=${ref.name}`,
    '-F',
    `number=${ref.number}`,
    '-F',
    `threads=${THREAD_PAGE}`,
    '-F',
    `comments=${THREAD_COMMENT_PAGE}`,
    '-F',
    `reviews=${REVIEW_PAGE}`,
  ];

  let result: GhResult;
  try {
    result = await gh(args, cwd);
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    // The gh runner folds an over-cap read into exitCode 1 with this stderr.
    // That is a distinct, actionable failure — the probe is unreadably large,
    // not absent — so name it rather than folding it into the generic null.
    // Never log the output itself.
    if ((result.stderr ?? '').includes('truncated gh output')) {
      debug?.(
        `[merge] pr feedback probe exceeded the gh output cap for ${ref.owner}/${ref.name} — reduce page sizes`,
      );
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const payload = asRecord(parsed);
  if (!payload) return null;
  const data = asRecord(payload.data);
  const repository = data ? asRecord(data.repository) : null;
  const pullRequest = repository ? asRecord(repository.pullRequest) : null;
  if (!pullRequest) return null;
  if (Array.isArray(payload.errors)) return null;

  const reviewsHolder = asRecord(pullRequest.reviews);
  const reviewNodes = Array.isArray(reviewsHolder?.nodes)
    ? reviewsHolder.nodes
        .map(asRecord)
        .filter((node): node is Record<string, unknown> => node !== null)
    : [];
  const reviews = reviewNodes
    .map(reviewFrom)
    .filter((review): review is PrReviewSubmission => review !== null);

  const threadsHolder = asRecord(pullRequest.reviewThreads);
  const threadNodes = Array.isArray(threadsHolder?.nodes)
    ? threadsHolder.nodes
        .map(asRecord)
        .filter((node): node is Record<string, unknown> => node !== null)
    : [];
  const threads = threadNodes
    .map(normalizeThread)
    .filter((thread): thread is PrReviewThread => thread !== null);

  const threadComments = threadNodes
    .filter((node) => asNumber(asRecord(node.comments)?.totalCount) > THREAD_COMMENT_PAGE)
    .map((node) => asString(node.id))
    .filter((id) => id !== '');

  const snapshot: PrFeedbackSnapshot = {
    decision: normalizeReviewDecision(pullRequest.reviewDecision),
    reviews,
    threads,
  };
  // The decision is PR-level and deliberately has no column (Key Decision 10):
  // it is consumed here, as one log line, and nowhere else.
  debug?.(
    `[merge] pr feedback decision for ${ref.owner}/${ref.name}#${ref.number}: ${snapshot.decision ?? 'none'}`,
  );

  return {
    snapshot,
    truncated: {
      threads: asNumber(threadsHolder?.totalCount) > THREAD_PAGE,
      reviews: asNumber(reviewsHolder?.totalCount) > REVIEW_PAGE,
      threadComments,
    },
  };
}
