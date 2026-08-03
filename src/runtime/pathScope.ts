import { existsSync, realpathSync } from 'node:fs';
import { dirname, basename, join, sep } from 'node:path';

/**
 * Canonicalize a path for equality against `git worktree list` output. git prints
 * the real (symlink-resolved) path — e.g. macOS `/var/…` → `/private/var/…` — so a
 * raw `join()`-built path won't string-match. Resolves the deepest existing
 * ancestor, then re-appends the missing tail, so it works whether or not the leaf
 * exists yet.
 *
 * Lives in this leaf module (imports only `node:fs`/`node:path`) because both
 * `worktree.ts` and `worktreeServers.ts` need it and `worktree.ts` depends on
 * `worktreeServers.ts` — putting it in either would make that a cycle.
 */
export function canonicalPath(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return p; // reached root without an existing ancestor
    tail.unshift(basename(head));
    head = parent;
  }
  const base = realpathSync(head);
  return tail.length ? join(base, ...tail) : base;
}

/**
 * True when `child` is `root` itself or lives beneath it, compared canonically.
 *
 * The separator is what makes this a containment test rather than a prefix test:
 * `startsWith` alone reports `<repo>/.karst/worktrees/abc-2` as living under
 * `<repo>/.karst/worktrees/abc`, and slugs differing only by a suffix are the
 * normal case (`-2`, `-3`… disambiguation). Killing another ticket's dev server
 * because its slug shares a prefix is precisely the failure this guards.
 */
export function isPathUnder(child: string, root: string): boolean {
  const c = canonicalPath(child);
  const r = canonicalPath(root);
  if (c === r) return true;
  return c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}
