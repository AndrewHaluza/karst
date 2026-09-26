import type { StageKey } from '../../model/types.js';

/** The subset of a ticket row this resolver reads. */
export interface StageArtifactTicket {
  stages: ReadonlyArray<{ stageKey: string; artifactPath?: string | null }>;
}

/**
 * Resolve one stage's recorded log artifact path from the ticket the host
 * owns, or `null` when the stage is unknown or has no artifact.
 *
 * The stage key (or a whole path, before this existed) arrives from a webview,
 * so the path is RE-DERIVED here from the store row and never taken from the
 * message: a crafted message can only miss, leaving `Uri.file` unreachable
 * from webview input (the same trust rule as `openArtifactResource`).
 */
export function resolveStageLogPath(
  readTicket: (ticketId: number) => StageArtifactTicket,
  ticketId: number,
  stageKey: StageKey,
): string | null {
  try {
    const artifact =
      readTicket(ticketId).stages.find((s) => s.stageKey === stageKey)?.artifactPath ?? null;
    return artifact !== null && artifact.length > 0 ? artifact : null;
  } catch {
    return null;
  }
}
