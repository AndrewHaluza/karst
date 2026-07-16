/**
 * The one timestamp format karst writes: ISO-8601, UTC. Stage timestamps are
 * compared as strings (`deriveStageCurrent` sorts by recency lexicographically),
 * which only holds while every writer uses this.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
