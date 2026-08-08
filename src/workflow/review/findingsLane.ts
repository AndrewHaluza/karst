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

import type { Store } from '../../store/db.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import type { ReviewFindingsConfig, Severity } from '../../manifest/types.js';
import type { FindingInput } from '../../store/reviewFindings.js';
import { openProcessRun, type ProcessRun } from '../../store/processRuns.js';
import { stageAttempt } from '../../store/stages.js';
import { collapseDiagnostic } from '../../model/diagnosticText.js';
import { nowIso } from '../../model/time.js';
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
  /**
   * `worktrees.base_ref` for this target — the PLAIN branch name, exactly as
   * stored (never `origin/<base>`; consumers derive that themselves, same
   * convention as everywhere else `base_ref` is read). Null/undefined when
   * karst has no worktree row for this target, or none is known yet.
   */
  baseRef?: string | null;
}

/**
 * The Review AI process (Task 8): its immutable assignment snapshot plus the
 * already instrumented adapter, and the process-run bookkeeping the lane needs
 * to open a run. Absent `process` (or an absent `store`) → the lane makes its
 * calls without opening a process run, exactly like a pre-Task-8 caller.
 */
export interface FindingsProcessInput {
  /** The resolved identity SNAPSHOT the process run opens with (Task 7). */
  assignment: ProcessAssignmentSnapshot;
  /** The already instrumented adapter; when present it REPLACES `adapter`. */
  adapter: AgentAdapter;
  /** The stage_runs batch this process runs under, when one was opened. */
  stageRunId?: number | null;
  /** The stage's attempt when the run opens; defaults to the store's value. */
  attempt?: number;
  /** The opening host's pid; absent → unknown, never guessed. */
  pid?: number | null;
  /** Injected clock for the run's `started_at`. */
  startedAt?: string;
}

export interface RunFindingsLaneOpts {
  config: ReviewFindingsConfig;
  /**
   * Absent means no agent core is available to ask — `capability-missing`
   * (spec §8.14), never a failure: this is environmental, not a code defect.
   * When `process` supplies one, it wins over this field.
   */
  adapter?: AgentAdapter;
  targets: readonly FindingsLaneTarget[];
  ticketId: number;
  /** Threaded from the stage run so a Stop reaches a call already in flight (best-effort — see `RunHeadlessOpts.signal`). */
  signal?: AbortSignal;
  warn?: WarnFn;
  /** Required to open the Review process run (Task 8); absent → no run opens. */
  store?: Store;
  /** The Review AI process — opens its run before the first call when present. */
  process?: FindingsProcessInput;
}

/**
 * The request. Strict output rules because the default answer from a
 * chat-tuned model is prose.
 *
 * `baseRef` is the PLAIN branch name (`worktrees.base_ref`), never a doubled
 * `origin/origin/...` — a missing/null ref falls back to the prior, generic
 * wording rather than ever interpolating the literal string "undefined" into
 * a prompt the agent will read. Naming it matters: at the shipped
 * `blockingSeverity: 'high'`, an agent that guesses the wrong range can fail
 * the ticket over a commit that was never part of its diff.
 */
