import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import type { AgentProvider } from '../../manifest/types.js';
import { isInteractiveQuota } from '../../agent/interactiveQuota.js';
import { insertOpenPark, listOpenParks } from '../../store/usageLimitParks.js';

/** One provider-error signal from a live interactive session (D160). */
export interface InteractiveSignal {
  ticketId: number;
  sessionId: string;
  provider: AgentProvider;
  model: string | null;
  /** The ticket's current stage; null for planning/setup sessions. */
  stage: StageKey | null;
  text: string;
}

export interface RecordInteractiveDeps {
  store: Store;
  /** Raise the Pick / Retry same / Dismiss prompt for a NEW park. */
  offer: (parkId: number, signal: InteractiveSignal) => void;
}

/**
 * Park an interactive session that hit its usage limit. Returns the park id, or
 * null when the text is not a quota verdict. The prompt is offered only when no
 * open row existed for this ticket+stage+session, so a repeated signal never
 * duplicates the row or the prompt.
 */
export function recordInteractiveUsageLimit(
  deps: RecordInteractiveDeps,
  signal: InteractiveSignal,
): number | null {
  if (!isInteractiveQuota(signal.provider, signal.text)) return null;
  const alreadyOpen = listOpenParks(deps.store, signal.ticketId).some(
    (p) => p.kind === 'interactive' && p.stage === signal.stage && p.sessionId === signal.sessionId,
  );
  const id = insertOpenPark(deps.store, {
    ticketId: signal.ticketId,
    stage: signal.stage,
    kind: 'interactive',
    lane: null,
    target: null,
    sessionId: signal.sessionId,
    provider: signal.provider,
    model: signal.model,
    detail: signal.text,
  });
  if (!alreadyOpen) deps.offer(id, signal);
  return id;
}
