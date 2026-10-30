/**
 * The UAT Tester process (Task 8) — the ONE AI process in UAT, run only after
 * the required gates pass. It asks an agent core for structured OBSERVATIONS
 * of a ticket's behavior and records them as advisory evidence.
 *
 * BY DEFAULT the observations can never pass, fail, transition, or spend a
 * recovery round by themselves: `aggregateUat` never sees them (and never
 * will — the pure gate aggregate stays free of AI output), and the optional
 * deterministic `uat.testerVerifier` boundary (the stage's job, in
 * `uat/testerVerifier.ts`) is a Tester-specific verdict source.
 *
 * There is exactly ONE knob that makes an observation a verdict:
 * `uat.testerObservations.blockingSeverity` (threaded in here as
 * `observationsBlockingSeverity`). Absent, or `'none'` — which is the default
 * and what every manifest that omits the block reads as — nothing changes:
 * observations are recorded and are advisory, exactly as shipped. Set to a
 * severity, this module COUNTS the recorded observations at or above it
 * (`blocking`) and the UAT STAGE turns a nonzero count into a failed verdict
 * with a Tester-attributed recovery round. The count is never a verdict here.
 * The process
 * run is opened HERE, before the first AI call, with the resolved assignment
 * snapshot — so the row exists durably (a host restart mid-call leaves a
 * `running` row the activation sweep marks stale), carries WHO ran it as it
 * was at launch, and is finished with an explicit result kind
 * (`observed`/`execution-failed`/`unreadable-output`/`interrupted`).
 *
 * The prompt/parse boundary is review's own `parseFindings` (`review/findings.ts`):
 * whole-document JSON then JSONL, a closed severity vocabulary, in-worktree
 * file validation, and the shared collapse-then-cap for every untrusted prose
 * field. `repo` is never read from the model — every observation is attributed
 * to the target this invocation was scoped to.
 */

import type { Store } from '../../store/db.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import type { HeadlessOutputChunk } from '../../agent/headlessSpawn.js';
import type { Severity } from '../../manifest/types.js';
import { GATE_LANE_HEADLESS_TIMEOUT_MS } from '../../agent/headlessSpawn.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { openProcessRun, finishProcessRun, setProcessRunPromptTelemetry } from '../../store/processRuns.js';
import { stageAttempt } from '../../store/stages.js';
import { recordUatFindings, type UatFindingInput } from '../../store/uatFindings.js';
import { listTokenUsage } from '../../store/tokenUsage.js';
import { parseFindingsResult, type FindingsParseShape, type WarnFn } from '../review/findings.js';
import { isWrongCheckoutClaim } from '../review/checkoutClaim.js';
import { buildScopeBlock } from '../agentScope.js';
import { endedOnBackgroundCommand, backgroundEndedDetail } from './backgroundCommand.js';
import { OUTPUT_RULES_HEADING, OUTPUT_RULES_BASE, OUTPUT_RULES_UAT, GATE_ISOLATION_RULE, NO_DANGLING_COMMAND_RULE } from '../../agent/promptText.js';
import { TESTER_OUTPUT_SCHEMA } from '../../agent/outputContract.js';
import { createReviewSnapshot, deleteReviewSnapshot } from '../reviewSnapshot.js';
import { collapseDiagnostic } from '../../model/diagnosticText.js';
import { truncateToBudget, keylessTruncationPointer, SEED_BUDGETS } from '../../agent/seedBudget.js';
import { nowIso } from '../../model/time.js';
import { formatTokens } from '../../model/tokenFormat.js';
import { isTimedOutFailure } from '../../agent/failureClass.js';
import { classifyFailure } from '../../agent/failureClass.js';
import { UsageLimitError } from '../../agent/cliFailure.js';
import { UAT_TESTER_TOKEN_BUDGET } from '../../manifest/qualityDefaults.js';
import { NOT_RUN, notRunRepos } from '../usageLimitKept.js';
import { observedNothing, skippedDetail, reaskPrefix, type OnSkip } from './testerSkip.js';
import { COVERAGE_RULE_UAT, coverageOrFallback, isCoverageRecord, splitCoverage } from '../../model/coverageRecord.js';

/**
 * Ceiling on the injected done-when criteria block (Prompt 17). The source is
 * `Ticket.description` — untrusted-length prose a ticket author wrote. The
 * budget lives in `SEED_BUDGETS.testerCriteria` (derived from the same
 * prompt-metrics baseline as the other budgets). When it overflows the block
 * carries a stated truncation pointer — the agent must know criteria are
 * missing and be told how to recover them via `karst context <key>`.
 */
export const MAX_CRITERIA_CHARS = SEED_BUDGETS.testerCriteria;

/** One line naming the ticket's done-when criteria as authoritative and bounding them. */
function buildCriteriaBlock(criteria: string | null | undefined, ticketKey: string | null | undefined): string[] {
  const trimmed = criteria?.trim() ?? '';
  if (trimmed === '') return [];
  // `buildContextPointerLine` guards on the same value — this must not be the
  // one place that emits a command it cannot form.
  const key = ticketKey?.trim() ?? '';
  const { text } = truncateToBudget(
    trimmed,
    MAX_CRITERIA_CHARS,
    key,
    key === '' ? keylessTruncationPointer() : undefined,
  );
  return [
    `Done-when criteria for this ticket (authoritative — exercise each one against the running code):`,
    text,
    ``,
  ];
}

/** The tester-safe context view: no code pointers, no review findings (`karst context --for tester`). */
const TESTER_AUDIENCE_FLAGS = '--for tester --md';

/** The ticket's canonical intent as the authoritative charter, bounded; empty when absent/blank. */
function buildIntentBlock(intent: string | null | undefined, ticketKey: string | null | undefined): string[] {
  const trimmed = intent?.trim() ?? '';
  if (trimmed === '') return [];
  const key = ticketKey?.trim() ?? '';
  const { text } = truncateToBudget(
    trimmed,
    SEED_BUDGETS.intent,
    key,
    key === '' ? keylessTruncationPointer() : undefined,
  );
  return [
    `Intent for this ticket (authoritative — exercise every scenario against the running app):`,
    text,
    ``,
  ];
}

/**
 * The tier-1 context pointer (Prompt 17): the ONE command permitted past the
 * scope block's repo-wide-recon ban, for pulling anything the criteria block
 * above does not already carry — prior findings, gate output, attachments,
 * running services. Named ONLY here and echoed into the scope block's ban
 * exception (`agentScope.ts`) so both halves of the prompt name the identical
 * command. Absent `contextCommand` or `ticketKey` → no line (nothing to run).
 */
function buildContextPointerLine(
  contextCommand: string | undefined,
  ticketKey: string | null | undefined,
): string[] {
  if (!contextCommand || !ticketKey) return [];
  return [
    `Need more than the criteria above (prior findings from the last round, gate output, ` +
      `attachments, running services)? Run exactly: ${contextCommand} ${ticketKey} ${TESTER_AUDIENCE_FLAGS}`,
    `Nothing else about the orchestrator is in scope.`,
  ];
}

