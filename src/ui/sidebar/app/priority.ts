/**
 * Priority vocabulary of the sidebar view: the four levels, their labels, the
 * chip text and tooltip, and the "Priority ▸" submenu entry. The host owns the
 * truth (it validates every level); this file only phrases it.
 */
import type { PriorityLevel } from '../../../planning/proposal.js';
import type { PriorityView } from '../state.js';
import type { ActionSpec } from './action.js';
import type { MenuItem } from './SidebarContext.js';

/** Menu order, most urgent first. Mirrors `PRIORITY_LEVELS` (the bundle imports no host value). */
export const LEVELS: readonly PriorityLevel[] = ['urgent', 'high', 'normal', 'low'];

const LABEL: Record<PriorityLevel, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const SHORT: Record<PriorityLevel, string> = { urgent: 'URG', high: 'HIGH', normal: 'NORM', low: 'LOW' };

export const levelLabel = (level: PriorityLevel): string => LABEL[level];

/** The chip text; `normal` shows no chip, so it has no short form in use. */
export const levelShort = (level: PriorityLevel): string => SHORT[level];

/** Who wrote a chip's level: the user, the planner (a draft) or the ticketing provider (a ticket). */
export type PriorityChipSource = PriorityView['source'] | 'provider';

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

/** Where a priority change goes: a pending draft (`proposal`) or a ticket at scope (`id`). */
export type PriorityTarget = { readonly proposal: number } | { readonly ticket: number };

function specFor(target: PriorityTarget, level: PriorityLevel | 'clear'): ActionSpec {
  return 'proposal' in target
    ? { act: 'plan-proposal-priority', proposal: target.proposal, level }
    : { act: 'set-priority', id: target.ticket, level };
}

/** The row menu's "Priority ▸" entry: four levels (a check on the current one), a separator, Clear. */
export function priorityMenuItem(target: PriorityTarget, current: PriorityLevel | null): MenuItem {
  const levels: MenuItem[] = LEVELS.map((level) => ({
    key: `priority-${level}`,
    spec: specFor(target, level),
    label: LABEL[level],
    icon: '',
    checked: level === current,
  }));
  const clear: MenuItem = { key: 'priority-clear', spec: specFor(target, 'clear'), label: 'Clear', icon: '', divider: true };
  return { key: 'priority', spec: {}, label: 'Priority', icon: 'chevrons-up', title: 'Set the priority', submenu: [...levels, clear] };
}
