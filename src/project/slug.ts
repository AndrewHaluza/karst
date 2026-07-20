import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/**
 * Project identity (§ projects / multi-window).
 *
 * A project's slug is the key that scopes tickets to one workspace, so two IDE
 * windows opened on different stacks don't share a board. It comes from the
 * manifest's `id:` field; `generateProjectSlug` only supplies the value written
 * there at scaffold time, and the path-derived fallback for a legacy manifest
 * that predates the field.
 *
 * Host-agnostic and pure — no `vscode`, no filesystem reads.
 */

/** Length of the path digest suffix. 8 hex chars is ample for one user's projects. */
const HASH_LEN = 8;

/**
 * Reduce free-form text to a slug: lowercase, every run of non-`[a-z0-9]`
 * collapsed to one dash, edge dashes trimmed. Mirrors `worktreeSlug`'s rules so
 * the two never disagree about what a "safe name" is. May return ''.
 */
function sanitize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, ''); // re-trim in case the length cap left a trailing dash
}

/**
 * Mint a slug for the project rooted at `rootPath`: the sanitized folder name
 * plus a short digest of the absolute path.
 *
 * The folder name alone is not enough — two clones of the same repo (or two
 * users' `~/work/api`) would collide into one project and merge their boards.
 * The digest makes it unique; keeping the name in front keeps it legible in the
 * DB and in error messages. A name that sanitizes away entirely (all
 * punctuation) falls back to the `project-` prefix so the slug is never a bare
 * hash with no hint of origin.
 *
 * Deterministic: the same path always yields the same slug, so a window that
 * reopens a legacy project re-derives the identity it had before.
 */
export function generateProjectSlug(rootPath: string): string {
  // Trailing separators would fork one folder into two digests.
  const normalized = rootPath.replace(/[/\\]+$/, '');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LEN);
  const name = sanitize(basename(normalized));
  return `${name || 'project'}-${digest}`;
}

/**
 * The slug this window's project is keyed by: the manifest's `id` when it holds
 * one, else a slug derived from the workspace root.
 *
 * The authored id is sanitized rather than trusted verbatim — it reaches SQL as
 * a unique key and shows up in the UI, and an author who writes `id: My Project`
 * should get the same row as one who writes `id: my-project`. An id that
 * sanitizes to nothing is treated as absent.
 */
export function resolveProjectSlug(id: string | undefined, rootPath: string): string {
  const authored = id ? sanitize(id) : '';
  return authored || generateProjectSlug(rootPath);
}