/** One target the Tester asks about — the same shape UAT already plans. */
export interface TesterTarget {
  /** The repository path; every observation is attributed HERE, never to the model's own claim. */
  repo: string;
  /** The repository's worktree root; both the call's `cwd` and the parse containment root. */
  worktreePath: string;
  /** The plain base branch name (`worktrees.base_ref`), when known. */
  baseRef?: string | null;
  /**
   * `worktrees.branch` for this target — the ticket's own branch. Naming it in
   * the scope block makes the diff range `origin/<base>...<branch>`, which
   * resolves by branch name and reads the same from any checkout of the repo —
   * a worktree on the base branch no longer reads as "no changes" (fu1).
   */
  branch?: string | null;
  /**
   * Host-known, READ-ONLY context: the services of this target that karst
   * ALREADY started for this ticket, each as `repo/service → http://host:port`.
   * The Tester exercises these live; it never starts or stops anything (the
   * stage owns the stack — `SERVERS_VIA_CLI_RULE`). Empty/absent → the target
   * has no running service and the prompt says so.
   */
  runningServices?: readonly TesterRunningService[] | null;
}

export interface TesterRunningService {
  /** `repo/service` — the unit key the rest of karst names this service by. */
  key: string;
  /** The live URL, `http://host:port`. */
  url: string;
}

/**
 * The running-services clause. A target with live services is told they are up
 * and must not be touched; a serviceless target is told its change is not live
 * in any running app, so it verifies through its CLI/API/library instead of
 * looking for a UI that was never started.
 */
function serviceClauseFor(services: readonly TesterRunningService[] | null | undefined): string {
  if (services && services.length > 0) {
    const lines = services.map((s) => `\n- ${s.key} → ${s.url}`).join('');
    return (
      `\nThese services are already running for this ticket; do not start, restart or stop them.` +
      lines
    );
  }
  return (
    `\nThis repository has no running service; verify through its CLI, API or library usage. ` +
    `Its change is NOT live in any running app of this ticket.`
  );
}

