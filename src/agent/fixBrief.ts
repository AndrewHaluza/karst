import type { StageKey } from '../model/types.js';
import type { StepperStageRow } from '../model/stepper.js';
import type { Finding } from '../store/reviewFindings.js';
import type { GateRun } from '../store/gateRuns.js';

/** The deterministic gates whose failure is what a `fix` session must address. */
const GATES: readonly StageKey[] = ['uat', 'review'] as const;

/** "src/db.ts:42" or "src/db.ts" or "" — never a bare ":42" with nothing to attach it to. */
function findingLocation(f: Finding): string {
  if (!f.file) return '';
  return f.line ? ` (${f.file}:${f.line})` : ` (${f.file})`;
}

/**
 * The FAILING gates of a stage's LATEST recorded batch — the rows whose output
 * excerpt the fix session must act on. Chosen by greatest `runAt`, never by
 * array position (the store's ordering is not a contract), mirroring
 * `model/inside/gates.ts`'s `latestBatch` without importing it. A skipped gate
 * or one that answered nothing is not a failure and carries nothing to fix.
 */
function latestFailingGates(stageKey: StageKey, runs: readonly GateRun[]): GateRun[] {
  const mine = runs.filter((r) => r.stageKey === stageKey);
  const latest = mine.reduce<string | null>(
    (max, r) => (max === null || r.runAt > max ? r.runAt : max),
    null,
  );
  if (latest === null) return [];
  return mine.filter(
    (r) => r.runAt === latest && !r.skipped && r.exitCode !== null && r.exitCode !== 0,
  );
}

/**
 * The opening prompt for a session resumed at `fix`. A bare "continue the work"
 * wastes the one thing karst knows and the agent does not: which gate failed, why
 * (the recorded verdict), what it actually reported (the failing gates' bounded
 * output excerpts), and where the full output is. Returns null when no gate
 * is failed — there is nothing specific to fix, so the caller keeps its generic
 * resume line.
 *
 * `findings` is review's Lane B evidence (§ task 13's `stages/review.ts`
 * wiring) — appended ONLY when the failing gate is `review`. Findings are
 * review-only, so passing a stale batch from a prior review run alongside a
 * `uat` failure must never read as if it belonged to that failure; the caller
 * is trusted to pass the ticket's LATEST batch, but this function still guards
 * the attribution itself rather than assuming the caller got it right.
 *
 * `gateRuns` (v46) is the ticket's recorded gate evidence; the FAILING gates of
 * the failed stage's latest batch supply the actionable excerpt — the "what
 * failed (file, line, rule)" a linter or test runner printed — so a fix
 * session is pointed at the defect, not just at the log that names it.
 *
 * Pure (no store, no fs) so the wording is unit-tested.
 */
export function renderFixBrief(
  ticketLabel: string,
  stages: readonly StepperStageRow[],
  findings: readonly Finding[] = [],
  gateRuns: readonly GateRun[] = [],
): string | null {
  const gate = stages.find((s) => GATES.includes(s.stageKey) && s.status === 'failed');
  if (!gate) return null;

  const lines = [
    `The ${gate.stageKey} gate failed for ticket ${ticketLabel}. Fix what it reported, ` +
      'then re-run the checks yourself to confirm they pass.',
  ];
  if (gate.verdict) lines.push('', `It reported: ${gate.verdict}`);
  const failures = latestFailingGates(gate.stageKey, gateRuns);
  // The section exists to carry the ACTIONABLE excerpt; a failing gate that
  // recorded no summary adds nothing the verdict does not already say.
  if (failures.some((f) => f.summary)) {
    lines.push('', 'The failing gates reported:');
    for (const f of failures) {
      lines.push(`- ${f.gateName} (exit ${f.exitCode})`);
      if (f.summary) {
        for (const line of f.summary.split('\n')) lines.push(`    ${line}`);
      }
    }
  }
  if (gate.artifactPath) lines.push('', `Its full output is at ${gate.artifactPath} — read it first.`);
  if (gate.stageKey === 'review' && findings.length > 0) {
    lines.push('', 'Review also recorded these findings about the diff:');
    for (const f of findings) {
      lines.push(`- [${f.severity}] ${f.title}${findingLocation(f)}`);
    }
  }
  return lines.join('\n');
}
