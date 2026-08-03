/**
 * The findings lane (Lane B) orchestrator — asks an agent core about a
 * target's diff, parses whatever comes back, and reports what R6 needs.
 *
 * Kept separate from `stages/review.ts` (already at ~200 lines) and from
 * `aggregate.ts` (pure, no I/O) on purpose: this is the one place review makes
 * an AI call, and everything about that call — the prompt, the adapter
 * boundary, the failure handling — lives here so both of the other two stay
 * exactly what their doc comments already claim to be.
 */

import type { AgentAdapter } from '../../agent/adapter.js';
import type { ReviewFindingsConfig, Severity } from '../../manifest/types.js';
import type { FindingInput } from '../../store/reviewFindings.js';
import { collapseDiagnostic } from '../../model/diagnosticText.js';
import { parseFindings, type WarnFn } from './findings.js';
import {
  gatesOutcomeBeforeFindings,
  DEFAULT_REVIEW_FINDINGS,
  type AggregateEntry,
  type FindingsLaneOutcome,
} from './aggregate.js';

/** One target the lane asks about — the same shape `runReview` already plans. */
export interface FindingsLaneTarget {
  repo: string;
  /** The repository's worktree root; both the call's `cwd` and `parseFindings`'s containment root. */
  worktreePath: string;
}

export interface RunFindingsLaneOpts {
  config: ReviewFindingsConfig;
  /**
   * Absent means no agent core is available to ask — `capability-missing`
   * (spec §8.14), never a failure: this is environmental, not a code defect.
   */
  adapter?: AgentAdapter;
  targets: readonly FindingsLaneTarget[];
  ticketId: number;
  /** Threaded from the stage run so a Stop reaches a call already in flight (best-effort — see `RunHeadlessOpts.signal`). */
  signal?: AbortSignal;
  warn?: WarnFn;
}

/** The request. Strict output rules because the default answer from a chat-tuned model is prose. */
export function buildFindingsPrompt(repo: string): string {
  return [
    `Review the uncommitted and committed changes in this worktree (repository: ${repo}) against its base branch.`,
    `Report findings about the DIFF ONLY — code you did not touch is out of scope, however wrong it looks.`,
    ``,
    `Output rules (strict):`,
    `- Output ONLY a JSON array, nothing else: no preamble, no markdown fence, no commentary.`,
    `- Each element: {"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "detail": string, "file"?: string, "line"?: number}.`,
    `- "file" must be a path RELATIVE to this worktree's root — never absolute, never outside it.`,
    `- "title" is one short sentence; "detail" carries the explanation.`,
    `- No changes worth reporting → output exactly [].`,
    `- Use "critical" only for something that will break in production (data loss, security, crash); "high" for a real bug or a clear regression; "medium"/"low"/"info" for style, maintainability, or a suggestion.`,
  ].join('\n');
}

/**
 * Run the lane for every target and combine what each one reported. Never
 * throws: a target whose call failed, timed out, or answered in prose simply
 * contributes no findings for that target (`parseFindings` already returns
 * `[]` for garbage, and a thrown error is caught here) — the run as a whole
 * still reaches `{kind:'ran', findings}`, so the stage's verdict is decided
 * from its gates (R7/R9), never broken by this lane. `capability-missing` is
 * reserved for the one case that IS environmental: no adapter to call at all.
 */
export async function runFindingsLane(opts: RunFindingsLaneOpts): Promise<FindingsLaneOutcome> {
  if (!opts.config.enabled) return { kind: 'not-run' };

  if (!opts.adapter) {
    return {
      kind: 'capability-missing',
      reason: 'review findings: no agent core is available to ask about the diff',
    };
  }
  const adapter = opts.adapter;

  const findings: FindingInput[] = [];
  for (const target of opts.targets) {
    if (opts.signal?.aborted) break;
    try {
      const result = await adapter.runHeadless({
        prompt: buildFindingsPrompt(target.repo),
        cwd: target.worktreePath,
        signal: opts.signal,
        tracking: { callSite: 'review-findings', ticketId: opts.ticketId },
      });
      findings.push(
        ...parseFindings(
          result.raw,
          { repo: target.repo, worktreePath: target.worktreePath, max: opts.config.maxFindings },
          opts.warn,
        ),
      );
    } catch (error) {
      // See the doc comment: a failed/garbage call must not break the stage —
      // degrading to `ran` with no findings for this target is still correct.
      // What changes is that the failure is no longer silent: a missing CLI,
      // a 429, a timeout or a crash all reach `warn` (one line, capped) rather
      // than being indistinguishable from "the agent looked and found
      // nothing" — the call is still billed either way, so the silence was
      // the actual defect, not the degradation.
      const message = error instanceof Error ? error.message : String(error);
      opts.warn?.(
        `review findings: ${target.repo} — call failed, contributing no findings: ${collapseDiagnostic(message)}`,
      );
    }
  }

  return { kind: 'ran', findings };
}

export interface PlanAndRunFindingsLaneOpts {
  entries: readonly AggregateEntry[];
  targets: readonly FindingsLaneTarget[];
  /** `opts.manifest?.review?.findings` — undefined falls back to the human-decided default. */
  findingsConfig?: ReviewFindingsConfig;
  adapter?: AgentAdapter;
  ticketId: number;
  signal?: AbortSignal;
  warn?: WarnFn;
}

/**
 * The whole findings-lane decision `stages/review.ts` needs, in one call:
 * resolve the config default, ask `gatesOutcomeBeforeFindings` whether R3–R5
 * already decided the run (skip the AI call entirely if so, spec §8.14), and
 * run the lane otherwise. Kept out of `stages/review.ts` (already at its line
 * budget) so that file states no rule of its own — it only wires.
 */
export async function planAndRunFindingsLane(
  opts: PlanAndRunFindingsLaneOpts,
): Promise<{ outcome: FindingsLaneOutcome; blockingSeverity: Severity | 'none' }> {
  const config = opts.findingsConfig ?? DEFAULT_REVIEW_FINDINGS;
  const prior = gatesOutcomeBeforeFindings(opts.entries);
  const outcome: FindingsLaneOutcome =
    prior === null
      ? await runFindingsLane({
          config,
          adapter: opts.adapter,
          targets: opts.targets,
          ticketId: opts.ticketId,
          signal: opts.signal,
          warn: opts.warn,
        })
      : { kind: 'not-run' };
  return { outcome, blockingSeverity: config.blockingSeverity };
}