export interface RunUatTesterOpts {
  ticketId: number;
  targets: readonly TesterTarget[];
  /** The resolved identity SNAPSHOT the process run opens with (Task 7). */
  assignment: ProcessAssignmentSnapshot;
  /** The already instrumented per-ticket adapter (the host resolves it once). */
  adapter: AgentAdapter;
  /** The stage_runs batch this process runs under, when one was opened. */
  stageRunId?: number | null;
  /** The stage's attempt when the run opens; defaults to the store's value. */
  attempt?: number;
  /** One signal for the whole run, so Stop reaches a call already in flight. */
  signal?: AbortSignal;
  /**
   * Injected git runner for the per-target CHECKOUT VERIFICATION (869ej1nfb):
   * before a token is spent, the host confirms the worktree is actually on the
   * ticket's branch. A mismatch means the Tester would read the diff of the
   * WRONG checkout (or of a stale local branch ref that equals the base) and
   * report "no changes to test" for a ticket that carries work — so the run
   * records a deterministic `critical` observation naming the wrong checkout
   * and SKIPS that target's call instead. Absent → no verification (the lane
   * behaves exactly as before, and the prompt's own wrong-checkout rule still
   * guards the agent). An unverifiable checkout (git cannot answer) also
   * proceeds without verification.
   */
  git?: GitRunner;
  /**
   * The hard deadline for EACH headless call, in milliseconds. Absent → the
   * generous gate-lane bound (`GATE_LANE_HEADLESS_TIMEOUT_MS`): the Tester is
   * asked to RUN the repo's tests and exercise the acceptance criteria, which
   * a chat-tuned model spends many minutes of tool calls on — the 15-minute
   * quick-call default killed UAT testing mid-run and left zero observations.
   */
  timeoutMs?: number;
  warn?: WarnFn;
  /**
   * Live-output hook, forwarded verbatim to every `adapter.runHeadless` call
   * (each target asks its own call). RAW untrusted CLI prose — the caller
   * that surfaces it (the console tail) must bound and sanitize it. Absent →
   * no live chunks; the observations still parse from the settled output.
   */
  onOutput?: (chunk: HeadlessOutputChunk) => void;
  /**
   * Per-target progress (Task 13 mirror): called before each target's call
   * (`status: 'active'`) and after it returns (`status: 'completed'`, with a
   * one-line detail naming what came back). Lets the host push the same
   * inside-progress overlay the gates use, so the dashboard header tracks a
   * multi-target Tester run even with the console closed. Absent → no events.
   */
  onTargetProgress?: (event: { repo: string; status: 'active' | 'completed'; detail?: string }) => void;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[gate]` — the
   * Tester is part of the UAT stage flow, so its lines ride the same stream
   * the stage's own debug lines use. Absent → no debug lines; the stage
   * threads its `RunUatOpts.debug` here, and the host binds that to
   * `Logger.debug` (a no-op unless the manifest's `debug` flag is on).
   * The prompt is never logged — only counts, names and outcomes.
   */
  debug?: (message: string) => void;
  /**
   * ONE cap for the whole execution, across every target (Finding 13) —
   * observations beyond it are truncated by severity exactly like review's
   * `maxFindings`. The cap is applied ONCE, after every configured target has
   * been asked: a repository that fills the budget never starves a later one,
   * and no single response's parse can exceed the cap on its own (memory
   * stays bounded per response).
   */
  maxObservations?: number;
  /**
   * `uat.testerObservations.blockingSeverity` (Task 3.2). ABSENT → `'none'`,
   * which is the shipped behavior: observations are advisory and `blocking` is
   * always 0. Set to a severity, every recorded observation at or above it is
   * counted into the result's `blocking` — counted over the FINAL capped list,
   * so an observation the cap truncated away can never block. The count is
   * reported, never acted on here: the UAT stage owns the verdict.
   */
  observationsBlockingSeverity?: Severity | 'none';
  /**
   * T663: the FRESH-token budget one target's run may report before the lane
   * NAMES the cause of its partial result. Absent → `UAT_TESTER_TOKEN_BUDGET`.
   * The count is read from the same ledger the Inside row's token pill reads
   * (`token_usage` by this run's id), so a core that reports nothing measurable
   * never trips it. It is a POST-HOC report, not a live stop: usage is only
   * known once a call settles, so the soft time budget below is what actually
   * cuts a call off. It never marks a call that finished partial.
   */
  tokenBudget?: number;
  /**
   * T663: the SOFT time budget for one call, in ms — the point the lane arms
   * its own abort, below the hard `timeoutMs`. Absent → 75% of the hard
   * deadline (45 min of the 60), leaving room for the contextual wrap-up re-ask.
   */
  softTimeoutMs?: number;
  /** T663: the deadline for the ONE contextual wrap-up re-ask. Absent → 5 minutes. */
  wrapUpTimeoutMs?: number;
  /** The ticket's done-when criteria (`Ticket.description`), read once by the stage. Absent/blank → no criteria block. */
  criteria?: string | null;
  /** The ticket's canonical black-box intent (`Ticket.intent`), read once by the stage. Absent/blank → criteria only. */
  intent?: string | null;
  /** The ticket's key, e.g. `PROMPT-17-UAT-CRITERIA`. Required (with `contextCommand`) for the tier-1 pointer line. */
  ticketKey?: string | null;
  /**
   * The composed `karst context` prefix (§ context loader, `cliContextPrefix` /
   * `composeContextCommand`) — an opaque already-assembled string, never the
   * CLI entry/db/manifest paths threaded separately (host-agnostic invariant).
   * Absent → no pointer line, and the scope block's anti-recon ban stays
   * unqualified.
   */
  contextCommand?: string;
  /**
   * `uat.testerObservations.onSkip`. Absent / `'pass'` → a skipped run is recorded
   * as `skipped` and nothing more (today's behavior). `'reask'` and
   * `'reask-then-park'` send ONE more call per skipped target; the UAT stage owns
   * what a second skip means (pass, or park).
   */
  onSkip?: OnSkip;
  /** Internal: repo → the coverage title to quote in the one re-ask prefix. */
  reaskTitles?: Readonly<Record<string, string>>;
}

/**
 * The closed Tester result. `observed` is the ONLY advisory success — it
 * carries the ids of the recorded rows; `execution-failed` is an adapter crash
 * (the stage warns and lets the gates decide); `unreadable-output` is every
 * asked target answering something no findings could be read out of;
 * `interrupted` is a Stop.
 */
export type TesterRunResult =
  | {
      kind: 'observed';
      findingIds: number[];
      /**
       * How many of the RECORDED observations are at or above
       * `observationsBlockingSeverity`. Always 0 at the default `'none'` — the
       * advisory behavior. A nonzero count is what the UAT stage turns into a
       * failed verdict; this module states the count and nothing more.
       */
      blocking: number;
      /**
       * The severity breakdown of those blocking observations (`"1 high"`,
       * `"2 critical, 1 high"`), in the same wording review's findings verdict
       * uses. Present only when `blocking > 0`, so the advisory result shape is
       * unchanged.
       */
      blockingSummary?: string;
    }
  | {
      /**
       * T663: the run was STOPPED (the soft time budget fired or the hard
       * deadline landed), and the observations that could still be recovered —
       * from the stdout already captured, or from the ONE contextual re-ask —
       * were recorded. Advisory like `observed` (the verdict knob applies
       * unchanged), but the run is MARKED partial so it can never read as a
       * clean pass: `detail` names the cause for the Inside row. A call that
       * FINISHED is never partial, whatever it spent.
       */
      kind: 'partial';
      findingIds: number[];
      blocking: number;
      blockingSummary?: string;
      /** Bounded one-line cause, rendered as the Inside Tester failure detail. */
      detail: string;
    }
  | { kind: 'execution-failed'; message: string }
  /**
   * Every asked target answered SKIPPED / NOT RUN and kept no observation: the
   * Tester checked nothing. Advisory like `observed` (the coverage rows are
   * still recorded), but shown as skipped so it never reads as a clean pass.
   * `detail` is the first skipped target's reason, one line.
   */
  | { kind: 'skipped'; findingIds: number[]; detail: string }
  /**
   * K11: a target's call died because the provider account is out of
   * quota/allowance. NOT an advisory absence and NOT a T663 partial — the
   * account cannot run the op, so the UAT stage parks `blocked:usage-limit`
   * (no verdict, no fix round). Targets that already answered are kept on the
   * park row (`keptOutcome`).
   */
  | {
      kind: 'usage-limited';
      /** The repo whose call hit the limit. */
      target: string;
      provider: string;
      model: string | null;
      detail: string;
      keptOutcome: string;
    }
  /**
   * Every target answered, and not one answer carried a findings-shaped
   * container we could read. Distinct from `observed` with zero findings: a
   * clean run is silent BY SAYING SO (`[]`), and reading an unreadable answer
   * as a clean one is what turned a `high` observation into "0 observations —
   * advisory". Advisory still: the ordinary UAT gates decide the stage.
   */
  | {
      kind: 'unreadable-output';
      /**
       * Every unreadable target's raw answer, bounded and sanitized
       * (`collapseDiagnostic`) — the only record of what the Tester saw. For
       * the stage's artifact log ONLY: never a verdict reason, never a debug
       * line, never `uat_findings` (UAT-19).
       */
      preview: string;
    }
  | { kind: 'interrupted' };

export const DEFAULT_MAX_TESTER_OBSERVATIONS = 100;

/**
 * Appended to the prompt for the ONE re-ask a silent target gets. It restates
 * the only thing the first answer was missing — the written result — and
 * nothing else: the strategy, the target context and the output rules are
 * already above it in the same prompt.
 */
export const TESTER_SILENCE_NUDGE =
  'Your previous answer was empty. Whatever you have observed so far, write it ' +
  'down NOW as the JSON array described above — output exactly [] if there is ' +
  'nothing worth reporting. Output the array and nothing else.';

/**
 * T663: the instruction half of the ONE re-ask a STOPPED target gets. It is the
 * SILENCE nudge's sibling — same output contract — but its reason is different:
 * the run was cut off, so the agent is asked to write down what it already
 * produced. It is only ever sent WITH the run's own partial output quoted back
 * ({@link buildWrapUpNudge}): a fresh headless call has no session memory, so a
 * bare "report what you observed" would ask an agent to report observations it
 * never made in THIS call and could return a fresh, unrelated test result.
 */
export const TESTER_WRAP_UP_NUDGE =
  'You have reached the testing budget for this run and it has been stopped. Do ' +
  'not run any more commands, read any more files, or start any more checks. ' +
  'Report the observations in your output so far as the JSON array described ' +
  'above, and nothing else — output exactly [] if there is nothing worth reporting.';

/**
 * The default soft time budget for one Tester call, as a FRACTION of the hard
 * deadline (`RunUatTesterOpts.timeoutMs`, default 60 min): 45 minutes of the 60.
 * Stopping at the soft budget leaves room inside the hard deadline for the
 * wrap-up re-ask, so a busy core still reports instead of being killed with
 * everything it learned.
 */
export const UAT_TESTER_SOFT_BUDGET_FRACTION = 0.75;

/** The default deadline for the ONE wrap-up re-ask — short, because the agent already has the observations. */
export const UAT_TESTER_WRAP_UP_TIMEOUT_MS = 5 * 60 * 1_000;

/** Bound on the quoted-back prose in {@link buildReformatNudge} — untrusted agent output re-entering the prompt. */
const REFORMAT_NUDGE_QUOTE_MAX = 4_000;

/**
 * Appended for the ONE re-ask a target gets when its answer came back
 * UNREADABLE (UAT-19) — distinct from {@link TESTER_SILENCE_NUDGE}, which
 * re-asks a target that said NOTHING. Here the core answered and observed
 * something real; the shape was wrong. Quoting the prose back and asking
 * only for its reformatting (no new testing, no new observation) recovers
 * that finding instead of discarding it — a genuine defect, correctly
 * found, must not be lost to a formatting failure. The quoted prose is
 * bounded (`collapseDiagnostic`) before it re-enters the prompt: it is
 * untrusted agent output like any other. The fence delimiter is `"""`,
 * so the sequence is replaced inside the payload — `collapseDiagnostic`
 * bounds and one-lines the prose but escapes nothing, and a fence the
 * payload can close puts the remainder of untrusted agent output where
 * the instructions are. Fired at most once per target; a still-unreadable
 * second answer parks the stage (`stages/uat.ts`).
 */
function buildReformatNudge(raw: string): string {
  const quoted = collapseDiagnostic(raw, REFORMAT_NUDGE_QUOTE_MAX).replaceAll('"""', "'''");
  return (
    'Your previous answer was not a valid JSON array of findings — it was:\n' +
    `"""${quoted}"""\n` +
    'Do not observe or test anything new. Reformat exactly what you already ' +
    'reported above as the JSON array described earlier — output exactly [] ' +
    'if there was nothing worth reporting. Output the array and nothing else.'
  );
}

