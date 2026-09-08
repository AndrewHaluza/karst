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
import { parseFindingsResult, type FindingsParseShape, type WarnFn } from '../review/findings.js';
import { isWrongCheckoutClaim } from '../review/checkoutClaim.js';
import { buildScopeBlock } from '../agentScope.js';
import { OUTPUT_RULES_HEADING, OUTPUT_RULES_BASE } from '../../agent/promptText.js';
import { createReviewSnapshot, deleteReviewSnapshot } from '../reviewSnapshot.js';
import { collapseDiagnostic, cap } from '../../model/diagnosticText.js';
import { nowIso } from '../../model/time.js';

/**
 * Ceiling on the injected done-when criteria block (Prompt 17). The source is
 * `Ticket.description` — untrusted-length prose a ticket author wrote, never
 * bounded elsewhere before reaching a prompt. Matches the diagnostic-text
 * ceiling used for other untrusted prose reaching this same prompt.
 */
export const MAX_CRITERIA_CHARS = 8_000;

/** One line naming the ticket's done-when criteria as authoritative and bounding them. */
function buildCriteriaBlock(criteria: string | null | undefined): string[] {
  const trimmed = criteria?.trim() ?? '';
  if (trimmed === '') return [];
  return [
    `Done-when criteria for this ticket (authoritative — exercise each one against the running code):`,
    cap(trimmed, MAX_CRITERIA_CHARS),
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
      `attachments, running services)? Run exactly: ${contextCommand} ${ticketKey} --md`,
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
   * Host-known, READ-ONLY context: the manifest-declared service start command
   * for the target, when the repository is runnable. The Tester may use it to
   * stand the service up; it is never AI output and never a credential.
   */
  service?: { start?: string } | null;
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
   * Names of the deterministic gates the stage ALREADY ran and passed. Carried
   * into the prompt so the Tester spends its budget on behavior the gates
   * cannot check instead of re-running the suite that just went green. Absent
   * → the prompt names no gates (never a fabricated list).
   */
  gatesPassed?: readonly string[];
  /**
   * `uat.testerObservations.blockingSeverity` (Task 3.2). ABSENT → `'none'`,
   * which is the shipped behavior: observations are advisory and `blocking` is
   * always 0. Set to a severity, every recorded observation at or above it is
   * counted into the result's `blocking` — counted over the FINAL capped list,
   * so an observation the cap truncated away can never block. The count is
   * reported, never acted on here: the UAT stage owns the verdict.
   */
  observationsBlockingSeverity?: Severity | 'none';
  /** The ticket's done-when criteria (`Ticket.description`), read once by the stage. Absent/blank → no criteria block. */
  criteria?: string | null;
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
  | { kind: 'execution-failed'; message: string }
  /**
   * Every target answered, and not one answer carried a findings-shaped
   * container we could read. Distinct from `observed` with zero findings: a
   * clean run is silent BY SAYING SO (`[]`), and reading an unreadable answer
   * as a clean one is what turned a `high` observation into "0 observations —
   * advisory". Advisory still: the ordinary UAT gates decide the stage.
   */
  | { kind: 'unreadable-output' }
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
  observations: readonly { severity: Severity }[],
  threshold: Severity | 'none',
): { blocking: number; blockingSummary?: string } {
  if (threshold === 'none') return { blocking: 0 };
  const limit = SEVERITY_RANK[threshold];
  const counts = new Map<Severity, number>();
  let blocking = 0;
  for (const o of observations) {
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
  /** The ticket's done-when criteria (`Ticket.description`). Bounded, omitted when empty. */
  criteria?: string | null;
  /** The ticket's key, for the tier-1 context pointer line. */
  ticketKey?: string | null;
  /** The composed `karst context` prefix (§ context loader). Absent → no pointer line. */
  contextCommand?: string;
}

export function buildTesterPrompt(
  target: TesterTarget,
  instructions?: string,
  gatesPassed?: readonly string[],
  snapshotRef?: string | null,
  extra?: TesterPromptExtra,
): string {
  const baseClause = target.baseRef
    ? `against its base branch, \`${target.baseRef}\` (compare against \`origin/${target.baseRef}\` when available, otherwise the local \`${target.baseRef}\`).`
    : `against its base branch.`;
  const serviceClause = target.service?.start
    ? `\nThe repository's service starts with: \`${target.service.start}\`. You may stand it up to observe behavior.`
    : '';
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
          `Act as the UAT tester for the changes in this worktree (repository: ${target.repo}) ${baseClause}`,
          `Try to BREAK the changes: run them, exercise the acceptance criteria, and report what you observe.${serviceClause}`,
        ];
  return [
    ...strategy,
    // Placed between the strategy and the scope block, and NEVER displaced by
    // `instructions` (which only ever replaces the strategy lines above) —
    // the ticket's done-when criteria are authoritative for every Tester run.
    ...buildCriteriaBlock(extra?.criteria),
    // Named BEFORE the scope block so its ban exception (`agentScope.ts`) can
    // say "the command named above" and mean this line.
    ...buildContextPointerLine(extra?.contextCommand, extra?.ticketKey),
    ``,
    // Never replaced by `instructions` — see `workflow/agentScope.ts`.
    ...buildScopeBlock('test', {
      baseRef: target.baseRef,
      branch: target.branch,
      worktreePath: target.worktreePath,
      gatesPassed,
      snapshotRef,
      contextCommand: extra?.contextCommand,
    }),
    ``,
    OUTPUT_RULES_HEADING,
    ...OUTPUT_RULES_BASE,
    `- No observations worth reporting → output exactly [].`,
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
  ): void => {
    finishProcessRun(store, run.id, status, now(), resultKind);
  };

  const cap = opts.maxObservations ?? DEFAULT_MAX_TESTER_OBSERVATIONS;
  const collected: UatFindingInput[] = [];
  // One shape per target actually ASKED — the deterministic wrong-checkout
  // `continue` below pushes nothing here, since it never asked the core.
  const shapes: FindingsParseShape[] = [];
  // v57 prompt metrics: how many targets answered NOTHING and were re-asked once.
  // The tester's OWN run carries it (it opened that run), mirroring how the review
  // lane records its parse tiers — never a verdict input, never a second row.
  let silenceNudges = 0;
  const debug = opts.debug;
  const git = opts.git ?? defaultGitRunner;
  const snapshotted: { repo: string; worktreePath: string }[] = [];
  debug?.(
    `[gate] uat tester ticket ${opts.ticketId}: starting — ${opts.targets.length} target(s), ` +
      `cap ${cap}, assignment ${opts.assignment.agentName ?? '?'}/${opts.assignment.provider}` +
      (opts.assignment.model ? `/${opts.assignment.model}` : ''),
  );
  try {
    for (const target of opts.targets) {
      if (opts.signal?.aborted) break;
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
      const prompt = buildTesterPrompt(
        target,
        opts.assignment.instructions,
        opts.gatesPassed,
        snapshotRef,
        { criteria: opts.criteria, ticketKey: opts.ticketKey, contextCommand: opts.contextCommand },
      );
      const ask = (text: string): Promise<{ raw: string }> =>
        opts.adapter.runHeadless({
          prompt: text,
          cwd: target.worktreePath,
          model: opts.assignment.model,
          effort: opts.assignment.effort,
          signal: opts.signal,
          timeoutMs: opts.timeoutMs ?? GATE_LANE_HEADLESS_TIMEOUT_MS,
          onOutput: opts.onOutput,
          tracking: {
            callSite: 'uat-tester',
            ticketId: opts.ticketId,
            processRunId: run.id,
          },
        });
      let result = await ask(prompt);
      // SILENCE is re-asked ONCE (869ekt). A core that exits clean having said
      // nothing at all — opencode ending its turn on a tool call after minutes
      // of real testing — did the work and never wrote the answer down. The
      // nudge APPENDS to the same prompt, so the target context and the strict
      // output rules still stand, and the re-ask costs a call only on a run
      // that would otherwise have recorded nothing. Unreadable PROSE is NOT
      // re-asked: the core answered, it just answered the wrong shape, and
      // asking the same question again buys a second helping of prose.
      if (result.raw.trim() === '' && !opts.signal?.aborted) {
        silenceNudges += 1;
        debug?.(
          `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} answered nothing — re-asking once`,
        );
        result = await ask(`${prompt}\n${TESTER_SILENCE_NUDGE}`);
      }
      if (opts.signal?.aborted) break;
      // Parse at most the execution cap from this one response — a single
      // target can never blow memory past the cap, whatever it returns.
      // Finding 13 follow-up: the budget is NOT a reason to skip a target;
      // every configured repository is asked, and the cap is applied once,
      // after collection.
      const parseResult = parseFindingsResult(
        result.raw,
        {
          repo: target.repo,
          worktreePath: target.worktreePath,
          max: cap,
        },
        opts.warn,
      );
      shapes.push(parseResult.shape);
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
      const parsed = kept.map((f) => ({
        severity: f.severity,
        repo: f.repo,
        file: f.file,
        line: f.line,
        title: f.title,
      }));
      debug?.(
        `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} returned ` +
          `${parsed.length} observation(s) (${parseResult.shape})`,
      );
      opts.onTargetProgress?.({
        repo: target.repo,
        status: 'completed',
        detail: `${parsed.length} observation${parsed.length === 1 ? '' : 's'}`,
      });
      collected.push(...parsed);
    }
    // Record how many targets needed the silence nudge (v57 prompt metrics) onto
    // the run the tester opened — a late fact written before every close path, so
    // a Stop mid-loop still records what fired. The re-ask RATE is the
    // output-contract-compliance signal prompt-metrics.md reads.
    setProcessRunPromptTelemetry(store, run.id, { silenceNudges });
    if (opts.signal?.aborted) {
      debug?.(`[gate] uat tester ticket ${opts.ticketId}: stopped — interrupted`);
      close('interrupted', 'interrupted');
      return { kind: 'interrupted' };
    }
    // Every target that was actually ASKED came back unreadable, and nothing
    // deterministic was recorded either: there is no evidence here, and calling
    // that "0 observations" is the bug this branch exists to close.
    if (shapes.length > 0 && shapes.every((s) => s === 'unreadable') && collected.length === 0) {
      debug?.(
        `[gate] uat tester ticket ${opts.ticketId}: ${shapes.length} target(s) answered ` +
          `unreadable output — recorded no observations`,
      );
      close('failed', 'unreadable-output');
      return { kind: 'unreadable-output' };
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
      findings: observations,
      createdAt: now(),
    });
    close('passed', 'observed');
    // Counted over the FINAL capped list, never over `collected` — an
    // observation the cap truncated away was not recorded and must not block.
    const threshold = opts.observationsBlockingSeverity ?? 'none';
    const { blocking, blockingSummary } = countBlockingObservations(observations, threshold);
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
    // See the doc comment: a crash is reported, never thrown — the ordinary
    // UAT gates must decide the run whatever the Tester did.
    const message = error instanceof Error ? error.message : String(error);
    const collapsed = collapseDiagnostic(message);
    debug?.(
      `[gate] uat tester ticket ${opts.ticketId}: adapter call failed — execution-failed (${collapsed})`,
    );
    close('failed', 'execution-failed');
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
