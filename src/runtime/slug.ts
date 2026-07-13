/**
 * Filesystem- and git-ref-safe slug for a ticket's worktree directory + branch.
 *
 * Derived from the ticket's `key` (or `#id` when unset) plus its `title`. The
 * slug is **rename-invariant**: it carries no service name, so renaming a
 * service in the manifest never changes where a ticket's worktree lands (which
 * was the "renamed service duplicates a new worktree" bug). It also replaces the
 * opaque SQL id with the human ticket key.
 *
 * Sanitization is mandatory — `key`/`title` are free-form user text and can hold
 * spaces, `/`, `:`, `~`, `^`, `?`, `*`, `..`, and unicode, all illegal or
 * dangerous in git branch names and paths. We lowercase, replace every run of
 * non-`[a-z0-9]` with a single dash, trim edge dashes, and cap the length. An
 * empty result (e.g. an all-punctuation title with no key) falls back to the id
 * so the slug is never blank.
 */
export function worktreeSlug(ticket: {
  id: number;
  key: string | null;
  title: string | null;
}): string {
  const key = ticket.key?.trim() ? ticket.key : `${ticket.id}`;
  const base = `${key} ${ticket.title ?? ''}`;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, ''); // re-trim in case the length cap left a trailing dash
  return slug || `${ticket.id}`;
}