/**
 * The ONE re-ask a STOPPED target gets, quoting the partial output it had
 * already streamed back into the prompt ({@link TESTER_WRAP_UP_NUDGE} + the
 * bounded, fence-safe quote `buildReformatNudge` uses). The quote is what makes
 * the fresh call usable: it gives the agent the context it would otherwise have
 * lost, so the re-ask reformats what was already observed instead of running a
 * new test. Never built without a non-empty quote — a stopped run that produced
 * nothing is not re-asked at all.
 */
function buildWrapUpNudge(captured: string): string {
  const quoted = collapseDiagnostic(captured, REFORMAT_NUDGE_QUOTE_MAX).replaceAll('"""', "'''");
  return `${TESTER_WRAP_UP_NUDGE}\nYour output so far:\n"""${quoted}"""`;
}

/**
 * The branch the checkout at `cwd` is currently on, or null when it cannot be
 * determined (git refused to answer, or the checkout is empty). A detached
 * HEAD answers the literal `HEAD` — which never matches a ticket branch, so
 * it correctly reads as a wrong checkout rather than an unverifiable one.
 */
export async function checkoutBranch(git: GitRunner, cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (r.exitCode !== 0) return null;
  const branch = r.stdout.trim();
  return branch === '' ? null : branch;
}

/** Rank for the cap sort — lower survives a cut first. Closed over the same `Severity` vocabulary `uat_findings` records. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Severities from most to least severe — the order a breakdown is read in. */
const SEVERITIES_BY_RANK = (Object.keys(SEVERITY_RANK) as Severity[]).sort(
  (a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b],
);

/**
 * The observations at or above `threshold`, summarized. `'none'` (the default)
 * yields zero and no summary — the advisory behavior. Pure, and applied to the
 * FINAL capped list so a truncated observation never counts.
 */
export function countBlockingObservations(
  observations: readonly { severity: Severity; title: string }[],
  threshold: Severity | 'none',
): { blocking: number; blockingSummary?: string } {
  if (threshold === 'none') return { blocking: 0 };
  const limit = SEVERITY_RANK[threshold];
  const counts = new Map<Severity, number>();
  let blocking = 0;
  for (const o of observations) {
    // The advisory coverage record is `info` and must never block, even when
    // the threshold is the lowest severity.
    if (isCoverageRecord(o)) continue;
    if (SEVERITY_RANK[o.severity] > limit) continue;
    blocking += 1;
    counts.set(o.severity, (counts.get(o.severity) ?? 0) + 1);
  }
  if (blocking === 0) return { blocking: 0 };
  const blockingSummary = SEVERITIES_BY_RANK.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(', ');
  return { blocking, blockingSummary };
}

/**
 * The FRESH tokens this run's ledger already holds — total less cache READS,
 * summed over the MEASURED rows only, exactly the quantity the Inside row's
 * token pill renders (`summarizeRecordedTokenUsageForProcess`'s SQL). The
 * Tester's budget reads it rather than the adapter's return value because a
 * call the spawner killed still recorded what it burned (the timeout error
 * carries the partial stream's counts), and that runaway is the case the budget
 * exists for.
 */
function recordedFreshTokens(store: Store, processRunId: number): number {
  let total = 0;
  let cacheRead = 0;
  for (const row of listTokenUsage(store, { processRunId })) {
    if (row.estimated) continue;
    total += row.totalTokens;
    cacheRead += row.cacheReadTokens;
  }
  return Math.max(0, total - cacheRead);
}

/** A per-call abort linked to the caller's Stop, armed at the soft time budget. */
interface BudgetAbort {
  signal: AbortSignal;
  /** True once the SOFT budget (never a caller Stop) armed this abort. */
  fired: () => boolean;
  dispose: () => void;
}

/**
 * A Stop signal that ALSO fires at `timeoutMs` (the soft budget). Forwarding
 * the caller's abort keeps a user Stop terminal and immediate; the timer is
 * the lane's own, so the catch can tell "the budget ran out" (salvage) apart
 * from "the user stopped it" (interrupted) by the caller's signal alone.
 */
function linkedAbort(outer: AbortSignal | undefined, timeoutMs: number): BudgetAbort {
  const controller = new AbortController();
  let fired = false;
  const forward = (): void => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', forward, { once: true });
  }
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, Math.max(0, timeoutMs));
  return {
    signal: controller.signal,
    fired: () => fired,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    },
  };
}

/** A sink that drops warnings — the captured stream is console text, not the agent's answer. */
const SILENT_WARN: WarnFn = () => {};

/**
 * Recover the observations a STOPPED run already produced.
 *
 * The run's own streamed stdout is the evidence, so it is parsed first — and
 * silently, because console text is not the agent's answer and the shared
 * parser's "unrecognizable" warning there would be noise a budget stop does not
 * deserve. Only when that stream held something but no findings-shaped array
 * does the ONE contextual re-ask fire: the agent's own output is quoted back
 * ({@link buildWrapUpNudge}) so the fresh call has the context to reformat it.
 * A stopped run that produced NOTHING is not re-asked — a contextless agent
 * cannot report observations it never made, and a new run would be a different
 * test, not a report.
 */
async function recoverStoppedTarget(
  captured: string,
  context: { repo: string; worktreePath: string; max: number },
  reask: (text: string) => Promise<{ raw: string }>,
  warn: WarnFn | undefined,
  outerSignal: AbortSignal | undefined,
): Promise<{ parse: ReturnType<typeof parseFindingsResult>; raw: string }> {
  const salvaged = parseFindingsResult(captured, context, SILENT_WARN);
  if (salvaged.findings.length > 0 || captured.trim() === '') {
    return { parse: salvaged, raw: captured };
  }
  try {
    const answer = await reask(buildWrapUpNudge(captured));
    const reparsed = parseFindingsResult(answer.raw, context, warn);
    // A still-unreadable re-ask keeps the salvage's record of what the run said.
    return reparsed.shape === 'unreadable' && reparsed.findings.length === 0
      ? { parse: salvaged, raw: captured }
      : { parse: reparsed, raw: answer.raw };
  } catch (error) {
    // A user Stop is terminal; anything else (the re-ask's own deadline, a
    // crash) leaves the salvage of the captured stream standing.
    if (outerSignal?.aborted) throw error;
    return { parse: salvaged, raw: captured };
  }
}

/**
 * The one-line cause of a partial run, as the Inside Tester detail renders it
 * (T663). A token-budget stop names the spend that tripped it; a deadline names
 * what was — or was not — recovered.
 */
export function testerPartialDetail(
  budgetPeak: number,
  partialObservations: number,
  endedOnBackground = false,
): string {
  if (endedOnBackground) return backgroundEndedDetail('tester');
  if (budgetPeak > 0) {
    return `tester exceeded budget (${formatTokens(budgetPeak)} tok) — partial results recorded`;
  }
  if (partialObservations > 0) {
    return `timed out — ${partialObservations} partial observation${
      partialObservations === 1 ? '' : 's'
    } recorded`;
  }
  return 'timed out — no observations recovered';
}

export interface TesterDeps {
  /** Injected clock, so tests are deterministic. */
  now?: () => string;
}

/**
 * The request. Strict output rules because the default answer from a
 * chat-tuned model is prose — the same contract review's findings prompt
 * enforces, so the shared parser's guarantees hold unchanged.
 *
 * `baseRef` is the PLAIN branch name, never a doubled `origin/origin/...`; a
 * missing/null ref falls back to the generic wording rather than ever
 * interpolating the literal string "undefined". The service context is
 * host-known and read-only — the Tester is told what it MAY stand up, never
 * asked to invent one. `instructions` (optional) replaces the role/strategy
 * lines with the author's own — the target context and the strict output
 * rules always remain.
 */
