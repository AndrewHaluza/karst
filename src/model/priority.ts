/** The levels a draft or ticket priority may take (the labels `tickets.priority` already stores). */
export const PRIORITY_LEVELS = ['urgent', 'high', 'normal', 'low'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

/** The two ticket columns a ticket priority reads from (`priority_override` is the user's, `priority` the provider's). */
export interface TicketPriorityFields {
  readonly priority: string | null;
  readonly priorityOverride: string | null;
}

/** The priority a ticket shows and orders by: the user's override, else the provider's, else none (reads as normal). */
export function effectiveTicketPriority(t: TicketPriorityFields): PriorityLevel | null {
  return asPriorityLevel(t.priorityOverride) ?? asPriorityLevel(t.priority) ?? null;
}

/** Where the effective ticket priority came from; null when the ticket has none. */
export function ticketPrioritySource(t: TicketPriorityFields): 'you' | 'provider' | null {
  if (asPriorityLevel(t.priorityOverride) !== undefined) return 'you';
  return asPriorityLevel(t.priority) !== undefined ? 'provider' : null;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = { clickup: 'ClickUp', jira: 'Jira', trello: 'Trello', planning: 'planner' };

/** The word a tooltip uses for the system that wrote `tickets.priority` (a ticket's `source`). */
export function ticketProviderLabel(source: string | null): string {
  return (source !== null ? PROVIDER_LABELS[source] : undefined) ?? 'provider';
}

/** Narrow an untrusted value to a priority level. */
export function asPriorityLevel(v: unknown): PriorityLevel | undefined {
  return PRIORITY_LEVELS.find((l) => l === v);
}
