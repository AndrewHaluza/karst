/**
 * The dashboard header's `P<n>` link (T1400): the two host calls it makes, and the rule they share.
 *
 * The caller hands the returned promise to the webview as the action's outcome (`reportAction`), so a
 * failure must stay a rejection. Logging it and swallowing it would resolve the promise, and the panel
 * would post `action-result { ok: true }` for a session that never opened (`@ui:UI-R13`).
 */
import type { LogError } from '../../logging/logger.js';

/** The planning sessions the header's `P<n>` link opens — the same ops the sidebar binds. */
export interface DashboardPlanningHost {
  open: (id: number) => Promise<void>;
  openArtifacts: (id: number) => Promise<void>;
}

export interface PlanningLinkActions {
  readonly planOpen: (id: number) => Promise<void>;
  readonly planArtifacts: (id: number) => Promise<void>;
}

/** Log the failure under its own context, then re-throw it so the pending control settles on it. */
function logAndRethrow(logError: LogError, context: string): (e: unknown) => never {
  return (e) => {
    logError(context, e);
    throw e;
  };
}

export function makePlanningLinkActions(host: DashboardPlanningHost, logError: LogError): PlanningLinkActions {
  return {
    planOpen: (id) => host.open(id).catch(logAndRethrow(logError, 'planning: open failed')),
    planArtifacts: (id) => host.openArtifacts(id).catch(logAndRethrow(logError, 'planning: open artifacts failed')),
  };
}
