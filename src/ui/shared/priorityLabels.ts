/**
 * The priority vocabulary both ticket surfaces share (T1396): the four level words, the short chip
 * text, and the tooltip phrasing. It imports the level type from `model/priority` and nothing from a
 * view, so the sidebar and the dashboard phrase a chip identically (the sidebar's menu helpers stay in
 * `sidebar/app/priority.ts`).
 */
import type { PriorityLevel } from '../../model/priority.js';

const LABEL: Record<PriorityLevel, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const SHORT: Record<PriorityLevel, string> = { urgent: 'URG', high: 'HIGH', normal: 'NORM', low: 'LOW' };

export const levelLabel = (level: PriorityLevel): string => LABEL[level];

/** The chip text; `normal` shows no chip, so it has no short form in use. */
export const levelShort = (level: PriorityLevel): string => SHORT[level];

/** Who wrote a chip's level: the user, the planner (a draft) or the ticketing provider (a ticket). */
export type PriorityChipSource = 'you' | 'planner' | 'provider';

/** The provider's own value on a ticket: its label (`ClickUp`) and level (null when it has none). */
export interface ProviderPriority {
  readonly label: string;
  readonly level: PriorityLevel | null;
}

/**
 * `<Level> · planner: "<reason>"`, `<Level> · planner`, `<Level> · <provider label>` or
 * `<Level> · set by you`; a user value that differs from the provider value names both
 * (`High · set by you (ClickUp: Low)`). Also the accessible name.
 */
export function priorityTitle(level: PriorityLevel, source: PriorityChipSource, reason?: string, provider?: ProviderPriority): string {
  if (source === 'provider') return `${LABEL[level]} · ${provider?.label ?? 'provider'}`;
  if (source === 'you') {
    const differs = provider !== undefined && provider.level !== null && provider.level !== level;
    return differs ? `${LABEL[level]} · set by you (${provider.label}: ${LABEL[provider.level]})` : `${LABEL[level]} · set by you`;
  }
  return reason ? `${LABEL[level]} · planner: "${reason}"` : `${LABEL[level]} · planner`;
}

/**
 * The same phrasing for a provider label that is not one of the four levels (`P2`): the text is the
 * word, and the source only says who set it. With no source the text stands alone.
 */
export function priorityTextTitle(
  text: string,
  source?: PriorityChipSource | null,
  reason?: string,
  provider?: ProviderPriority,
): string {
  if (source === 'provider') return `${text} · ${provider?.label ?? 'provider'}`;
  if (source === 'you') return `${text} · set by you`;
  if (source === 'planner') return reason ? `${text} · planner: "${reason}"` : `${text} · planner`;
  return text;
}
