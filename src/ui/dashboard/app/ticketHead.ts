/** Pure derivations for the persistent ticket header (`data-region="ticket-head"`): the status chip and the full identity string. */
export type StatusTone = 'passed' | 'running' | 'attention' | 'info';

export interface TicketStatus {
  readonly word: string;
  readonly tone: StatusTone;
}

export interface StatusInput {
  readonly stageCurrent: string | null | undefined;
  readonly paused: boolean;
  readonly agentState: string | null;
}

/**
 * One word for where the ticket is: finished beats paused beats "needs you".
 * Running and idle are the runtime strip's states (it owns the agent state), so they give no pill.
 */
export function ticketStatus(t: StatusInput): TicketStatus | null {
  if (t.stageCurrent === 'closed') return { word: 'Closed', tone: 'info' };
  if (t.stageCurrent === 'done') return { word: 'Done', tone: 'passed' };
  if (t.paused) return { word: 'Paused', tone: 'attention' };
  if (t.agentState === 'waiting' || t.agentState === 'not-started') return { word: 'Needs you', tone: 'attention' };
  return null;
}

/** `T<id> · KEY · Title`: the string every tier keeps in `title=` and the accessible name. */
export function ticketIdentityText(idLabel: string, key: string, title: string): string {
  return [idLabel, key, title].filter((part) => part !== '').join(' · ');
}