export interface TesterPromptExtra {
  /** The ticket's canonical black-box intent (`Ticket.intent`). Bounded, omitted when empty. */
  intent?: string | null;
  /** Decision-point logging, `[gate]`-prefixed by the caller's convention. */
  debug?: (message: string) => void;
  /** The ticket's done-when criteria (`Ticket.description`). Bounded, omitted when empty. */
  criteria?: string | null;
  /** The ticket's key, for the tier-1 context pointer line. */
  ticketKey?: string | null;
  /** The composed `karst context` prefix (§ context loader). Absent → no pointer line. */
  contextCommand?: string;
}

/** Karst-owned scratch dir for UAT probe files; under `/.karst/`, which KARST_EXCLUDE_RULES covers. */
export const TESTER_SCRATCH_DIR = '.karst/uat-scratch';

/** Three-dot form: a two-dot diff reads newer base work as deletions. */
export function testerMergeBaseRule(baseRef: string | null | undefined): string {
  const base = baseRef ? `origin/${baseRef}` : 'origin/<base>';
  return `If you compare against base at all, use the merge-base range \`${base}...HEAD\` (three dots), never the two-dot \`${base}\` form, which reads newer base work as deletions.`;
}

export function buildTesterPrompt(
  target: TesterTarget,
  instructions?: string,
  snapshotRef?: string | null,
  extra?: TesterPromptExtra,
): string {
  const baseClause = target.baseRef
    ? `against its base branch, \`${target.baseRef}\` (compare against \`origin/${target.baseRef}\` when available, otherwise the local \`${target.baseRef}\`).`
    : `against its base branch.`;
  const serviceClause = serviceClauseFor(target.runningServices);
  // User instructions REPLACE the role/strategy block (the ticket's
  // precedence: user override → built-in default). The target context is
  // kept — repo, base branch and service are facts the agent needs whatever
  // the strategy — and the output rules below are never replaced.
  const instructionsText = instructions?.trim() ?? '';
  const strategy =
    instructionsText.length > 0
      ? [
          instructionsText,
          `Repository: ${target.repo} ${baseClause}${serviceClause}`,
          '',
        ]
      : [
          `You are a black-box UAT tester. Verify the intent below by exercising the running application (UI, CLI, API) the way a user would. (repository: ${target.repo}) ${baseClause}`,
          `Do NOT read source code, the diff, implementation plans, review findings or code pointers — judge only observable behavior against the intent. ` +
            `Do not run the project's test suites; the deterministic gates already did. Try to break it.${serviceClause}`,
        ];
  // Compose the ONE command the agent may run past the recon ban — a single
  // value shared by the pointer line and the scope block's ban exception so the
  // two halves of the prompt always name the identical string, and the ban's
  // carve-out is true by construction.
  const composedContextCommand =
    extra?.contextCommand && extra?.ticketKey
      ? `${extra.contextCommand} ${extra.ticketKey} ${TESTER_AUDIENCE_FLAGS}`
      : undefined;
  const intentBlock = buildIntentBlock(extra?.intent, extra?.ticketKey);
  if (intentBlock.length === 0) extra?.debug?.('[gate] tester: no intent, criteria only');
  const intentAndCriteria = [
    ...intentBlock,
    ...buildCriteriaBlock(extra?.criteria, extra?.ticketKey),
  ];
  return [
    ...strategy,
    // Never displaced by `instructions` and never part of the strict output
    // contract: the deny is a hard stop, but the agent must also know the RIGHT
    // way to stop its own child (`kill $!`) so it does not reach for `pkill`.
    GATE_ISOLATION_RULE,
    NO_DANGLING_COMMAND_RULE,
    testerMergeBaseRule(target.baseRef),
    COVERAGE_RULE_UAT,
    `Put any probe scripts or scratch files under \`${target.worktreePath}/${TESTER_SCRATCH_DIR}/\` (karst-owned, git-excluded); files anywhere else in the checkout dirty it and block host gates.`,
    // Placed between the strategy and the scope block, and NEVER displaced by
    // `instructions` (which only ever replaces the strategy lines above) —
    // the ticket's done-when criteria are authoritative for every Tester run.
    ...intentAndCriteria,
    // Named BEFORE the scope block so its ban exception (`agentScope.ts`) can
    // say "the command named above" and mean this line.
    ...buildContextPointerLine(extra?.contextCommand, extra?.ticketKey),
    ``,
    // Never replaced by `instructions` — see `workflow/agentScope.ts`.
    // `contextCommand` is the composed string (prefix + key + --md) so the ban
    // exception names the exact same command the pointer line named.
    ...buildScopeBlock('test', {
      baseRef: target.baseRef,
      branch: target.branch,
      worktreePath: target.worktreePath,
      snapshotRef,
      contextCommand: composedContextCommand,
    }),
    ``,
    OUTPUT_RULES_HEADING,
    ...OUTPUT_RULES_BASE,
    ...OUTPUT_RULES_UAT,
    `- No observations worth reporting → output only the coverage entry above.`,
    `- These are OBSERVATIONS, not verdicts: you cannot pass or fail the ticket; you report what you found.`,
  ].join('\n');
}

/**
 * Run the Tester for every target and record its observations. Never throws:
 * an adapter crash is `execution-failed` (reported, and left for the stage to
 * warn about — a failed AI call must not break the run's gates), and a Stop is
 * `interrupted`. The process run is opened FIRST, so the identity snapshot is
 * durable before any token is spent, and closed with the result kind before
 * this returns.
 */
export async function runUatTester(
  store: Store,
  opts: RunUatTesterOpts,
  deps: TesterDeps = {},
): Promise<TesterRunResult> {
  const first = await runTesterOnce(store, opts, deps);
  if (first.result.kind !== 'skipped' || (opts.onSkip ?? 'pass') === 'pass') return first.result;
  // A skipped run means EVERY target observed nothing, so every target is re-asked
  // — exactly once; the second run's result replaces the first's.
  opts.debug?.(`[gate] uat tester ticket ${opts.ticketId}: observed nothing — re-asking once`);
  return (await runTesterOnce(store, { ...opts, reaskTitles: first.skippedTitles }, deps)).result;
}

async function runTesterOnce(
  store: Store,
  opts: RunUatTesterOpts,
  deps: TesterDeps,
): Promise<{ result: TesterRunResult; skippedTitles: Record<string, string> }> {
  const skippedTitles: Record<string, string> = {};
  const result = await runTesterBody(store, opts, deps, skippedTitles);
  return { result, skippedTitles };
}

