/**
 * The UAT Tester process (Task 8) — the ONE AI process in UAT, run only after
 * the required gates pass. It asks an agent core for structured OBSERVATIONS
 * of a ticket's behavior and records them as advisory evidence.
 *
 * The observations can never pass, fail, transition, or spend a recovery
 * round by themselves: `aggregateUat` never sees them, and only the optional
 * deterministic `uat.testerVerifier` boundary (the stage's job, in
 * `uat/testerVerifier.ts`) is a Tester-specific verdict source. The process
 * run is opened HERE, before the first AI call, with the resolved assignment
 * snapshot — so the row exists durably (a host restart mid-call leaves a
 * `running` row the activation sweep marks stale), carries WHO ran it as it
 * was at launch, and is finished with an explicit result kind
 * (`observed`/`execution-failed`/`interrupted`).
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
import type { Severity } from '../../manifest/types.js';
import { openProcessRun, finishProcessRun } from '../../store/processRuns.js';
import { stageAttempt } from '../../store/stages.js';
import { recordUatFindings, type UatFindingInput } from '../../store/uatFindings.js';
import { parseFindings, type WarnFn } from '../review/findings.js';
import { collapseDiagnostic } from '../../model/diagnosticText.js';
import { nowIso } from '../../model/time.js';

/** One target the Tester asks about — the same shape UAT already plans. */
export interface TesterTarget {
  /** The repository path; every observation is attributed HERE, never to the model's own claim. */
  repo: string;
  /** The repository's worktree root; both the call's `cwd` and the parse containment root. */
  worktreePath: string;
  /** The plain base branch name (`worktrees.base_ref`), when known. */
  baseRef?: string | null;
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
  warn?: WarnFn;
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
}

/**
 * The closed Tester result. `observed` is the ONLY advisory success — it
 * carries the ids of the recorded rows; `execution-failed` is an adapter crash
 * (the stage warns and lets the gates decide); `interrupted` is a Stop.
 */
export type TesterRunResult =
  | { kind: 'observed'; findingIds: number[] }
  | { kind: 'execution-failed'; message: string }
  | { kind: 'interrupted' };

export const DEFAULT_MAX_TESTER_OBSERVATIONS = 100;

/** Rank for the cap sort — lower survives a cut first. Closed over the same `Severity` vocabulary `uat_findings` records. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

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
 * asked to invent one.
 */
export function buildTesterPrompt(target: TesterTarget): string {
  const baseClause = target.baseRef
    ? `against its base branch, \`${target.baseRef}\` (compare against \`origin/${target.baseRef}\` when available, otherwise the local \`${target.baseRef}\`).`
    : `against its base branch.`;
  const serviceClause = target.service?.start
    ? `\nThe repository's service starts with: \`${target.service.start}\`. You may stand it up to observe behavior.`
    : '';
  return [
    `Act as the UAT tester for the changes in this worktree (repository: ${target.repo}) ${baseClause}`,
    `Try to BREAK the changes: run them, exercise the acceptance criteria, and report what you observe.${serviceClause}`,
    `Output rules (strict):`,
    `- Output ONLY a JSON array, nothing else: no preamble, no markdown fence, no commentary.`,
    `- Each element: {"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "detail": string, "file"?: string, "line"?: number}.`,
    `- "file" must be a path RELATIVE to this worktree's root — never absolute, never outside it.`,
    `- "title" is one short sentence; "detail" carries the explanation.`,
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
  const debug = opts.debug;
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
      const result = await opts.adapter.runHeadless({
        prompt: buildTesterPrompt(target),
        cwd: target.worktreePath,
        model: opts.assignment.model,
        signal: opts.signal,
        tracking: {
          callSite: 'uat-tester',
          ticketId: opts.ticketId,
          processRunId: run.id,
        },
      });
      if (opts.signal?.aborted) break;
      // Parse at most the execution cap from this one response — a single
      // target can never blow memory past the cap, whatever it returns.
      // Finding 13 follow-up: the budget is NOT a reason to skip a target;
      // every configured repository is asked, and the cap is applied once,
      // after collection.
      const parsed = parseFindings(
        result.raw,
        {
          repo: target.repo,
          worktreePath: target.worktreePath,
          max: cap,
        },
        opts.warn,
      ).map((f) => ({
        severity: f.severity,
        repo: f.repo,
        file: f.file,
        line: f.line,
        title: f.title,
      }));
      debug?.(
        `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} returned ` +
          `${parsed.length} observation(s)`,
      );
      collected.push(...parsed);
    }
    if (opts.signal?.aborted) {
      debug?.(`[gate] uat tester ticket ${opts.ticketId}: stopped — interrupted`);
      close('interrupted', 'interrupted');
      return { kind: 'interrupted' };
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
    debug?.(
      `[gate] uat tester ticket ${opts.ticketId}: recorded ${findingIds.length} finding(s) — observed`,
    );
    return { kind: 'observed', findingIds };
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
  }
}
