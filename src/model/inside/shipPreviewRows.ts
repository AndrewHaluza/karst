/**
 * The ship preview as "will" rows inside the ledger (`arch:SHIP-PREVIEW`, variant 4A): while the header's ship slot
 * waits for Confirm/Retry, the preview facts the old block stated are prepended to the Commit, Push and Pull request
 * processes, so each step is read once, in the row it predicts (UI-R31: this module is host-side and the webview only
 * places the strings).
 *
 * The wording is the old `ShipPreview` block's, verbatim. The read, its cache and its advisory rule do not change:
 * this module transforms the preview the host already holds, and never reads git.
 */
import type { ShipPreview, ShipPreviewRepo } from '../../workflow/shipPreview.js';
import type { EvidenceRow, InsideProcessView } from './types.js';

/** Cap on the visible file list before the remainder line takes over (the old block's `FILE_CAP`, UI-R44). */
export const PREVIEW_FILE_CAP = 50;

/** The repository as displayed: the manifest's name for a recorded value, else the preview's own name. */
const nameOf = (repo: string, repoNameFor: (repo: string) => string | undefined): string =>
  repoNameFor(repo) ?? repo;

/** One list in the row's expandable output, capped, its remainder named (UI-R32/R44). */
function listOutput(items: readonly string[], more = 0, cap = PREVIEW_FILE_CAP): string {
  const shown = items.slice(0, cap);
  const rest = more + Math.max(0, items.length - shown.length);
  return [...shown, ...(rest > 0 ? [`and ${rest} more`] : [])].join('\n');
}

/** The live PR number as the old block printed it; `?` when the read never resolved one. */
const prNumber = (r: ShipPreviewRepo): string => String(r.prNumber == null ? '?' : r.prNumber);

/** Every target is genuinely unchanged — the shape ship refuses (`arch:SHIP-UNCHANGED`). */
const genuinelyUnchanged = (r: ShipPreviewRepo): boolean =>
  r.status === 'nothing-to-commit' && !r.error && !r.changedFromBase;

/** The refusal sentence a blocked repository states, exactly as the old block worded it. */
function blockedRefusal(r: ShipPreviewRepo): string {
  const denied = (r.deny || []).join(', ');
  return `ship refuses ${denied || 'untracked secret-shaped files'} — commit them deliberately or ignore them`;
}

/** The Commit process's will rows for one repository, in the old block's reading order. */
function commitRows(r: ShipPreviewRepo, label: string): EvidenceRow[] {
  // A failed read states its own row and no verdict: the repo's state was never determined.
  if (r.error) return [{ status: 'fail', label, detail: r.error }];
  // Ship refuses before the sweep, so its dirty paths are never claimed as work it will do.
  if (r.status === 'blocked') return [{ status: 'fail', label, detail: blockedRefusal(r) }];
  // A skipped repository commits nothing; the Push row is where its state is stated.
  if (r.status === 'already-shipped' || r.status === 'already-merged') return [];

  const rows: EvidenceRow[] = [];
  if (r.status === 'will-commit') {
    rows.push({ status: 'pending', label, detail: `will commit — ${r.commitMessage}` });
  } else {
    rows.push({
      status: 'pending',
      label,
      detail: r.changedFromBase ? 'nothing to commit — agent committed' : 'nothing to commit — no changes from base',
    });
  }
  if (r.commitFiles && r.commitFiles.length) {
    rows.push({ status: 'pending', label, detail: `Files (${r.commitFiles.length})`, output: listOutput(r.commitFiles) });
  }
  if (r.excludedFiles && r.excludedFiles.length) {
    rows.push({
      status: 'pending',
      label,
      detail: `Excluded (${r.excludedFiles.length}) (ship.exclude)`,
      output: listOutput(r.excludedFiles),
    });
  }
  if (r.committedExcludedWarning && r.committedExcludedWarning.length) {
    rows.push({
      status: 'wait',
      label,
      detail: `ship.exclude matches committed changes: ${r.committedExcludedWarning.join(', ')} — these DO ship`,
    });
  }
  if (r.branchCommits && r.branchCommits.length > 0) {
    rows.push({
      status: 'pending',
      label,
      detail: `Commits (${r.branchCommits.length + r.branchCommitsMore})`,
      output: listOutput(
        r.branchCommits.map((c) => `${c.sha} ${c.subject}`),
        r.branchCommitsMore,
      ),
    });
  }
  return rows;
}