export function buildFindingsPrompt(repo: string, baseRef?: string | null): string {
  const baseClause = baseRef
    ? `against its base branch, \`${baseRef}\` (compare against \`origin/${baseRef}\` when available, otherwise the local \`${baseRef}\`).`
    : `against its base branch.`;
  return [
    `Review the uncommitted and committed changes in this worktree (repository: ${repo}) ${baseClause}`,
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
 *
 * Finding 3: a Stop is an EXPLICIT `{kind:'stopped'}` outcome, checked before
 * AND after every awaited call — never a silently truncated `ran`. The caller
 * (`stages/review.ts`) closes the open process run as interrupted and returns
 * stopped before any aggregation.
 */
export async function runFindingsLane(opts: RunFindingsLaneOpts): Promise<FindingsLaneOutcome> {
  if (!opts.config.enabled) return { kind: 'not-run' };

  const adapter = opts.process?.adapter ?? opts.adapter;
  if (!adapter) {
    return {
      kind: 'capability-missing',
      reason: 'review findings: no agent core is available to ask about the diff',
    };
  }

  // Task 8: opened BEFORE the first call, so the identity snapshot is durable
  // before any token is spent, and only when the lane is actually about to
  // run — a lane skipped by R3–R5 (or disabled, or adapter-less) opens
  // nothing, because no AI call happens.
  let processRun: ProcessRun | null = null;
  if (opts.store && opts.process) {
    processRun = openProcessRun(opts.store, {
      ticketId: opts.ticketId,
      stageKey: 'review',
      processId: 'review',
      attempt: opts.process.attempt ?? stageAttempt(opts.store, opts.ticketId, 'review'),
      stageRunId: opts.process.stageRunId ?? null,
      agentName: opts.process.assignment.agentName ?? null,
      provider: opts.process.assignment.provider,
      model: opts.process.assignment.model ?? null,
      pid: opts.process.pid ?? null,
      startedAt: opts.process.startedAt ?? nowIso(),
    });
  }

  // Finding 3: one stopped outcome, carrying the opened run so the caller can
  // interrupt it. Returns immediately — the user stopped; nothing further is
  // asked and no aggregation may read the lane as a truncated `ran`.
  const stopped = (): FindingsLaneOutcome => {
    const outcome: Extract<FindingsLaneOutcome, { kind: 'stopped' }> = {
      kind: 'stopped',
      reason: 'Review stopped',
    };
    if (processRun !== null) outcome.processRunId = processRun.id;
    return outcome;
  };

  const findings: FindingInput[] = [];
  // One collapsed one-line diagnostic per target whose call THREW — the
  // "the agent looked and found nothing" vs "the agent could not be asked"
  // distinction (Task 8). Never the raw message: it is untrusted CLI prose.
  const crashes: string[] = [];
  for (const target of opts.targets) {
    if (opts.signal?.aborted) return stopped();
    try {
      const result = await adapter.runHeadless({
        prompt: buildFindingsPrompt(target.repo, target.baseRef),
        cwd: target.worktreePath,
        signal: opts.signal,
        tracking: {
          callSite: 'review-findings',
          ticketId: opts.ticketId,
          processRunId: processRun?.id ?? null,
        },
      });
      // The call returned — but if the signal aborted WHILE it ran, the user
      // stopped and its output is not evidence to aggregate.
      if (opts.signal?.aborted) return stopped();
      findings.push(
        ...parseFindings(
          result.raw,
          { repo: target.repo, worktreePath: target.worktreePath, max: opts.config.maxFindings },
          opts.warn,
        ),
      );
    } catch (error) {
      // Residual fix: a rejection that lands ON an aborted signal is the Stop
      // itself — the user cancelled, and the adapter surfaced it as a rejection
      // (AbortError or its own failure type). That is never a crash to degrade
      // into `ran`: a cancelled lane must not read as a review that ran. The
      // SIGNAL is the authority, not the error's shape.
      if (opts.signal?.aborted) return stopped();
      // See the doc comment: a failed/garbage call must not break the stage —
      // degrading to `ran` with no findings for this target is still correct.
      // What changes is that the failure is no longer silent: a missing CLI,
      // a 429, a timeout or a crash all reach `warn` (one line, capped) rather
      // than being indistinguishable from "the agent looked and found
      // nothing" — the call is still billed either way, so the silence was
      // the actual defect, not the degradation.
      const message = collapseDiagnostic(error instanceof Error ? error.message : String(error));
      crashes.push(message);
      opts.warn?.(
        `review findings: ${target.repo} — call failed, contributing no findings: ${message}`,
      );
    }
  }

  // Residual fix: the same rule holds once the loop has ended — a signal that
  // aborted at any point (including a lane with no targets to iterate) is a
  // Stop, never a silently truncated `ran`.
  if (opts.signal?.aborted) return stopped();

  const ran: Extract<FindingsLaneOutcome, { kind: 'ran' }> = { kind: 'ran', findings };
  if (crashes.length > 0) ran.crashes = crashes;
  if (processRun !== null) ran.processRunId = processRun.id;
  return ran;
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
  /** Required to open the Review process run (Task 8); absent → no run opens. */
  store?: Store;
  /** The Review AI process — opens its run before the first call when present. */
  process?: FindingsProcessInput;
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
          store: opts.store,
          process: opts.process,
        })
      : { kind: 'not-run' };
  return { outcome, blockingSeverity: config.blockingSeverity };
}
