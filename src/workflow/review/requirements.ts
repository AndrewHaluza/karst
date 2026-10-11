/**
 * Cross-repo reconcile for ticket-level conformance findings (file-less,
 * keyed by `requirement`). Kept out of `findingsLane.ts` (already large).
 */
import type { GitRunner } from '../../integrations/git.js';
import type { Finding } from './findings.js';

/** Normalize a ticket-level requirement key: case- and whitespace-insensitive. */
function requirementKey(requirement: string): string {
  return requirement.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A file-less finding that names a requirement is held for the cross-repo reconcile. */
export function isRequirementFinding(f: Finding): boolean {
  return !f.file && !!f.requirement && requirementKey(f.requirement) !== '';
}

/**
 * A requirement is reported once, and ONLY when every VOTER reported it. A voter
 * is a target the HOST positively knows answered READABLY about a NON-EMPTY diff
 * range. Any uncertainty (crash, unreadable output, probe that could not answer,
 * checkout claim, empty-diff observation) makes a target a NON-voter, because
 * its silence is not a vote that the requirement was delivered — a non-voter
 * never cancels a gap (dropping a real gap on a non-answer is the unsafe
 * direction). With <=1 voter there is nothing to cancel against, so every
 * reported requirement is kept. A kept requirement is forced "high" (a missing
 * intent/spec requirement is always high) and attributed to the first sorted
 * repo AMONG THOSE THAT REPORTED it. Other findings pass through untouched.
 */
export function reconcileRequirementFindings(
  perTarget: readonly { repo: string; findings: readonly Finding[] }[],
  voters: readonly string[],
): Finding[] {
  const reportedBy = new Map<string, Set<string>>();
  for (const t of perTarget) {
    for (const f of t.findings) {
      if (!isRequirementFinding(f)) continue;
      const key = requirementKey(f.requirement!);
      const reported = reportedBy.get(key) ?? new Set<string>();
      reported.add(t.repo);
      reportedBy.set(key, reported);
    }
  }
  const kept = new Set<string>();
  for (const [key, reported] of reportedBy) {
    if (voters.length <= 1 || voters.every((r) => reported.has(r))) kept.add(key);
  }
  const emitted = new Set<string>();
  const out: Finding[] = [];
  for (const t of perTarget) {
    for (const f of t.findings) {
      if (!isRequirementFinding(f)) {
        out.push(f);
        continue;
      }
      const key = requirementKey(f.requirement!);
      if (!kept.has(key) || emitted.has(key)) continue;
      emitted.add(key);
      const reporters = reportedBy.get(key);
      out.push({ ...f, severity: 'high', repo: reporters ? [...reporters].sort()[0]! : t.repo });
    }
  }
  return out;
}

/**
 * Does this target's range hold any changes? `git diff --quiet` in the target's
 * worktree on the exact range the scope block rendered. Exit 1 = changes, 0 =
 * none; no git runner, an unresolved range, or any other exit is `null` (the
 * host does not know — a non-voter, the safe direction).
 */
export async function targetHasChanges(
  git: GitRunner | undefined,
  worktreePath: string,
  range: string | null,
): Promise<boolean | null> {
  if (!git || range === null) return null;
  try {
    const r = await git(['diff', '--quiet', range], worktreePath);
    if (r.exitCode === 1) return true;
    if (r.exitCode === 0) return false;
    return null;
  } catch {
    return null;
  }
}

/** The scope block's empty-range observation: not a vote that anything was delivered. */
export function isEmptyDiffObservation(f: Finding): boolean {
  return f.file === null && !f.requirement && /^no changes to (review|test)\b/i.test(f.title);
}
