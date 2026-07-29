/**
 * PR comments as karst stores and renders them.
 *
 * The shape is deliberately narrow — author, stamp, body — because this is
 * DISPLAY data cached in the registry, not a mirror of GitHub's comment model.
 * gh is the source of truth; a comment edited or deleted upstream is corrected by
 * the next sweep, so nothing here is treated as authoritative.
 *
 * Pure: no store, no clock, no gh. Both the normalizer (gh's JSON → this shape)
 * and the (de)serializer (this shape ↔ the `prs.comments` column) live here so
 * the bounds are enforced once, on the way in.
 */

export interface PrComment {
  /** Comment author's login, or '' when gh did not name one. */
  author: string;
  /** ISO-8601 creation stamp, or null when absent/unparseable. */
  at: string | null;
  /** Comment body, truncated to `MAX_COMMENT_BODY`. */
  body: string;
}

/**
 * A PR thread can run to hundreds of comments; the registry is a display cache,
 * not an archive, and the panel could not show them all anyway.
 */
export const MAX_STORED_COMMENTS = 20;

/** Long enough for a real review note, short enough that 20 of them stay small. */
export const MAX_COMMENT_BODY = 2000;

function truncate(body: string): string {
  return body.length > MAX_COMMENT_BODY ? `${body.slice(0, MAX_COMMENT_BODY)}…` : body;
}

/** gh's `comments[].author` is an object; anything else means "no author stated". */
function authorOf(raw: Record<string, unknown>): string {
  const author = raw.author;
  if (typeof author !== 'object' || author === null) return '';
  const login = (author as Record<string, unknown>).login;
  return typeof login === 'string' ? login : '';
}

/**
 * gh's `comments` JSON → stored comments, bounded.
 *
 * Returns null for anything that is not an array — including absent. `[]` and
 * null are DIFFERENT answers: `[]` is "this PR has no comments", null is "gh did
 * not tell us", and only the second must leave a stored value alone.
 *
 * A comment missing an author or a stamp is kept, degraded: dropping it would
 * make the count lie about the thread the user is about to merge.
 */
export function normalizeComments(raw: unknown): PrComment[] | null {
  if (!Array.isArray(raw)) return null;
  const kept = raw.filter(
    (c): c is Record<string, unknown> => typeof c === 'object' && c !== null,
  );
  // Newest wins when the thread outgrows the cap: the recent end is what a
  // reader needs before merging.
  return kept.slice(-MAX_STORED_COMMENTS).map((c) => ({
    author: authorOf(c),
    at: typeof c.createdAt === 'string' && c.createdAt !== '' ? c.createdAt : null,
    body: truncate(typeof c.body === 'string' ? c.body : ''),
  }));
}

/** Comments → the `prs.comments` column. null stays null: "never probed". */
export function serializeComments(comments: readonly PrComment[] | null): string | null {
  return comments === null ? null : JSON.stringify(comments);
}

/**
 * The `prs.comments` column → comments. Never throws: a NULL, empty, or
 * malformed column renders as no comments rather than taking the panel down with
 * it (the column is a display cache; gh remains the source of truth).
 */
export function parseComments(raw: string | null | undefined): PrComment[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => ({
        author: typeof c.author === 'string' ? c.author : '',
        at: typeof c.at === 'string' && c.at !== '' ? c.at : null,
        body: truncate(typeof c.body === 'string' ? c.body : ''),
      }));
  } catch {
    return [];
  }
}