async function runTesterBody(
  store: Store,
  opts: RunUatTesterOpts,
  deps: TesterDeps,
  skippedTitles: Record<string, string>,
): Promise<TesterRunResult> {
  const now = deps.now ?? nowIso;
  const run = openProcessRun(store, {
    ticketId: opts.ticketId,
    stageKey: 'uat',
    processId: 'tester',
    attempt: opts.attempt ?? stageAttempt(store, opts.ticketId, 'uat'),
    stageRunId: opts.stageRunId ?? null,
    agentName: opts.assignment.agentName ?? null,
    provider: opts.assignment.provider,
    model: opts.assignment.model ?? null,
    pid: process.pid,
    startedAt: now(),
  });
  const close = (
    status: 'passed' | 'failed' | 'interrupted',
    resultKind: string,
    failureDetail?: string,
  ): void => {
    finishProcessRun(store, run.id, status, now(), resultKind, null, failureDetail);
  };

  const cap = opts.maxObservations ?? DEFAULT_MAX_TESTER_OBSERVATIONS;
  const collected: UatFindingInput[] = [];
  // One advisory coverage record per answered target; kept apart so no cap, count or verdict sees it.
  const coverageRecords: UatFindingInput[] = [];
  // One shape per target actually ASKED — the deterministic wrong-checkout
  // `continue` below pushes nothing here, since it never asked the core.
  const shapes: FindingsParseShape[] = [];
  // The raw answer from every target that parsed as 'unreadable' — the only
  // record of what the Tester saw, kept so the all-unreadable branch below
  // can hand it to the stage as evidence instead of discarding it. Bounded
  // and sanitized once, at the point it leaves this function (UAT-19).
  const unreadableAnswers: { repo: string; raw: string }[] = [];
  // v57 prompt metrics: how many targets answered NOTHING and were re-asked once.
  // The tester's OWN run carries it (it opened that run), mirroring how the review
  // lane records its parse tiers — never a verdict input, never a second row.
  let silenceNudges = 0;
  // v57 prompt metrics, kept SEPARATE from `silenceNudges`: a reformat nudge
  // fires on a different failure mode (the core answered, in the wrong
  // shape) than silence (the core answered nothing), and the two rates must
  // stay distinguishable in the telemetry blob.
  let reformatNudges = 0;
  // T663 budget state, carried across every target of this ONE run: a run is
  // partial if ANY target was stopped by a budget, and the detail names the
  // worst cause (a token overspend outranks a deadline) with the recovered
  // observation count.
  let partial = false;
  let budgetPeak = 0;
  let partialObservations = 0;
  let endedOnBackground = false;
  const hardTimeoutMs = opts.timeoutMs ?? GATE_LANE_HEADLESS_TIMEOUT_MS;
  const tokenBudget = opts.tokenBudget ?? UAT_TESTER_TOKEN_BUDGET;
  const softTimeoutMs =
    opts.softTimeoutMs ?? Math.round(hardTimeoutMs * UAT_TESTER_SOFT_BUDGET_FRACTION);
  const wrapUpTimeoutMs = opts.wrapUpTimeoutMs ?? UAT_TESTER_WRAP_UP_TIMEOUT_MS;
  const debug = opts.debug;
  const git = opts.git ?? defaultGitRunner;
  const snapshotted: { repo: string; worktreePath: string }[] = [];
  // K11: per-target outcome, kept so a quota park can carry what its siblings
  // already answered; `currentRepo` names the target in flight when a quota
  // error surfaces from a re-ask outside the inner try.
  const targetOutcomes: { repo: string; status: string; observations: number }[] = [];
  let currentRepo = '';
  const usageLimited = (error: unknown, target: string): TesterRunResult => {
    const provider =
      (error instanceof UsageLimitError ? error.provider : undefined) ?? opts.assignment.provider;
    const model =
      (error instanceof UsageLimitError ? error.model : undefined) ?? opts.assignment.model ?? null;
    const detail = collapseDiagnostic(error instanceof Error ? error.message : String(error));
    close('failed', 'execution-failed', detail);
    debug?.(
      `[gate] uat tester ticket ${opts.ticketId}: target ${target} hit a quota limit ` +
        `(${provider}${model ? `/${model}` : ''}) — parking`,
    );
    return {
      kind: 'usage-limited',
      target,
      provider,
      model,
      detail,
      keptOutcome: JSON.stringify({
        observations: collected,
        targets: [
          ...targetOutcomes,
          { repo: target, status: 'usage-limited', observations: 0 },
          // Every target AFTER the exhausted one was never asked. Name them
          // instead of dropping them: a re-run that asked only the parked
          // target would commit a UAT verdict whose Tester evidence silently
          // omits those repositories.
          ...notRunRepos(opts.targets, targetOutcomes, target).map((repo) => ({
            repo,
            status: NOT_RUN,
            observations: 0,
          })),
        ],
      }),
    };
  };
  debug?.(
    `[gate] uat tester ticket ${opts.ticketId}: starting — ${opts.targets.length} target(s), ` +
      `cap ${cap}, token budget ${tokenBudget}, soft deadline ${softTimeoutMs}ms of ${hardTimeoutMs}ms, ` +
      `assignment ${opts.assignment.agentName ?? '?'}/${opts.assignment.provider}` +
      (opts.assignment.model ? `/${opts.assignment.model}` : ''),
  );
  try {
    for (const target of opts.targets) {
      if (opts.signal?.aborted) break;
      currentRepo = target.repo;
      debug?.(
        `[gate] uat tester ticket ${opts.ticketId}: asking target ${target.repo} ` +
          `(worktree ${target.worktreePath})`,
      );
      // 869ej1nfb: verify the checkout BEFORE spending a token. A worktree on
      // the wrong branch (or a stale local branch ref that equals the base)
      // reads as "no changes" while the ticket's real work is elsewhere — the
      // console that reported "nothing to report as a UAT observation" for a
      // ticket that carried work. When the target's branch is known and the
      // checkout disagrees, this run records the mismatch as a DETERMINISTIC
      // critical observation and skips the call: the agent could not have
      // tested the right changes, and it must not be asked to invent ones.
      const expectedBranch = target.branch?.trim() ?? '';
      const observed =
        expectedBranch !== '' ? await checkoutBranch(git, target.worktreePath) : null;
      if (observed !== null && observed !== expectedBranch) {
        const title =
          `UAT skipped: checkout is on "${observed}", not the ticket branch "${expectedBranch}"` +
          ' — nothing could be tested';
        collected.push({ severity: 'critical', repo: target.repo, title });
        debug?.(
          `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} WRONG CHECKOUT ` +
            `(on ${observed}, expected ${expectedBranch}) — skipped, recorded observation`,
        );
        opts.onTargetProgress?.({
          repo: target.repo,
          status: 'completed',
          detail: 'wrong checkout — skipped',
        });
        continue;
      }
      opts.onTargetProgress?.({ repo: target.repo, status: 'active' });
      const snapshotRef = opts.git
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
        `[gate] uat tester ${target.repo}: snapshot ${snapshotRef ?? 'unavailable — using the branch range'}`,
      );
      const basePrompt = buildTesterPrompt(
        target,
        opts.assignment.instructions,
        snapshotRef,
        {
          criteria: opts.criteria,
          intent: opts.intent,
          ticketKey: opts.ticketKey,
          contextCommand: opts.contextCommand,
          debug: opts.debug,
        },
      );
      const reaskTitle = opts.reaskTitles?.[target.repo];
      const prompt = reaskTitle === undefined ? basePrompt : `${reaskPrefix(reaskTitle)}\n\n${basePrompt}`;
      // Prompt 09: when the core declares native structured output support, ask
      // its CLI to ENFORCE the observation array shape (claude `--json-schema`,
      // codex `--output-schema`) instead of relying on the prose output rules
      // alone. Gate on the declared surface — never on the core's name — so the
      // four-adapter seam rule holds. Unsupported cores get the schema-less
      // prose prompt, unchanged.
      const structured = opts.adapter.surfaces?.structuredOutput?.supported === true;
      // Every stdout chunk the adapter streams for THIS target, kept so a run
      // the budget stops still yields whatever the agent had already written.
      const captured: string[] = [];
      const captureOutput = (chunk: HeadlessOutputChunk): void => {
        if (chunk.stream === 'stdout') captured.push(chunk.text);
        opts.onOutput?.(chunk);
      };
      const ask = (
        text: string,
        signal: AbortSignal | undefined,
        timeoutMs: number,
      ): Promise<{ raw: string }> =>
        opts.adapter.runHeadless({
          prompt: text,
          cwd: target.worktreePath,
          model: opts.assignment.model,
          effort: opts.assignment.effort,
          signal,
          timeoutMs,
          policy: 'gate',
          onOutput: captureOutput,
          ...(structured ? { outputSchema: TESTER_OUTPUT_SCHEMA } : {}),
          tracking: {
            callSite: 'uat-tester',
            ticketId: opts.ticketId,
            processRunId: run.id,
          },
        });
      // Read the run's measured spend BEFORE the call, so the per-target delta
      // is this target's own cost, not a previous target's.
      const freshBefore = recordedFreshTokens(store, run.id);
      // The SOFT time budget arms this call's own abort below the hard deadline.
      // A caller Stop still forwards, so the two are distinguishable: the
      // caller's signal is the authority, this timer is only the budget.
      const soft = linkedAbort(opts.signal, softTimeoutMs);
      let result: { raw: string } = { raw: '' };
      let stopped = false;
      try {
        result = await ask(prompt, soft.signal, hardTimeoutMs);
      } catch (error) {
        // A user Stop is terminal and wins over any budget.
        if (opts.signal?.aborted) throw error;
        // K11: the account is out of quota — not a budget stop, not a crash.
        // Keep the siblings already asked and let the stage park the ticket.
        if (classifyFailure(error) === 'usage-limited') {
          return usageLimited(error, target.repo);
        }
        // Anything that is neither our soft timer nor the spawner's deadline is
        // a genuine failure — the outer catch reports it exactly as before.
        if (!soft.fired() && !isTimedOutFailure(error)) throw error;
        stopped = true;
      } finally {
        soft.dispose();
      }
      // Fresh tokens the RUN spent on this target, read from the same ledger the
      // Inside row's token pill reads. A call the deadline killed still recorded
      // what it burned (the spawner carries the partial stream's counts on the
      // error), so the budget sees the runaway a timeout ended.
      const targetFresh = Math.max(0, recordedFreshTokens(store, run.id) - freshBefore);
      const firstRaw = result.raw;
      // Parse at most the execution cap from this one response — a single
      // target can never blow memory past the cap, whatever it returns.
      // Finding 13 follow-up: the budget is NOT a reason to skip a target;
      // every configured repository is asked, and the cap is applied once,
      // after collection.
      const parseContext = { repo: target.repo, worktreePath: target.worktreePath, max: cap };
      let parseResult: ReturnType<typeof parseFindingsResult>;
      if (stopped) {
        // The call was CUT OFF — the soft time budget fired or the hard deadline
        // landed — so this target is PARTIAL. Only a stopped call can be: a call
        // that FINISHED is recorded exactly as it answered, whatever it spent.
        // The token budget is a post-hoc REPORT (the usage is only known once a
        // call settles, so it can never cut a call short) and never a reason to
        // discard a real answer or to spend another call on it.
        partial = true;
        if (targetFresh >= tokenBudget) budgetPeak = Math.max(budgetPeak, targetFresh);
        debug?.(
          `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} stopped ` +
            `(${soft.fired() ? 'soft time budget' : 'deadline'}; ${formatTokens(targetFresh)} tok) — ` +
            'salvaging the output it streamed',
        );
        const recovered = await recoverStoppedTarget(
          captured.join(''),
          parseContext,
          (text) => ask(text, opts.signal, wrapUpTimeoutMs),
          opts.warn,
          opts.signal,
        );
        parseResult = recovered.parse;
        result = { raw: recovered.raw };
      } else {
        // SILENCE is re-asked ONCE (869ekt). A core that exits clean having said
        // nothing at all — opencode ending its turn on a tool call after minutes
        // of real testing — did the work and never wrote the answer down. The
        // nudge APPENDS to the same prompt, so the target context and the strict
        // output rules still stand, and the re-ask costs a call only on a run
        // that would otherwise have recorded nothing. UNREADABLE prose gets its
        // own, separate re-ask below (UAT-19) — a reformat, never a second
        // attempt at the same question.
        if (firstRaw.trim() === '' && !opts.signal?.aborted) {
          silenceNudges += 1;
          debug?.(
            `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} answered nothing — re-asking once`,
          );
          result = await ask(`${prompt}\n${TESTER_SILENCE_NUDGE}`, opts.signal, hardTimeoutMs);
        }
        if (opts.signal?.aborted) break;
        parseResult = parseFindingsResult(result.raw, parseContext, opts.warn);
        // UNREADABLE prose is re-asked ONCE, for reformatting only (UAT-19) —
        // the core already answered and may have found something real; only
        // the shape is wrong. Quoting its own prose back and asking for
        // nothing but the JSON array recovers that finding instead of losing
        // it to a park. Fired on the same condition the park would otherwise
        // fire on: still unreadable after this retry, and only then, the
        // target contributes nothing.
        if (parseResult.shape === 'unreadable' && !opts.signal?.aborted) {
          reformatNudges += 1;
          debug?.(
            `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} answered unreadable output — re-asking once for reformatting`,
          );
          const reformatted = await ask(
            `${prompt}\n${buildReformatNudge(result.raw)}`,
            opts.signal,
            hardTimeoutMs,
          );
          if (!opts.signal?.aborted) {
            result = reformatted;
            parseResult = parseFindingsResult(result.raw, parseContext, opts.warn);
          }
        }
      }
      if (opts.signal?.aborted) break;
      // The core exited clean but left its own probe running in a background
      // shell: whatever it answered (usually `[]`) is not a finished run.
      if (!stopped && endedOnBackgroundCommand(captured.join(''))) {
        partial = true;
        endedOnBackground = true;
        debug?.(
          `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} ended while a background command was still running — recording partial`,
        );
      }
      shapes.push(parseResult.shape);
      if (parseResult.shape === 'unreadable') {
        unreadableAnswers.push({ repo: target.repo, raw: result.raw });
      }
      // The host ALREADY proved this checkout above (`observed === expected`,
      // or the loop would have skipped the call). An agent claiming "wrong
      // checkout" anyway is reporting its own core's cwd mis-resolution, not a
      // fact about this ticket — and at a blocking severity it fails the stage
      // over changes nobody read. Only a PROVEN match drops it, and the drop is
      // reported: review's lane made exactly this trade (`checkoutClaim.ts`).
      const verifiedCheckout = observed !== null && observed === expectedBranch;
      const kept = verifiedCheckout
        ? parseResult.findings.filter((f) => !isWrongCheckoutClaim(f))
        : parseResult.findings;
      if (kept.length !== parseResult.findings.length) {
        opts.warn?.(
          `uat tester: ${target.repo} — dropped a "wrong checkout" observation. The agent reported ` +
            `it, but this worktree is on '${expectedBranch}', which is the ticket's branch; the ` +
            `claim is false and would have blocked the ticket over changes the agent did read.`,
        );
        debug?.(
          `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} — dropped ` +
            `${parseResult.findings.length - kept.length} disproven wrong-checkout claim(s)`,
        );
      }
      const { coverage: targetCoverage, rest: keptRest } = splitCoverage(kept);
      coverageRecords.push({
        ...coverageOrFallback(
          targetCoverage.map((f) => ({ severity: f.severity, repo: f.repo, file: null, line: null, title: f.title })),
          (title) => ({ severity: 'info' as Severity, repo: target.repo, title }),
        ),
        repo: target.repo,
      });
      const keptCoverage = coverageRecords[coverageRecords.length - 1];
      if (keptCoverage && observedNothing(keptCoverage.title, keptRest.length) && !stopped) {
        skippedTitles[target.repo] = keptCoverage.title;
      }
      const parsed = keptRest.map((f) => ({
        severity: f.severity,
        repo: f.repo,
        file: f.file,
        line: f.line,
        title: f.title,
      }));
      if (stopped) partialObservations += parsed.length;
      debug?.(
        `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} returned ` +
          `${parsed.length} observation(s) (${parseResult.shape}${stopped ? ', partial' : ''})`,
      );
      opts.onTargetProgress?.({
        repo: target.repo,
        status: 'completed',
        detail: `${parsed.length} observation${parsed.length === 1 ? '' : 's'}${
          stopped ? ' — partial (run stopped)' : ''
        }`,
      });
      collected.push(...parsed);
      targetOutcomes.push({ repo: target.repo, status: parseResult.shape, observations: parsed.length });
    }
    // Record how many targets needed the silence nudge (v57 prompt metrics) onto
    // the run the tester opened — a late fact written before every close path, so
    // a Stop mid-loop still records what fired. The re-ask RATE is the
    // output-contract-compliance signal prompt-metrics.md reads.
    setProcessRunPromptTelemetry(store, run.id, { silenceNudges, reformatNudges });
    if (opts.signal?.aborted) {
      debug?.(`[gate] uat tester ticket ${opts.ticketId}: stopped — interrupted`);
      close('interrupted', 'interrupted');
      return { kind: 'interrupted' };
    }
    // Every target that was actually ASKED came back unreadable, and nothing
    // deterministic was recorded either: there is no evidence here, and calling
    // that "0 observations" is the bug this branch exists to close. A PARTIAL
    // run is not this case — the budget already gave the target its one
    // wrap-up re-ask, and parking it would turn a recovered (if empty) result
    // back into an interruption.
    if (!partial && shapes.length > 0 && shapes.every((s) => s === 'unreadable') && collected.length === 0) {
      debug?.(
        `[gate] uat tester ticket ${opts.ticketId}: ${shapes.length} target(s) answered ` +
          `unreadable output — recorded no observations`,
      );
      close('failed', 'unreadable-output');
      // Bounded and sanitized ONCE here — the same collapse-then-cap every
      // other untrusted-prose field reaching a rendered surface uses — so the
      // stage can write it into the artifact log as evidence without ever
      // handing raw agent prose to a debug line or a verdict reason.
      const preview = collapseDiagnostic(
        unreadableAnswers.map((a) => `${a.repo}: ${a.raw}`).join('\n---\n'),
      );
      return { kind: 'unreadable-output', preview };
    }
    // The execution-wide cap is applied ONCE over everything every target
    // contributed, ranked by severity (critical first) and stable — ties keep
    // their original target/observation order — before the single slice.
    if (collected.length > cap) {
      debug?.(
        `[gate] uat tester ticket ${opts.ticketId}: capped ${collected.length} → ${cap} ` +
          `observation(s) by severity`,
      );
    }
    const observations = collected
      .map((finding, order) => ({ finding, order }))
      .sort(
        (a, b) =>
          SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
          a.order - b.order,
      )
      .slice(0, cap)
      .map(({ finding }) => finding);
    const findingIds = recordUatFindings(store, {
      ticketId: opts.ticketId,
      processRunId: run.id,
      // Coverage rides after the cap (never truncated, never counted below).
      findings: [...observations, ...coverageRecords],
      createdAt: now(),
    });
    // Counted over the FINAL capped list, never over `collected` — an
    // observation the cap truncated away was not recorded and must not block.
    const threshold = opts.observationsBlockingSeverity ?? 'none';
    const { blocking, blockingSummary } = countBlockingObservations(observations, threshold);
    if (partial) {
      // A run the budget stopped is recorded as `partial`, never `observed`: it
      // must not read as a clean pass even when the wrap-up recovered nothing.
      // The observations stay advisory (the verdict knob applies unchanged).
      const detail = testerPartialDetail(budgetPeak, partialObservations, endedOnBackground);
      close('failed', 'partial', detail);
      debug?.(
        `[gate] uat tester ticket ${opts.ticketId}: recorded ${findingIds.length} finding(s) — partial (${detail})`,
      );
      return blockingSummary === undefined
        ? { kind: 'partial', findingIds, blocking, detail }
        : { kind: 'partial', findingIds, blocking, blockingSummary, detail };
    }
    const skippedRepos = Object.keys(skippedTitles);
    const askedRepos = targetOutcomes.length;
    if (askedRepos > 0 && skippedRepos.length === askedRepos && observations.length === 0) {
      const firstTitle = skippedTitles[skippedRepos[0]!]!;
      const detail = skippedDetail({ repo: skippedRepos[0]!, title: firstTitle }, askedRepos);
      close('passed', 'skipped');
      debug?.(`[gate] uat tester ticket ${opts.ticketId}: recorded ${findingIds.length} finding(s) — skipped (${detail})`);
      return { kind: 'skipped', findingIds, detail };
    }
    close('passed', 'observed');
    debug?.(
      `[gate] uat tester ticket ${opts.ticketId}: recorded ${findingIds.length} finding(s) — observed` +
        (threshold === 'none'
          ? ' (observations advisory — blockingSeverity none)'
          : ` (blockingSeverity ${threshold} → ${blocking} blocking)`),
    );
    return blockingSummary === undefined
      ? { kind: 'observed', findingIds, blocking }
      : { kind: 'observed', findingIds, blocking, blockingSummary };
  } catch (error) {
    // Abort can surface as a rejected adapter promise instead of a fulfilled
    // result. Stop is terminal in either shape: it must not turn into an
    // execution failure merely because the adapter observed the signal first.
    if (opts.signal?.aborted) {
      debug?.(`[gate] uat tester ticket ${opts.ticketId}: stopped — interrupted`);
      close('interrupted', 'interrupted');
      return { kind: 'interrupted' };
    }
    // K11: a quota error can surface from the silence/reformat re-ask, which is
    // outside the inner try. Park rather than report `execution-failed`.
    if (classifyFailure(error) === 'usage-limited') {
      return usageLimited(error, currentRepo || 'unknown');
    }
    // See the doc comment: a crash is reported, never thrown — the ordinary
    // UAT gates must decide the run whatever the Tester did.
    const message = error instanceof Error ? error.message : String(error);
    const collapsed = collapseDiagnostic(message);
    debug?.(
      `[gate] uat tester ticket ${opts.ticketId}: adapter call failed — execution-failed (${collapsed})`,
    );
    // The bounded failure sentence rides onto the run so the inside Tester
    // detail renders the NAMED diagnostic (an agy permission denial, say)
    // instead of a fixed "adapter execution failed" (T652).
    close('failed', 'execution-failed', collapsed);
    return { kind: 'execution-failed', message: collapsed };
  } finally {
    if (opts.git) {
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
