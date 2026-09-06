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
import type { HeadlessOutputChunk } from '../../agent/headlessSpawn.js';
import type { GitRunner } from '../../integrations/git.js';
import type { ReviewFindingsConfig, Severity } from '../../manifest/types.js';
import type { FindingInput } from '../../store/reviewFindings.js';
import { GATE_LANE_HEADLESS_TIMEOUT_MS } from '../../agent/headlessSpawn.js';
import { openProcessRun, type ProcessRun } from '../../store/processRuns.js';
import { stageAttempt } from '../../store/stages.js';
import { collapseDiagnostic } from '../../model/diagnosticText.js';
import { nowIso } from '../../model/time.js';
import { parseFindingsResult, type WarnFn } from './findings.js';
import { buildScopeBlock } from '../agentScope.js';
import { createReviewSnapshot, deleteReviewSnapshot } from '../reviewSnapshot.js';
import { dropDisprovenCheckoutClaims, isWrongCheckoutClaim, verifyCheckout } from './checkoutClaim.js';
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
  /**
   * `worktrees.branch` for this target — the ticket's own branch. Naming it in
   * the scope block makes the diff range `origin/<base>...<branch>`, which
   * resolves by branch name and reads the same from any checkout of the repo —
   * a worktree on the base branch no longer reads as "no changes" (fu1).
   */
  branch?: string | null;
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
  /**
   * The hard deadline for EACH headless call, in milliseconds. Absent → the
   * generous gate-lane bound (`GATE_LANE_HEADLESS_TIMEOUT_MS`): a deep review
   * verifies suspicions against the repo (test runs, typecheck), which can
   * take far longer than the 15-minute quick-call default.
   */
  timeoutMs?: number;
  warn?: WarnFn;
  /** Required to open the Review process run (Task 8); absent → no run opens. */
  store?: Store;
  /** The Review AI process — opens its run before the first call when present. */
  process?: FindingsProcessInput;
  /**
   * Persist one target's findings the instant that target's call returns —
   * completed model output is already paid for, and a host restart before the
   * lane's last target would otherwise throw every earlier target's findings
   * away with it. Called per target, before anything is aggregated; the caller
   * (review's evidence handle) owns the store write. Absent → the lane stays a
   * pure collector, exactly like a pre-durability caller.
   */
  persistFindings?: (findings: readonly FindingInput[], processRunId?: number | null) => void;
  /**
   * Live-output hook, forwarded verbatim to every `adapter.runHeadless` call
   * (each target asks its own call). RAW untrusted CLI prose — the caller
   * that surfaces it (the console tail) must bound and sanitize it. Absent →
   * no live chunks; the findings still parse from the settled output.
   */
  onOutput?: (chunk: HeadlessOutputChunk) => void;
  /**
   * Per-target progress (Task 13 mirror): called before each target's call
   * (`status: 'active'`) and after it returns (`status: 'completed'`, with a
   * one-line detail naming what came back). Lets the host push the same
   * inside-progress overlay the gates use, so the dashboard header tracks a
   * multi-target lane even with the console closed. Absent → no events.
   */
  onTargetProgress?: (event: {
    repo: string;
    status: 'active' | 'completed';
    detail?: string;
  }) => void;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[gate]` — the
   * lane is part of the Review stage flow, so its lines ride the same stream
   * the stage's own debug lines use. Absent → no debug lines; the stage
   * threads its `RunReviewOpts.debug` here, and the host binds that to
   * `Logger.debug` (a no-op unless the manifest's `debug` flag is on).
   * The prompt is never logged — only counts, names and outcomes.
   */
  debug?: (message: string) => void;
  /**
   * Whether the agent should also read uncommitted working-tree changes
   * (`review.openChanges`, default OFF). Threaded into `buildFindingsPrompt`
   * so the prompt's instructions agree with the configured behavior — the
   * three-way contradiction that caused review non-convergence (Issue #2).
   */
  openChanges?: boolean;
  /**
   * Injected git runner for snapshot creation when `openChanges` is on
   * (`workflow/reviewSnapshot.ts`). Absent → no snapshot, falls back to
   * today's branch range + "plus any uncommitted work" prose.
   */
  git?: GitRunner;
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
 * the ticket over a commit that was never part of its diff. `instructions`
 * (optional) replaces the review strategy lines with the author's own — the
 * target context and the strict output rules always remain.
 */
export function buildFindingsPrompt(
  repo: string,
  baseRef?: string | null,
  branch?: string | null,
  instructions?: string,
  openChanges?: boolean,
  snapshotRef?: string | null,
  /** The worktree root the call runs in — named so an agent whose core
   *  mis-resolved the launch cwd can move itself there (see `agentScope.ts`). */
  worktreePath?: string | null,
): string {
  const baseClause = baseRef
    ? `against its base branch, \`${baseRef}\` (compare against \`origin/${baseRef}\` when available, otherwise the local \`${baseRef}\`).`
    : `against its base branch.`;
  // `openChanges` (default OFF) controls whether the agent reads uncommitted
  // work. When OFF, the agent reviews committed changes ONLY — the three-way
  // contradiction that caused review non-convergence (Issue #2) was one prompt
  // saying "uncommitted and committed", another saying "read that diff" over a
  // committed-only range, and a third saying "never output [] because a diff
  // came back empty". Two reviewers obeyed different instructions; both were
  // compliant. Now all three lines agree: OFF → committed only.
  const changesPhrase = openChanges
    ? 'uncommitted and committed changes'
    : 'committed changes (the diff against the base branch — do NOT review uncommitted working-tree changes)';
  // User instructions REPLACE the role/scope block; the target context line
  // and the output rules below are never replaced.
  const instructionsText = instructions?.trim() ?? '';
  const strategy =
    instructionsText.length > 0
      ? [instructionsText, `Repository: ${repo} ${baseClause}`, '']
      : [
          `Review the ${changesPhrase} in this worktree (repository: ${repo}) ${baseClause}`,
          `Report findings about the DIFF ONLY — code you did not touch is out of scope, however wrong it looks.`,
          ``,
        ];
  return [
    ...strategy,
    // Never replaced by `instructions`: an author overriding the strategy is
    // choosing WHAT to look for, not licensing a repo-wide sweep before it.
    ...buildScopeBlock('review', { baseRef, branch, openChanges, snapshotRef, worktreePath }),
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
  const debug = opts.debug;
  if (!opts.config.enabled) {
    debug?.(`[gate] review findings ticket ${opts.ticketId}: disabled — not run`);
    return { kind: 'not-run' };
  }

  const adapter = opts.process?.adapter ?? opts.adapter;
  if (!adapter) {
    debug?.(
      `[gate] review findings ticket ${opts.ticketId}: no agent core available — capability-missing`,
    );
    return {
      kind: 'capability-missing',
      reason: 'review findings: no agent core is available to ask about the diff',
    };
  }

  debug?.(
    `[gate] review findings ticket ${opts.ticketId}: starting — ${opts.targets.length} target(s), ` +
      `blockingSeverity ${opts.config.blockingSeverity}, max ${opts.config.maxFindings}`,
  );
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
    debug?.(
      `[gate] review findings ticket ${opts.ticketId}: process run ${processRun.id} opened ` +
        `(${opts.process.assignment.agentName ?? '?'}/${opts.process.assignment.provider}` +
        (opts.process.assignment.model ? `/${opts.process.assignment.model}` : '') + ')',
    );
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
  // Repos whose call returned output no findings-shaped container could be
  // read out of (`shape: 'unreadable'`) — distinct from a target that
  // answered cleanly with nothing to report.
  const unreadable: string[] = [];
  const snapshotted: { repo: string; worktreePath: string }[] = [];
  try {
    for (const target of opts.targets) {
      if (opts.signal?.aborted) {
        debug?.(`[gate] review findings ticket ${opts.ticketId}: stopped before asking`);
        return stopped();
      }
      debug?.(
        `[gate] review findings ticket ${opts.ticketId}: asking target ${target.repo} ` +
          `(worktree ${target.worktreePath})`,
      );
      opts.onTargetProgress?.({ repo: target.repo, status: 'active' });
      try {
        const snapshotRef =
          opts.openChanges && opts.git
            ? await createReviewSnapshot(opts.git, {
                ticketId: opts.ticketId,
                repoPath: target.repo,
                worktreePath: target.worktreePath,
                debug: opts.debug,
              })
            : null;
        if (snapshotRef !== null) {
          snapshotted.push({ repo: target.repo, worktreePath: target.worktreePath });
        }
        debug?.(
          `[gate] review findings ticket ${opts.ticketId}: target ${target.repo} snapshot ` +
            `${snapshotRef ?? 'unavailable — using the branch range'}`,
        );
        const result = await adapter.runHeadless({
          prompt: buildFindingsPrompt(
            target.repo,
            target.baseRef,
            target.branch,
            opts.process?.assignment.instructions,
            opts.openChanges,
            snapshotRef,
            target.worktreePath,
          ),
          cwd: target.worktreePath,
          model: opts.process?.assignment.model,
          effort: opts.process?.assignment.effort,
          signal: opts.signal,
          timeoutMs: opts.timeoutMs ?? GATE_LANE_HEADLESS_TIMEOUT_MS,
          onOutput: opts.onOutput,
          tracking: {
            callSite: 'review-findings',
            ticketId: opts.ticketId,
            processRunId: processRun?.id ?? null,
          },
        });
        if (opts.signal?.aborted) {
          debug?.(`[gate] review findings ticket ${opts.ticketId}: stopped during a call`);
          return stopped();
        }
        const { findings: rawFindings, shape } = parseFindingsResult(
          result.raw,
          { repo: target.repo, worktreePath: target.worktreePath, max: opts.config.maxFindings },
          opts.warn,
        );
        if (shape === 'unreadable') unreadable.push(target.repo);
        // The ONE claim the host can check for itself (`checkoutClaim.ts`).
        // Checked BEFORE persisting: a disproven critical that reaches the
        // store outlives the run — the fix stage is handed it again on every
        // later attempt, so dropping it afterwards would fix nothing. The probe
        // runs only when a claim was actually made, so the normal path pays no
        // git call.
        let parsed = rawFindings;
        if (target.branch && opts.git && rawFindings.some(isWrongCheckoutClaim)) {
          const verdict = await verifyCheckout(opts.git, target.worktreePath, target.branch);
          debug?.(
            `[gate] review findings ticket ${opts.ticketId}: target ${target.repo} claimed a wrong ` +
              `checkout — host says '${verdict}' for branch '${target.branch}'`,
          );
          parsed = dropDisprovenCheckoutClaims(rawFindings, verdict, {
            branch: target.branch,
            repo: target.repo,
            warn: opts.warn,
          });
        }
        if (parsed.length > 0) opts.persistFindings?.(parsed, processRun?.id ?? null);
        debug?.(
          `[gate] review findings ticket ${opts.ticketId}: target ${target.repo} returned ` +
            `${parsed.length} finding(s)`,
        );
        opts.onTargetProgress?.({
          repo: target.repo,
          status: 'completed',
          detail: `${parsed.length} finding${parsed.length === 1 ? '' : 's'}`,
        });
        findings.push(...parsed);
      } catch (error) {
        if (opts.signal?.aborted) {
          debug?.(`[gate] review findings ticket ${opts.ticketId}: stopped during a call`);
          return stopped();
        }
        const message = collapseDiagnostic(error instanceof Error ? error.message : String(error));
        crashes.push(message);
        debug?.(
          `[gate] review findings ticket ${opts.ticketId}: target ${target.repo} call failed (${message})`,
        );
        opts.warn?.(
          `review findings: ${target.repo} — call failed, contributing no findings: ${message}`,
        );
      }
    }
    if (opts.signal?.aborted) {
      debug?.(`[gate] review findings ticket ${opts.ticketId}: stopped after the last target`);
      return stopped();
    }

    debug?.(
      `[gate] review findings ticket ${opts.ticketId}: ran with ${findings.length} finding(s)` +
        (crashes.length > 0 ? `, ${crashes.length} target(s) failed to answer` : ''),
    );
    const ran: Extract<FindingsLaneOutcome, { kind: 'ran' }> = {
      kind: 'ran',
      findings,
      targetCount: opts.targets.length,
    };
    if (crashes.length > 0) ran.crashes = crashes;
    if (unreadable.length > 0) ran.unreadable = unreadable;
    if (processRun !== null) ran.processRunId = processRun.id;
    return ran;
  } finally {
    if (opts.openChanges && opts.git) {
      for (const s of snapshotted) {
        await deleteReviewSnapshot(opts.git, {
          ticketId: opts.ticketId,
          repoPath: s.repo,
          worktreePath: s.worktreePath,
          debug: opts.debug,
        });
      }
    }
  }
}

