/**
 * The evidence cap every inside reducer applies before it renders, and the
 * single rule that "bounded" means: the first `limit` items, plus the count of
 * what was withheld. A view never renders a bounded list without being able to
 * say what it held back — `remaining` is how it does.
 */
export function bounded<T>(
  items: readonly T[],
  limit: number,
): { shown: readonly T[]; remaining: number } {
  return { shown: items.slice(0, limit), remaining: Math.max(0, items.length - limit) };
}
