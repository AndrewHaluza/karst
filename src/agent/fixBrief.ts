import type { StageKey } from '../model/types.js';
import type { StepperStageRow } from '../model/stepper.js';
import type { Finding } from '../store/reviewFindings.js';
import type { GateRun } from '../store/gateRuns.js';
import type { PrFeedbackRow } from '../store/prFeedback.js';
import { lastFailedGate } from '../workflow/fixAttempts.js';

/** "src/db.ts:42" or "src/db.ts" or "" — never a bare ":42" with nothing to attach it to. */
function findingLocation(f: Finding): string {
  if (!f.file) return '';
  return f.line ? ` (${f.file}:${f.line})` : ` (${f.file})`;
}

/**
 * "src/a.ts:42", "src/a.ts", or "(general comment)" — never a bare ":42".
 *
 * Uses `originalLine`, NEVER `line`: `line` is recomputed against the current
 * diff and goes null once the thread is outdated, so an agent reading it after
 * its own push gets nothing; `originalLine` and `originalCommitId` survive.
 */
function prFeedbackLocation(f: PrFeedbackRow): string {
  if (!f.path) return '(general comment)';
  return f.originalLine ? `${f.path}:${f.originalLine}` : f.path;
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
 * `prFeedback` (FEAT-40) is the opening set of unresolved human review threads
 * the ship-sourced recovery round adopted; appended ONLY when the failing gate
 * is `ship`, where there is no gate run to excerpt (FEAT-40's action is the only
 * writer of a failed `ship` row that carries a round).
 *
 * Pure (no store, no fs) so the wording is unit-tested.
 */
export function renderFixBrief(
  ticketLabel: string,
  stages: readonly StepperStageRow[],
  findings: readonly Finding[] = [],
  gateRuns: readonly GateRun[] = [],
  prFeedback: readonly PrFeedbackRow[] = [],
): string | null {
  // Which gate sent this ticket to `fix` — by latest `endedAt`, never by array
  // order. `StepperStageRow[]` carries no ordering contract, so with a `review`
  // row and a `ship` row both failed, `find` would let array position decide the
  // brief's header, its quoted verdict, its artifact path and whether the review
  // findings block renders. `lastFailedGate` is the driver's and the rail's own
  // resolver (workflow/fixAttempts.ts): one ranking rule, so the brief always
  // names the gate whose budget the resume is about to spend.
  const gateKey = lastFailedGate(stages);
  const gate = gateKey
    ? stages.find((s) => s.stageKey === gateKey && s.status === 'failed')
    : undefined;
  if (!gate) return null;

  // The reviewer wording is only true when feedback is actually attached. A
  // failed `ship` row with NO adopted feedback is a ship-saga failure (or a
  // crash), not a review ask — "Address every point below" would name points
  // that are not there, so it falls back to the generic gate wording.
  const isPrFeedback = gate.stageKey === 'ship' && prFeedback.length > 0;
  const lines = [
    isPrFeedback
      ? `Reviewers requested changes on the pull request for ticket ${ticketLabel}. ` +
        'Address every point below, then stop.'
      : `The ${gate.stageKey} gate failed for ticket ${ticketLabel}. Fix what it reported, ` +
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
  if (isPrFeedback) {
    lines.push('', 'The review team asked for these changes:');
    for (const f of prFeedback) {
      lines.push(`- ${f.repo} ${prFeedbackLocation(f)}`);
      if (f.author.login !== '') {
        lines.push(
          `    asked by ${f.author.login}${f.author.association !== '' ? ` (${f.author.association})` : ''}`,
        );
      }
      for (const line of f.body.split('\n')) lines.push(`    ${line}`);
    }
    lines.push(
      '',
      'The line numbers are as of the commit the reviewer commented on; the file may have moved since. ' +
        'Do not resolve the conversations yourself — karst does not have permission to, and a human will.',
    );
  }
  return lines.join('\n');
}
