/**
 * Prompt-effectiveness telemetry helpers for the agent seams.
 *
 * vscode-free and (aside from the store codec it re-exports) free of the
 * extension host: the seed seam measures length + guide-pointer presence HERE,
 * and the host records the result onto the launch's `process_runs` row through
 * the shared v57 codec. The metric CONTRACT — what each recorded key means and
 * which ticket cites it — is `docs/arch/prompt-metrics.md`; this module is only
 * the shape, never the wording. No prompt text is composed or mutated here.
 */
import { mergePromptTelemetry, setProcessRunPromptTelemetry } from '../store/processRuns.js';
import type { PromptTelemetry } from '../store/processRuns.js';
import type { Store } from '../store/db.js';

/**
 * The marker sentence `renderGuideInstruction` emits (`cli/guide.ts`). Its
 * presence in a seed is the guide-pull DENOMINATOR: a session seeded with the
 * pointer is one whose agent was invited to `karst guide`. Matched on the stable
 * prefix, never the composed command, so the check survives a cliEntry change.
 */
export const GUIDE_POINTER_MARKER = 'To understand how Karst works and what this CLI can do, run';

/** Composed seed length in characters; a bare launch (`undefined`) is 0. */
export function seedCharLength(seed: string | undefined): number {
  return seed?.length ?? 0;
}

/** Whether the guide pointer rode the seed (the guide-pull denominator). */
export function seedHasGuide(seed: string | undefined, marker: string = GUIDE_POINTER_MARKER): boolean {
  return typeof seed === 'string' && seed.includes(marker);
}

/** The `prompt_telemetry` shape stored on the launch `session` process run. */
export interface SeedPromptTelemetry extends PromptTelemetry {
  seedChars: number;
  guidePointer: boolean;
  core: string | null;
}

/**
 * Record a session launch's seed length + guide-pointer presence onto its run.
 * A single `setProcessRunPromptTelemetry` merge on the existing append-only
 * evidence path — no second row, no new writer.
 */
export function recordSeedTelemetry(
  store: Store,
  runId: number,
  seed: string | undefined,
  core: string | null,
): void {
  const telemetry: SeedPromptTelemetry = {
    seedChars: seedCharLength(seed),
    guidePointer: seedHasGuide(seed),
    core,
  };
  setProcessRunPromptTelemetry(store, runId, telemetry);
}

// Re-exported so every seam serializes through one prompt_telemetry codec.
export { mergePromptTelemetry, setProcessRunPromptTelemetry };
