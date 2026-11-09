/** The levels a draft or ticket priority may take (the labels `tickets.priority` already stores). */
export const PRIORITY_LEVELS = ['urgent', 'high', 'normal', 'low'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

/** Narrow an untrusted value to a priority level. */
export function asPriorityLevel(v: unknown): PriorityLevel | undefined {
  return PRIORITY_LEVELS.find((l) => l === v);
}
