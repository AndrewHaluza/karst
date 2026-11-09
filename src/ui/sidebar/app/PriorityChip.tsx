/**
 * The priority chip: a short level label (URG / HIGH / LOW) after the id. No
 * chip for `normal` or no priority, so most rows stay quiet. The level word is
 * the text, so colour is never the only carrier; the tooltip and the accessible
 * name give the level and who set it (the planner's reason, the provider, or you).
 */
import type { PriorityLevel } from '../../../planning/proposal.js';
import { levelLabel, levelShort, priorityTitle, type PriorityChipSource, type ProviderPriority } from './priority.js';

export interface PriorityChipProps {
  readonly level: PriorityLevel | null | undefined;
  readonly source?: PriorityChipSource | null;
  readonly reason?: string;
  /** A ticket's provider value, so the tooltip can name it beside a user value. */
  readonly provider?: ProviderPriority;
}

export function PriorityChip({ level, source, reason, provider }: PriorityChipProps) {
  if (!level || level === 'normal') return null;
  const title = source ? priorityTitle(level, source, reason, provider) : levelLabel(level);
  return (
    <span className={`k-pri k-pri--${level}`} role="img" aria-label={title} title={title}>
      {levelShort(level)}
    </span>
  );
}
