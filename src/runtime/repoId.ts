/**
 * The canonical form of a manifest repository name.
 *
 * A repository name has two halves that must agree: the manifest key an author
 * writes (`BE:`, `DBGW:`) and the identifier a graph document claims
 * (`resources.writes[].repo`). The graph wire grammar is a bounded
 * safe-identifier, historically lowercase-only — which made every uppercase
 * manifest key unsatisfiable: the uppercase spelling failed the grammar, and
 * the lowercase spelling missed the repository map keyed by the verbatim
 * manifest name. Both halves now canonicalize through this ONE function, so a
 * claim resolves case-insensitively while the wire value stays bounded.
 *
 * Case-insensitive resolution makes two manifest keys that differ only by case
 * ambiguous; `repoIdCollisions` names them so manifest validation can reject
 * them where the author can fix them.
 */

/** The canonical (case-folded) form of a repository name. */
export function canonicalRepoId(name: string): string {
  return name.toLowerCase();
}

/**
 * The manifest repository names that collide once canonicalized, each paired
 * with the FIRST name that claimed the canonical form (declaration order).
 */
export function repoIdCollisions(names: readonly string[]): [string, string][] {
  const firstByCanonical = new Map<string, string>();
  const collisions: [string, string][] = [];
  for (const name of names) {
    const canonical = canonicalRepoId(name);
    const first = firstByCanonical.get(canonical);
    if (first === undefined) firstByCanonical.set(canonical, name);
    else collisions.push([first, name]);
  }
  return collisions;
}
