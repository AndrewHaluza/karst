import { PRIORITY_LEVELS, type PriorityLevel } from './priority.js';

/** The part of a queue row the walk reads: its id, own level and open blockers. */
export interface DependentNode {
  readonly id: string;
  /** The item's own priority; null reads as `normal`. */
  readonly ownPriority: PriorityLevel | null;
  /** Ids this item waits on. An id outside the item set is ignored. */
  readonly waitsOn: readonly string[];
}

const DEFAULT_LEVEL: PriorityLevel = 'normal';

/** Rank of a level: a smaller number is a higher level. */
const rank = (level: PriorityLevel | null): number => PRIORITY_LEVELS.indexOf(level ?? DEFAULT_LEVEL);

/** True when `a` is a strictly higher level than `b`; null reads as `normal`. */
export const isHigherLevel = (a: PriorityLevel | null, b: PriorityLevel | null): boolean => rank(a) < rank(b);

/**
 * The items that wait on `rootId`, directly or transitively, whose OWN level is higher
 * than `level`. Pure (no store, no vscode) and it does not sort: the result keeps the
 * order of `items`, so the queue order stays computed in `orderQueue` only (@arch:QUEUE-ORDER).
 * A visited set makes a cycle safe. The root is never part of the result.
 */
export function dependentsAbove(
  items: readonly DependentNode[],
  rootId: string,
  level: PriorityLevel | null,
): string[] {
  const waiters = new Map<string, string[]>();
  for (const item of items) {
    for (const to of item.waitsOn) waiters.set(to, [...(waiters.get(to) ?? []), item.id]);
  }
  const seen = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    for (const from of waiters.get(stack.pop()!) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      stack.push(from);
    }
  }
  return items.filter((i) => i.id !== rootId && seen.has(i.id) && isHigherLevel(i.ownPriority, level)).map((i) => i.id);
}
