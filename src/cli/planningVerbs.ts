/**
 * The verbs a planning session may run: reads, the `manifest` and `draft`
 * parse paths, and `plan-artifacts` (list; its import writes only inside the
 * session's own artifacts dir).
 *
 * Kept as an ORDERED list because Settings › Agents › Channels renders exactly
 * this set, in this order (@arch:CHANNEL-MAP). `main.ts` keeps a `Set` built
 * from it for the `has` check, so the guard stays O(1) and the two can never
 * disagree.
 */
export const PLANNING_VERBS: readonly string[] = [
  'context',
  'stats',
  'blocked',
  'queue',
  'guide',
  'schema',
  'manifest',
  'draft',
  'plan-artifacts',
];