export interface PlanAndRunFindingsLaneOpts {
  entries: readonly AggregateEntry[];
  targets: readonly FindingsLaneTarget[];
  /** `opts.manifest?.review?.findings` — undefined falls back to the human-decided default. */
  findingsConfig?: ReviewFindingsConfig;
  adapter?: AgentAdapter;
  git?: GitRunner;
  ticketId: number;
  signal?: AbortSignal;
  /** Hard deadline per headless call — see `RunFindingsLaneOpts.timeoutMs`. */
  timeoutMs?: number;
  warn?: WarnFn;
  /** Required to open the Review process run (Task 8); absent → no run opens. */
  store?: Store;
  /** The Review AI process — opens its run before the first call when present. */
  process?: FindingsProcessInput;
  /** Persist each target's findings as its call lands (see `RunFindingsLaneOpts`). */
  persistFindings?: (findings: readonly FindingInput[], processRunId?: number | null) => void;
  /** Live-output hook — see `RunFindingsLaneOpts.onOutput`; threaded into the lane it runs. */
  onOutput?: (chunk: HeadlessOutputChunk) => void;
  /** Per-target progress — see `RunFindingsLaneOpts.onTargetProgress`; threaded into the lane it runs. */
  onTargetProgress?: (event: {
    repo: string;
    status: 'active' | 'completed';
    detail?: string;
  }) => void;
  /** Verbose decision-point logging (§ debug logging) — threaded into the lane it runs. */
  debug?: (message: string) => void;
  /** Whether the agent reads uncommitted changes — see `RunFindingsLaneOpts.openChanges`. */
  openChanges?: boolean;
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
  if (prior !== null) {
    opts.debug?.(
      `[gate] review findings ticket ${opts.ticketId}: gates already decided the run ` +
        `(${prior.kind === 'blocked' ? 'nothing ran or was unreadable' : `verdict ${prior.verdict.kind}`}) ` +
        `— lane skipped`,
    );
  } else {
    opts.debug?.(
      `[gate] review findings ticket ${opts.ticketId}: gates left the outcome undecided — ` +
        `running the lane (blockingSeverity ${config.blockingSeverity})`,
    );
  }
  const outcome: FindingsLaneOutcome =
    prior === null
      ? await runFindingsLane({
          config,
          adapter: opts.adapter,
          targets: opts.targets,
          ticketId: opts.ticketId,
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
          warn: opts.warn,
          store: opts.store,
          process: opts.process,
          persistFindings: opts.persistFindings,
          onOutput: opts.onOutput,
          onTargetProgress: opts.onTargetProgress,
          debug: opts.debug,
          openChanges: opts.openChanges,
          git: opts.git,
        })
      : { kind: 'not-run' };
  return { outcome, blockingSeverity: config.blockingSeverity };
}