/** The Push process's will row for one repository. */
function pushRows(r: ShipPreviewRepo, label: string): EvidenceRow[] {
  if (r.error || r.status === 'blocked') return [];
  if (r.status === 'already-shipped') return [{ status: 'note', label, detail: `skipped — PR #${prNumber(r)} open` }];
  if (r.status === 'already-merged') return [{ status: 'note', label, detail: `nothing to ship — merged in #${prNumber(r)}` }];
  // A re-ship commits and pushes INTO the live PR (FIX-46), so it is never reported as skipped.
  if (r.prNumber != null) return [{ status: 'pending', label, detail: `will push onto PR #${r.prNumber}` }];
  return [{ status: 'pending', label, detail: 'will push the branch' }];
}

/** The Pull request process's will row for one repository. */
function prRows(r: ShipPreviewRepo, label: string): EvidenceRow[] {
  if (r.error || r.status === 'blocked' || r.status === 'already-shipped' || r.status === 'already-merged') return [];
  if (r.prNumber != null) return [{ status: 'pending', label, detail: `PR #${r.prNumber} open — this commit is pushed onto it` }];
  return [{ status: 'pending', label, detail: `will open — ${r.prTitle}` }];
}

/**
 * Prepend one process's will rows to its evidence. A process that also carries a
 * recorded commit grid / PR paths keeps it: the will rows lead (`leadRows` says how
 * many), the recorded body follows. The input process is never mutated.
 */
function withRows(p: InsideProcessView, rows: readonly EvidenceRow[]): InsideProcessView {
  if (rows.length === 0) return { ...p };
  if (!p.evidence) return { ...p, openByDefault: true, evidence: { kind: 'rows', rows } };
  const ev = p.evidence;
  if (ev.kind === 'commits' || ev.kind === 'prs') {
    return {
      ...p,
      openByDefault: true,
      evidence: { ...ev, rows: [...rows, ...ev.rows], leadRows: rows.length },
    };
  }
  return { ...p, openByDefault: true, evidence: { ...ev, rows: [...rows, ...ev.rows] } };
}

/**
 * The ship processes with the preview's "will" rows prepended to Commit, Push and
 * Pull request, in the preview's repository order. The processes are found by their
 * ids in `shipProcesses()` (`commit`, `push`, `pr`); every other process passes
 * through unchanged. Returns NEW process objects.
 */
export function withShipPreviewRows(
  processes: InsideProcessView[],
  preview: ShipPreview,
  repoNameFor: (repo: string) => string | undefined,
): InsideProcessView[] {
  const repos = preview.repos;
  const commit: EvidenceRow[] = [];
  const push: EvidenceRow[] = [];
  const pr: EvidenceRow[] = [];

  // @arch:SHIP-UNCHANGED: ship fails when EVERY target is unchanged. A repo skipped
  // for a live PR, blocked, or unread is not counted, so the line only shows when
  // every repository is a genuine no-change.
  if (repos.length > 0 && repos.every(genuinelyUnchanged)) {
    commit.push({ status: 'fail', label: 'ship', detail: 'ship will fail — no repo has changes' });
  }

  for (const r of repos) {
    const label = nameOf(r.repo, repoNameFor);
    commit.push(...commitRows(r, label));
    push.push(...pushRows(r, label));
    pr.push(...prRows(r, label));
  }

  return processes.map((p) => {
    if (p.id === 'commit') return withRows(p, commit);
    if (p.id === 'push') return withRows(p, push);
    if (p.id === 'pr') return withRows(p, pr);
    return { ...p };
  });
}
