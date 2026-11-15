/**
 * Host binding logic for the auto impl marker (@arch:IMPLUAT): run the CLI's
 * docs block cap check, fire the guarded marker for a marker-ready graph run,
 * then hand the ticket to the driver and refresh the views. vscode-free;
 * `extension.ts` only wires it.
 */

import type { Store } from '../../store/db.js';
import type { GitRunner } from '../../integrations/git.js';
import { tryAutoFireGraphImplMarker } from '../../workflow/graphMarkerGuard.js';
import { defaultGitRunner } from '../../integrations/git.js';
import { runDocsLint } from '../../cli/docsLintRunner.js';
import { assertDocsBlocksWithinCap, type DocsLintRunner } from '../../workflow/docsBlockGuard.js';

export interface AutoMarkerDeps {
  store: Store;
  git?: GitRunner;
  runLint?: DocsLintRunner;
  debug: (message: string) => void;
  drive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  now?: () => string;
}

const REFUSAL_PREFIX = 'cannot mark this stage done';
/** Runs with a check in flight: the flip and the sweep must not race one run. */
const inFlight = new Set<number>();

/** The docs block cap refusal, or undefined. A lint that cannot run is no verdict. */
async function docsRefusal(deps: AutoMarkerDeps, ticketId: number): Promise<string | undefined> {
  try {
    await assertDocsBlocksWithinCap(deps.store, ticketId, deps.git ?? defaultGitRunner, deps.runLint ?? runDocsLint);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(REFUSAL_PREFIX)) return e.message;
    deps.debug(`[graph] auto impl marker: docs lint probe unavailable: ${String(e)}`);
  }
  return undefined;
}

export async function autoFireImplMarker(
  deps: AutoMarkerDeps,
  ticketId: number,
  graphRunId: number,
): Promise<void> {
  if (inFlight.has(graphRunId)) return;
  inFlight.add(graphRunId);
  try {
    const outcome = tryAutoFireGraphImplMarker(
      deps.store,
      ticketId,
      graphRunId,
      deps.now ?? (() => new Date().toISOString()),
      await docsRefusal(deps, ticketId),
    );
    if (outcome.kind === 'fired') {
      deps.debug(`[graph] run ${graphRunId}: auto impl marker fired`);
      deps.drive(ticketId);
    } else if (outcome.kind === 'refused' && outcome.firstTime) {
      deps.debug(`[graph] run ${graphRunId}: auto impl marker refused — ${outcome.reason}`);
    }
    // Refresh only on a change: a parked run that stays refused costs no repaint per sweep.
    if (outcome.kind === 'fired' || ((outcome.kind === 'refused' || outcome.kind === 'paused') && outcome.firstTime)) {
      deps.refresh(ticketId);
    }
  } catch (e) {
    deps.debug(`[graph] run ${graphRunId}: auto impl marker failed — ${String(e)}`);
  } finally {
    inFlight.delete(graphRunId);
  }
}
