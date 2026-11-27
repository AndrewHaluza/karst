/**
 * Priority vocabulary of the sidebar view: the four levels, the "Priority ▸" submenu entry, and
 * re-exports of the shared labels and tooltip phrasing (now in `src/ui/shared/priorityLabels.ts`, so
 * the dashboard header phrases a chip identically — T1396). The host owns the truth (it validates every
 * level); this file only phrases it.
 */
import type { PriorityLevel } from '../../../planning/proposal.js';
import { levelLabel } from '../../shared/priorityLabels.js';
import type { ActionSpec } from './action.js';
import type { MenuItem } from './SidebarContext.js';

export {
  levelLabel,
  levelShort,
  priorityTitle,
  type PriorityChipSource,
  type ProviderPriority,
} from '../../shared/priorityLabels.js';

/** Menu order, most urgent first. Mirrors `PRIORITY_LEVELS` (the bundle imports no host value). */
export const LEVELS: readonly PriorityLevel[] = ['urgent', 'high', 'normal', 'low'];

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
    label: levelLabel(level),
    icon: '',
    checked: level === current,
  }));
  const clear: MenuItem = { key: 'priority-clear', spec: specFor(target, 'clear'), label: 'Clear', icon: '', divider: true };
  return { key: 'priority', spec: {}, label: 'Priority', icon: 'chevrons-up', title: 'Set the priority', submenu: [...levels, clear] };
}
