/**
 * The priority chip: a short level label (URG / HIGH / LOW) after the id. No
 * chip for `normal` or no priority, so most rows stay quiet. The level word is
 * the text, so colour is never the only carrier; the tooltip and the accessible
 * name give the level and who set it (the planner's reason, or you).
 */
import type { PriorityLevel } from '../../../planning/proposal.js';
import type { PriorityView } from '../state.js';
import { levelShort, priorityTitle } from './priority.js';

export interface PriorityChipProps {
  readonly level: PriorityLevel | null | undefined;
  readonly source?: PriorityView['source'] | 'ticket';
  readonly reason?: string;
}

export function PriorityChip({ level, source = 'you', reason }: PriorityChipProps) {
  if (!level || level === 'normal') return null;
  const title = priorityTitle(level, source, reason);
  return (
    <span className={`k-pri k-pri--${level}`} role="img" aria-label={title} title={title}>
      {levelShort(level)}
    </span>
  );
}
