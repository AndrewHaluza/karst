/**
 * The priority chip: a short level label (URG / HIGH / LOW) after the id. No chip for `normal` or no
 * priority, so most rows stay quiet. The level word is the text, so colour is never the only carrier;
 * the tooltip and the accessible name give the level and who set it (the planner's reason, the
 * provider, or you).
 *
 * Shared by the sidebar rows and the dashboard ticket header (T1396). A provider label that is not a
 * level (`P2`) takes the neutral `k-pri--low` look and its own text. The hint rides `data-tip` (the
 * k-tooltip delegate, @ui:11.18), never a native `title`.
 */
import type { ReactNode } from 'react';
import type { PriorityLevel } from '../../model/priority.js';
import {
  levelLabel,
  levelShort,
  priorityTextTitle,
  priorityTitle,
  type PriorityChipSource,
  type ProviderPriority,
} from './priorityLabels.js';

export interface PriorityChipProps {
  readonly level: PriorityLevel | null | undefined;
  /** A provider's own word when it names no level (`P2`); ignored when a level is known. */
  readonly text?: string | null;
  readonly source?: PriorityChipSource | null;
  readonly reason?: string;
  /** A ticket's provider value, so the tooltip can name it beside a user value. */
  readonly provider?: ProviderPriority;
  /** A node after the word: the sidebar's raised arrow. */
  readonly trailing?: ReactNode;
  readonly id?: string;
}

export function PriorityChip({ level, text, source, reason, provider, trailing, id }: PriorityChipProps) {
  if (level === 'normal') return null;
  if (level) {
    const tip = source ? priorityTitle(level, source, reason, provider) : levelLabel(level);
    return (
      <span id={id} className={`k-pri k-pri--${level}`} role="img" aria-label={tip} data-tip={tip}>
        {levelShort(level)}
        {trailing ?? null}
      </span>
    );
  }
  const word = (text ?? '').trim();
  if (!word || word.toLowerCase() === 'normal') return null;
  const tip = priorityTextTitle(word, source, reason, provider);
  return (
    <span id={id} className="k-pri k-pri--low" role="img" aria-label={tip} data-tip={tip}>
      {word}
      {trailing ?? null}
    </span>
  );
}
