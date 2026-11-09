import { providerLabel } from './ticketProviders.js';

/** The levels a draft or ticket priority may take (the labels `tickets.priority` already stores). */
export const PRIORITY_LEVELS = ['urgent', 'high', 'normal', 'low'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

/**
 * The ticket columns a ticket priority reads from (`priority_override` is the user's, `priority` the
 * provider's or the planner's). `source` and `sourceRef` tell a planner value from a provider value.
 */
export interface TicketPriorityFields {
  readonly priority: string | null;
  readonly priorityOverride: string | null;
  readonly source?: string | null;
  readonly sourceRef?: string | null;
}

/** The planner wrote `priority` at accept: a planning ticket that no provider fetch has bound yet. */
const plannerWrote = (t: TicketPriorityFields): boolean => t.source === 'planning' && !t.sourceRef;

/** The priority a ticket shows and orders by: the user's override, else the provider's, else none (reads as normal). */
export function effectiveTicketPriority(t: TicketPriorityFields): PriorityLevel | null {
  return asPriorityLevel(t.priorityOverride) ?? asPriorityLevel(t.priority) ?? null;
}

/** Where the effective ticket priority came from; null when the ticket has none. */
export function ticketPrioritySource(t: TicketPriorityFields): 'you' | 'provider' | 'planner' | null {
  if (asPriorityLevel(t.priorityOverride) !== undefined) return 'you';
  if (asPriorityLevel(t.priority) === undefined) return null;
  return plannerWrote(t) ? 'planner' : 'provider';
}

/** The provider's own level in `tickets.priority`; null when none, or when the planner wrote it. */
export function ticketProviderPriority(t: TicketPriorityFields): PriorityLevel | null {
  return plannerWrote(t) ? null : (asPriorityLevel(t.priority) ?? null);
}

/** The word a tooltip uses for the project's ticketing provider (`ClickUp`); `provider` when it has none. */
export function ticketProviderLabel(provider: string | null | undefined): string {
  return provider && provider !== 'manual' ? providerLabel(provider) : 'provider';
}

/** Narrow an untrusted value to a priority level. */
export function asPriorityLevel(v: unknown): PriorityLevel | undefined {
  return PRIORITY_LEVELS.find((l) => l === v);
}
