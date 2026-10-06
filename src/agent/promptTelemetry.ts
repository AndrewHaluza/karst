/**
 * Prompt-effectiveness telemetry helpers for the agent seams.
 *
 * vscode-free: the seed seam measures length + guide-pointer presence HERE; the
 * extension host records the result onto the launch's `process_runs` row through
 * the shared v57 codec (`store/processRuns.ts`, `store/sessionLaunchIntents.ts`).
 * The metric CONTRACT — what each recorded key means and which ticket cites it —
 * is `docs/arch/prompt-metrics.md`; this module is only the shape, never the
 * wording. No prompt text is composed or mutated here.
 */

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
