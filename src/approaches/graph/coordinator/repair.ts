/**
 * Compile repair loop (Slice 2 Task 9).
 *
 * A rejected graph document returns to the SAME PlannerRun with the
 * compiler's structured diagnostics as input, up to 3 compile attempts total
 * for that run, then the run fails to `graph-plan-invalid`. Attempts
 * increment `compile_attempt` on the planner run and create NO new planner
 * runs, so they cost no planner-run or expert-run budget. A planner returning
 * byte-identical invalid output still terminates at 3 — no progress check is
 * attempted — and a different invalid document is handled identically,
 * carrying the NEWEST diagnostics forward to the next attempt.
 *
 * Host-agnostic: the planner invocation, the parse+compile step, and the
 * diagnostics file write are injected.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import type { CompileDiagnostic, CompiledGraph } from '../compile.js';
import { emitGraphDiagnostic } from '../diagnostics.js';

export const MAX_COMPILE_ATTEMPTS = 3;

export type ParseCompileOutcome =
  | { ok: true; compiled: CompiledGraph }
  | { ok: false; diagnostics: CompileDiagnostic[] };

export interface CompileRepairDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing. */
  transaction: <T>(fn: () => T) => T;
  /** Produce the next graph.json bytes for this planner run. The
   *  diagnostics of attempt N arrive as input to attempt N+1 (attempt 1
   *  receives []). Returns undefined when the planner produced nothing. */
  runPlanner: (
    plannerRunId: number,
    attempt: number,
    diagnostics: CompileDiagnostic[],
  ) => Uint8Array | undefined;
  parseAndCompile: (bytes: Uint8Array) => ParseCompileOutcome;
  /** Persist the newest diagnostics where the next attempt reads them. */
  writeDiagnostics: (
    plannerRunId: number,
    attempt: number,
    diagnostics: CompileDiagnostic[],
  ) => void;
  debug?: (message: string) => void;
}

export type CompileRepairResult =
  | { ok: true; compiled: CompiledGraph; attempts: number }
  | {
      ok: false;
      code: 'graph-plan-invalid' | 'planner-no-output';
      attempts: number;
      diagnostics: CompileDiagnostic[];
    };

/** Record the attempt counter on the planner run, durably, per attempt. The
 *  `compile_attempt` column is the ONE durable attempt counter — the live
 *  accept path (`acceptSubmittedPlan`) records through this same helper, so
 *  there is never a second counter to drift from it. */
export function recordCompileAttempt(
  deps: Pick<CompileRepairDeps, 'db'>,
  plannerRunId: number,
  attempt: number,
): void {
  deps.db
    .prepare('UPDATE approach_planner_runs SET compile_attempt = ? WHERE id = ?')
    .run(attempt, plannerRunId);
}

export interface CompileAttemptDecision {
  /** The attempt number this rejection consumes (1-based). */
  attempt: number;
  /** True when no attempt remains — the caller must fail to
   *  `graph-plan-invalid` rather than re-prompt. */
  exhausted: boolean;
}

/**
 * The pure attempt-counting decision, shared by the async orchestration below
 * and the synchronous live accept path: given the planner run's durable
 * `compile_attempt`, name the attempt a fresh rejection consumes and whether
 * the run has any attempt left.
 */
export function nextCompileAttempt(
  db: GraphDb,
  plannerRunId: number,
): CompileAttemptDecision {
  const row = db
    .prepare('SELECT compile_attempt FROM approach_planner_runs WHERE id = ?')
    .get(plannerRunId) as { compile_attempt: number } | undefined;
  const attempt = (row?.compile_attempt ?? 0) + 1;
  return { attempt, exhausted: attempt >= MAX_COMPILE_ATTEMPTS };
}

function recordAttempt(deps: CompileRepairDeps, plannerRunId: number, attempt: number): void {
  deps.transaction(() => recordCompileAttempt(deps, plannerRunId, attempt));
}

/** The first two diagnostics as `code: where` — bounded on purpose: the
 *  diagnostics FILE is the full record, this is the line that says which
 *  rejection keeps repeating. */
export function describeDiagnostics(diagnostics: CompileDiagnostic[]): string {
  if (diagnostics.length === 0) return 'no diagnostics';
  return diagnostics
    .slice(0, 2)
    .map((d) => `${d.code}: ${d.where}`)
    .join('; ');
}

export function compileWithRepair(
  plannerRunId: number,
  deps: CompileRepairDeps,
): CompileRepairResult {
  const run = deps.db
    .prepare('SELECT graph_run_id FROM approach_planner_runs WHERE id = ?')
    .get(plannerRunId) as { graph_run_id: number } | undefined;
  const graphRunId = run?.graph_run_id;
  const emit = graphRunId === undefined
    ? (): void => {}
    : (detail: string): void => {
        emitGraphDiagnostic({ db: deps.db, debug: deps.debug }, {
          category: 'compile',
          graphRunId,
          plannerRunId,
          detail,
        });
      };
  let diagnostics: CompileDiagnostic[] = [];
  for (let attempt = 1; attempt <= MAX_COMPILE_ATTEMPTS; attempt++) {
    const bytes = deps.runPlanner(plannerRunId, attempt, diagnostics);
    recordAttempt(deps, plannerRunId, attempt);
    if (bytes === undefined) {
      // The planner produced nothing — an execution-class failure, not a
      // compile rejection — but the attempt still counts against the run's
      // compile budget.
      emit(`attempt ${attempt} planner produced no output`);
      return { ok: false, code: 'planner-no-output', attempts: attempt, diagnostics };
    }
    const outcome = deps.parseAndCompile(bytes);
    if (outcome.ok) {
      emit(`attempt ${attempt} accepted`);
      return { ok: true, compiled: outcome.compiled, attempts: attempt };
    }
    diagnostics = outcome.diagnostics;
    deps.writeDiagnostics(plannerRunId, attempt, diagnostics);
    // Naming the FIRST diagnostic is what makes a repeat rejection legible: a
    // planner re-prompted three times on the same `reserved-identifier` at the
    // same field is a prompt defect, and a count alone hides that completely.
    emit(`attempt ${attempt} rejected (${diagnostics.length} diagnostics): ${describeDiagnostics(diagnostics)}`);
  }
  emit(
    `graph-plan-invalid after ${MAX_COMPILE_ATTEMPTS} attempts: ${describeDiagnostics(diagnostics)}`,
  );
  return {
    ok: false,
    code: 'graph-plan-invalid',
    attempts: MAX_COMPILE_ATTEMPTS,
    diagnostics,
  };
}
