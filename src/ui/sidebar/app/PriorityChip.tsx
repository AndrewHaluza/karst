/**
 * The sidebar's priority chip: the shared `src/ui/shared/PriorityChip.tsx` (T1396) plus the raised
 * arrow the queue draws when an item waits on this one. TicketRow, QueuePane and PlanDraft keep this
 * component and its props; the shared chip owns the word, the tint and the tooltip.
 */
import type { PriorityLevel } from '../../../planning/proposal.js';
import { PriorityChip as SharedPriorityChip } from '../../shared/PriorityChip.js';
import type { PriorityChipSource, ProviderPriority } from '../../shared/priorityLabels.js';
import { Icon } from './Icon.js';

export interface PriorityChipProps {
  readonly level: PriorityLevel | null | undefined;
  readonly source?: PriorityChipSource | null;
  readonly reason?: string;
  /** A ticket's provider value, so the tooltip can name it beside a user value. */
  readonly provider?: ProviderPriority;
  /** The level was raised by an item that waits on this one: a small up arrow follows the word. */
  readonly raised?: boolean;
}

export function PriorityChip({ level, source, reason, provider, raised }: PriorityChipProps) {
  return (
    <SharedPriorityChip
      level={level}
      source={source}
      reason={reason}
      provider={provider}
      trailing={raised ? <Icon name="arrow-up" size={9} cls="k-pri-up" /> : undefined}
    />
  );
}
