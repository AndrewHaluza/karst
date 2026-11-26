/**
 * The UAT step's half of the baseline pre-check (@arch:BASELINE-PRECHECK):
 * build the inputs from the ticket and the branch, run `precheckBaselines`,
 * record the approvals in ONE transaction, and return the report section plus
 * the entries that still wait for the user.
 *
 * Kept out of `uat.ts` (already the orchestration seam) so the stage only
 * grows a call site. The gate's own rules — eligibility, the skip list, the
 * token cap, the fail safe — live in `workflow/gates/baselinePrecheck.ts`.
 */

import type { AgentAdapter } from '../../agent/adapter.js';
import type { HeadlessOutputChunk } from '../../agent/headlessSpawn.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import type { GitRunner } from '../../integrations/git.js';
import { collapseDiagnostic } from '../../model/diagnosticText.js';
import { nowIso } from '../../model/time.js';
import {
  baselineKey,
  recordBaselineDecisions,
  type BaselineDecision,
  type BaselineDecisionInput,
} from '../../store/baselineDecisions.js';
import type { Store } from '../../store/db.js';
import { precheckBaselines } from '../gates/baselinePrecheck.js';
import type { BaselineEntry } from '../gates/baselineReview.js';

/** The ticket prose the prompt quotes; `getTicket` carries nulls until a field is filled. */
export interface UatBaselinePrecheckTicket {
  title: string | null;
  description: string | null;
  brief: string | null;
  /** The canonical black-box intent; the Tester prompt uses this field as its charter. */
  intent?: string | null;
}

export interface UatBaselinePrecheckInput {
  store: Store;
  ticketId: number;
  /** The entries still waiting for the user when the step begins. */
  pending: readonly BaselineEntry[];
  /** The latest decisions per `baselineKey`, before this pre-check. */
  decisions: ReadonlyMap<string, BaselineDecision>;
  ticket: UatBaselinePrecheckTicket;
  /** The Tester's assignment and adapter; the pre-check reuses them (no new process role). */
  tester?: { assignment: ProcessAssignmentSnapshot; adapter: AgentAdapter };
  /** The stage's git seam; reads the branch's `src/ui` diff for the prompt. */
  git: GitRunner;
  debug?: (message: string) => void;
  onLiveOutput?: (chunk: HeadlessOutputChunk) => void;
  stageRunId?: number | null;
  attempt?: number;
  signal?: AbortSignal;
  now?: () => string;
  /** The module seam; production uses `precheckBaselines`, tests inject a fake. */
  precheck?: typeof precheckBaselines;
}

export interface UatBaselinePrecheckApproval {
  repo: string;
  path: string;
  /** The model's reason, raw (the UAT step prefixes `pre-check: `). */
  reason: string;
}

export interface UatBaselinePrecheckOutcome {
  /** What the pre-check approved and the store recorded. Empty on every failure/skip. */
  approved: readonly UatBaselinePrecheckApproval[];
  /** The report section; present only when at least one approval was recorded. */
  section?: string;
}

/**
 * The `src/ui/**` paths of the branch diff, one `git diff` per worktree/merge-base
 * pair the pending entries came from. A git failure is an empty list plus one
 * debug line: a missing hint must never fail the review.
 */
async function changedUiPaths(input: UatBaselinePrecheckInput): Promise<string[]> {
  const bases = new Map<string, { cwd: string; mergeBase: string }>();
  for (const entry of input.pending) {
    bases.set(`${entry.cwd}\0${entry.mergeBase}`, { cwd: entry.cwd, mergeBase: entry.mergeBase });
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const { cwd, mergeBase } of bases.values()) {
    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await input.git(['diff', '--name-only', mergeBase, 'HEAD', '--', 'src/ui'], cwd);
    } catch (error) {
      input.debug?.(
        `[gate] uat baseline pre-check ticket ${input.ticketId}: could not read the src/ui diff in ` +
          `${cwd} (${collapseDiagnostic(error instanceof Error ? error.message : String(error))}) — ` +
          'sending no UI paths',
      );
      continue;
    }
    if (result.exitCode !== 0) {
      input.debug?.(
        `[gate] uat baseline pre-check ticket ${input.ticketId}: could not read the src/ui diff in ` +
          `${cwd} (git exit ${result.exitCode}) — sending no UI paths`,
      );
      continue;
    }
    for (const line of result.stdout.split('\n')) {
      const path = line.trim();
      if (path === '' || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Run the pre-check and record its approvals. Never throws: any error (the
 * module, the git hint, the transaction) returns no approvals, so the caller's
 * baseline-review block behaves exactly as it does without the pre-check.
 */
export async function runUatBaselinePrecheck(
  input: UatBaselinePrecheckInput,
): Promise<UatBaselinePrecheckOutcome> {
  const precheck = input.precheck ?? precheckBaselines;
  const now = input.now ?? nowIso;
  try {
    const uiPaths = await changedUiPaths(input);
    const result = await precheck({
      store: input.store,
      ticketId: input.ticketId,
      // The UAT step calls this only when the knob is on; the gate still keeps
      // its own enabled check so a future caller cannot bypass the opt-in.
      enabled: true,
      entries: input.pending,
      decisions: input.decisions,
      ticket: {
        title: input.ticket.title ?? '',
        description: input.ticket.description ?? '',
        // The Tester's charter field is `intent`; fall back to the ticket form's brief.
        brief: input.ticket.intent ?? input.ticket.brief ?? '',
      },
      uiPaths,
      ...(input.tester === undefined ? {} : { tester: input.tester }),
      ...(input.debug === undefined ? {} : { debug: input.debug }),
      ...(input.onLiveOutput === undefined ? {} : { onLiveOutput: input.onLiveOutput }),
      ...(input.stageRunId === undefined ? {} : { stageRunId: input.stageRunId }),
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.approved.length === 0) return { approved: [] };

    const byKey = new Map(input.pending.map((entry) => [baselineKey(entry.repo, entry.path), entry]));
    const rows: BaselineDecisionInput[] = [];
    const approved: UatBaselinePrecheckApproval[] = [];
    for (const approval of result.approved) {
      // The sha recorded is the entry detected NOW, never one the model named:
      // a re-record between detection and here lapses the decision as usual.
      const entry = byKey.get(baselineKey(approval.repo, approval.path));
      if (entry === undefined) continue;
      rows.push({
        repo: entry.repo,
        path: entry.path,
        sha256: entry.newSha256,
        decision: 'approved',
        reason: `pre-check: ${approval.reason}`,
        decidedBy: 'precheck',
      });
      approved.push({ repo: entry.repo, path: entry.path, reason: approval.reason });
    }
    if (rows.length === 0) return { approved: [] };

    // One transaction: either every pre-check approval lands or none does.
    recordBaselineDecisions(input.store, input.ticketId, rows, now());
    const remaining = Math.max(0, input.pending.length - approved.length);
    const section = [
      `# baseline pre-check`,
      ...approved.map((entry) => `${entry.repo}:${entry.path} — pre-check: ${entry.reason}`),
      `${approved.length} approved by the pre-check, ${remaining} left for you`,
    ].join('\n');
    input.debug?.(
      `[gate] uat baseline pre-check ticket ${input.ticketId}: recorded ${approved.length} approval(s), ` +
        `${remaining} left for the user`,
    );
    return { approved, section };
  } catch (error) {
    const detail = collapseDiagnostic(error instanceof Error ? error.message : String(error));
    input.debug?.(
      `[gate] uat baseline pre-check ticket ${input.ticketId}: failed (${detail}) — no approvals, ` +
        'the baseline review blocks as today',
    );
    return { approved: [] };
  }
}
