import type { Store } from '../../store/db.js';
import { ticketToastLabel } from '../ticketToastLabel.js';
import { acceptParkedFixRound, retryParkedFixRound, type BlockingSeverityOf, type FixParkExitResult } from '../../workflow/fixParkExit.js';
import type { Notify } from './notify.js';

export interface FixParkDeps {
  store: Store;
  ticketId: number;
  notify: Notify;
  /** Drive the ticket (the trigger Resume uses) after a successful exit. */
  redrive: (ticketId: number) => void | Promise<void>;
  /** Repaint the panel after the action. */
  refresh: () => void;
  /** The manifest blocking severity of each source stage; absent means the defaults. */
  blockingSeverityOf?: BlockingSeverityOf;
  now?: () => string;
}

/**
 * The two user exits of a parked fix round (@arch:AC-66). Both refuse unless the round is
 * parked. On success the host drives the ticket again. On a refusal the user reads the reason.
 */
export function makeFixParkActions(deps: FixParkDeps): {
  fixParkedRetry: () => Promise<void>;
  fixParkedAccept: (note: string) => Promise<void>;
} {
  const { store, ticketId } = deps;
  const finish = async (result: FixParkExitResult, done: (stage: string) => string): Promise<void> => {
    const label = ticketToastLabel(store, ticketId);
    if (result.ok) {
      deps.notify.info(`${label}: ${done(result.stage)}`);
      await deps.redrive(ticketId);
    } else {
      deps.notify.warn(`${label}: ${result.reason}.`);
    }
    deps.refresh();
  };
  const clock = deps.now === undefined ? {} : { now: deps.now };
  return {
    fixParkedRetry: () => finish(retryParkedFixRound(store, ticketId, clock), (s) => `the ${s} gate runs again.`),
    fixParkedAccept: (note) => {
      const trimmed = note.trim();
      return finish(
        acceptParkedFixRound(store, ticketId, trimmed === '' ? null : trimmed, { ...clock, ...(deps.blockingSeverityOf === undefined ? {} : { blockingSeverityOf: deps.blockingSeverityOf }) }),
        (s) => `accepted and moved past the ${s} gate.`,
      );
    },
  };
}
