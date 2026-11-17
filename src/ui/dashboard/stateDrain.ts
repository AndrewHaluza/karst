import { formatId } from '../../model/entityId.js';
import type { DashboardDrain, DrainRunKind } from './stateTypes.js';

/** The host's drain as the state builder receives it: runs name tickets by id, the builder words the label. */
export interface DrainInput {
  readonly draining: boolean;
  readonly live: readonly { readonly ticketId: number | null; readonly kind: DrainRunKind }[];
  readonly held: readonly number[];
}

export const IDLE_DRAIN_INPUT: DrainInput = { draining: false, live: [], held: [] };

/** What a run with no ticket (a host gate re-run) is called in the banner. */
export const HOST_RUN_LABEL = 'host';

/** The serializable drain view of one snapshot. A new object: the input is never mutated. */
export function drainView(input: DrainInput): DashboardDrain {
  if (!input.draining) return { draining: false, live: [], held: [] };
  return {
    draining: true,
    live: input.live.map((r) => ({ ticketKey: r.ticketId === null ? HOST_RUN_LABEL : formatId('ticket', r.ticketId), kind: r.kind })),
    held: [...input.held],
  };
}
