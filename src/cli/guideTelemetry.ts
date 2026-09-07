/**
 * Guide-pull attribution — the single number that gates ticket 12.
 *
 * `karst guide` is invoked BY an agent inside a launched session whose terminal
 * env carries `KARST_TICKET_ID` (always) and — since Task 4 — `KARST_DB` +
 * `KARST_PROVIDER`. We record an attributed `guide-pull` process run on the SAME
 * append-only evidence path (`openProcessRun`) — a new row per pull, never a
 * mutation of the session's own row. Best-effort by construction: attribution
 * must NEVER block or corrupt the guide text the agent came to read, so every
 * caller wraps this in try/catch at the `main.ts` boundary.
 *
 * vscode-free and CLI-safe: opens only the store handed to it, reads only env,
 * and never imports the extension's logger (the debug-logging rule).
 */
import { openProcessRun, finishProcessRun, setProcessRunPromptTelemetry } from '../store/processRuns.js';
import { stageAttempt } from '../store/stages.js';
import type { Store } from '../store/db.js';

export interface GuidePullAttribution {
  dbPath: string | null;
  ticketId: number | null;
  launchId: string | null;
  provider: string | null;
}

/** Read the launch env an agent inherits when it runs `karst guide`. */
export function readGuideAttribution(env: NodeJS.ProcessEnv): GuidePullAttribution {
  const raw = env.KARST_TICKET_ID;
  const ticketId = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
  return {
    dbPath: env.KARST_DB ?? null,
    ticketId,
    launchId: env.KARST_LAUNCH_ID ?? null,
    provider: env.KARST_PROVIDER ?? null,
  };
}

/**
 * Open + close an attributed `guide-pull` run; null when there is no ticket to
 * attribute to. The pull's stage_key is labelled `impl` — the guide pointer rides
 * the fresh seed of a marker-bearing stage, and the metric groups by `provider`
 * (the core), not by stage. The launch id rides in `prompt_telemetry` so the pull
 * can be correlated to the session that was seeded with the pointer.
 */
export function recordGuidePull(
  store: Store,
  a: GuidePullAttribution,
  now: () => string,
): number | null {
  if (a.ticketId === null) return null;
  const run = openProcessRun(store, {
    ticketId: a.ticketId,
    stageKey: 'impl',
    processId: 'guide-pull',
    attempt: stageAttempt(store, a.ticketId, 'impl'),
    provider: a.provider,
    startedAt: now(),
  });
  finishProcessRun(store, run.id, 'passed', now(), 'pull', null);
  setProcessRunPromptTelemetry(store, run.id, { guidePull: true, launchId: a.launchId });
  return run.id;
}
