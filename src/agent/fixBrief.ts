import type { StageKey } from '../model/types.js';
import type { StepperStageRow } from '../model/stepper.js';
import type { Finding } from '../store/reviewFindings.js';
import type { GateRun } from '../store/gateRuns.js';
import type { PrFeedbackRow } from '../store/prFeedback.js';
import { lastFailedGate } from '../workflow/fixAttempts.js';
import { isCoverageRecord } from '../model/coverageRecord.js';
import { PROCESS_KILL_RULE } from './promptText.js';

export const PROTOTYPE_REGION_CHECKLIST_RULE =
  'Per @ui:UI-R39-REJECT, post a per-region checklist of the linked prototype (`karst notes post`) at the start of the fix and update it before finishing.';

/**
 * Returns true when a ticket references a prototype in its description, brief, or title.
 */
export function hasLinkedPrototype(ticket: {
  title?: string | null;
  description?: string | null;
  brief?: string | null;
}): boolean {
  const text = `${ticket.title ?? ''}\n${ticket.description ?? ''}\n${ticket.brief ?? ''}`;
  return /\bprototype\b/i.test(text) || /docs\/design\/[^\s)]+\.html/i.test(text);
}

export interface RenderFixBriefOptions {
  /** The ticket has a linked prototype (ui:UI-R39-REJECT per-region checklist rule). */
  readonly hasPrototype?: boolean;
}

/**
 * "src/db.ts:42" or "src/db.ts" or "" — never a bare ":42" with nothing to attach it to. */
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
 * The rows of a stage's LATEST recorded batch. Chosen by greatest `runAt`, never
 * by array position (the store's ordering is not a contract), mirroring
 * `model/inside/gates.ts`'s `latestBatch` without importing it. With no
 * `stageKey` it spans the whole ticket.
 */
function latestBatchRows(runs: readonly GateRun[], stageKey?: StageKey): GateRun[] {
  const mine = stageKey === undefined ? runs : runs.filter((r) => r.stageKey === stageKey);
  const latest = mine.reduce<string | null>(
    (max, r) => (max === null || r.runAt > max ? r.runAt : max),
    null,
  );
  if (latest === null) return [];
  return mine.filter((r) => r.runAt === latest);
}

/**
 * The FAILING gates of a stage's LATEST recorded batch — the rows whose output
 * excerpt the fix session must act on. A skipped gate or one that answered
 * nothing is not a failure and carries nothing to fix.
 */
function latestFailingGates(stageKey: StageKey, runs: readonly GateRun[]): GateRun[] {
  return latestBatchRows(runs, stageKey).filter(
    (r) => !r.skipped && r.exitCode !== null && r.exitCode !== 0,
  );
}

export const FIX_GATE_LIST_HEADER =
  'Before the marker, run each gate below whose files your fix changes:';
/** Most gate lines a fix brief lists; the rest are counted, not shown. */
export const FIX_GATE_LIST_MAX = 12;

/**
 * One line per non-skipped gate of the latest batch: the failed stage's own
 * batch, else the ticket's latest batch (a `review` failure records no gate
 * rows of its own; the UAT batch holds the commands the host runs).
 */
function gateCommandLines(stageKey: StageKey, runs: readonly GateRun[]): string[] {
  const own = latestBatchRows(runs, stageKey);
  const batch = (own.length > 0 ? own : latestBatchRows(runs)).filter((r) => !r.skipped);
  if (batch.length === 0) return [];
  const lines = batch.slice(0, FIX_GATE_LIST_MAX).map((r) => {
    const cmd = [r.command ?? '', ...(r.args ?? [])].filter((p) => p !== '').join(' ');
    return `- ${r.gateName}: ${cmd}`;
  });
  const cut = batch.length - lines.length;
  if (cut > 0) lines.push(`(${cut} more gates not shown)`);
  return ['', FIX_GATE_LIST_HEADER, ...lines];
}

/** Said once in a gate-failure brief: a refused marker the host re-run cannot clear is a valid stop. */
export const FIX_REFUSED_STOP_RULE =
  'If the done marker is refused with no new commit and the host re-run still fails, stop and wait for the user — that is a valid stopping point.';

/** Said once in a failed review gate brief: repair the whole defect class, not only the reported site. */
export const REVIEW_SWEEP_RULE =
  'For each finding, name the rule it breaks. Search the repository for each site of that rule. Fix each site. List the sites in the commit body.';

/** The docs gate's BLOCK line (scripts/docsGate.mjs) — the cue that a cite is a way out. */
const DOCS_GATE_BLOCK = /BLOCK diff changes /u;
const DOCS_GATE_CITE_RULE =
  'The docs gate blocked a change to code that an @arch block covers. There are two ways out. ' +
  'Edit the block and commit the edit. Or decide that the block still holds, and run ' +
  '`karst arch cite @arch:KEY --why "<one-line reason>"` with the key from the BLOCK line. ' +
  'The gate output above stays the source for the key, symbol and block file.';

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
  options?: RenderFixBriefOptions,
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
    // A fix session runs shell commands to reproduce and re-run checks; it must
    // stop only what it started (`kill $!`), never a process-wide `pkill`.
    '',
    PROCESS_KILL_RULE,
  ];
  if (!isPrFeedback) lines.push('', FIX_REFUSED_STOP_RULE);
  if (gate.stageKey === 'review') lines.push('', REVIEW_SWEEP_RULE);
  if (gate.verdict) lines.push('', `It reported: ${gate.verdict}`);
  if (options?.hasPrototype && (!gate.verdict || !gate.verdict.includes('@ui:UI-R39-REJECT'))) {
    lines.push('', PROTOTYPE_REGION_CHECKLIST_RULE);
  }
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
  if (failures.some((f) => f.summary && DOCS_GATE_BLOCK.test(f.summary)) || (gate.verdict && DOCS_GATE_BLOCK.test(gate.verdict))) {
    lines.push('', DOCS_GATE_CITE_RULE);
  }
  if (!isPrFeedback) lines.push(...gateCommandLines(gate.stageKey, gateRuns));
  if (gate.artifactPath) lines.push('', `Its full output is at ${gate.artifactPath} — read it first.`);
  // The advisory coverage record is evidence of what review covered, not a defect to fix.
  const fixable = findings.filter((f) => !isCoverageRecord(f));
  if (gate.stageKey === 'review' && fixable.length > 0) {
    lines.push('', 'Review also recorded these findings about the diff:');
    for (const f of fixable) {
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
