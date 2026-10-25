/**
 * The closed control copy of the Inside block (UI-R20): labels, titles and the status word. The host ships
 * ids and keys, never these strings. Pure data, kept apart from the components.
 */
import type { InsideActionKind, ProcessEvidenceView } from '../../../model/inside/types.js';

/** kind to label, from the closed InsideActionKind vocabulary. */
export const INSIDE_ACTION_LABEL: Readonly<Partial<Record<InsideActionKind, string>>> = {
  'open-pr': 'Open PR',
  'open-commit': 'Open commit',
  'open-file': 'Open file',
  'open-stage-log': 'Open log',
  'resume-stage': 'Resume',
  'retry-ship-repo': 'Retry',
  'open-full-evidence': 'Show all',
  'open-bounded-evidence': 'Show all',
  'open-session': 'Open session',
  'graph-open-session': 'Open session',
  'graph-confirm': 'Start graph',
  'graph-stop': 'Stop',
  'graph-resume': 'Resume',
  'graph-restart': 'Restart graph',
  'graph-replan': 'Replan',
  'graph-mark-impl': 'Mark implementation complete',
  'graph-discard-node': 'Discard process',
  'graph-edit-override': 'Edit override',
};

export const INSIDE_ACTION_TITLE: Readonly<Partial<Record<InsideActionKind, string>>> = {
  'open-pr': 'Open this pull request on the host',
  'open-commit': 'Open this commit on the host',
  'open-file': 'Open this file in an editor',
  'open-stage-log': "Open this stage's log file",
  'resume-stage': "Resume this ticket's stage",
  'retry-ship-repo': 'Re-run ship for this repository only',
  'open-full-evidence': 'Show every recorded row',
  'open-bounded-evidence': 'Show every repository row',
  'open-session': "Focus this session's terminal — never spawns one",
  'graph-open-session': "Focus this session's terminal — never spawns one",
  'graph-confirm': 'Confirm the accepted plan and start graph execution',
  'graph-stop': 'Signal the graph coordinator to drain',
  'graph-resume': 'Retry this blocked graph using its recorded recovery path',
  'graph-restart': 'Restart this stopped graph run on its current plan',
  'graph-replan': 'Elect a new graph revision from the recorded failure evidence',
  'graph-mark-impl': 'Fire the implementation marker and advance this ticket to uat',
  // DANGER (UI-R10b): the process may still be running. The title names the risk and the row's visible status
  // (`launch-unknown`/`termination-unknown`) states it again, so the explanation is never title-only (UI-R19).
  'graph-discard-node': 'Discard unknown process — it may still be running',
  // The per-node override edit is an ORDINARY secondary control (reversible editing, nothing lost on click).
  'graph-edit-override': "Edit this node's profile/provider/model/effort/prompt overrides before it claims",
};

/** The DANGER variants (UI-R10b: irreversible loss). */
export const INSIDE_ACTION_DANGER: ReadonlySet<string> = new Set(['graph-discard-node']);

/** The visible status WORD, so status never rides colour alone (UI-R06). The host ships the key; the word is closed control copy. */
const INSIDE_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: 'pending',
  run: 'running',
  wait: 'waiting',
  pass: 'passed',
  fail: 'failed',
  note: 'note',
  skip: 'skipped',
};

export const statusWord = (status: string | undefined): string => INSIDE_STATUS_LABEL[status ?? ''] ?? status ?? '';

/**
 * Keys for a list that has no ids (evidence rows): the row's own text, made unique by how often it has already
 * appeared. Rows only ever append, so a key stays with its row.
 */
export function withKeys<T>(items: readonly T[], base: (item: T) => string): ReadonlyArray<readonly [string, T]> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const b = base(item);
    const n = seen.get(b) ?? 0;
    seen.set(b, n + 1);
    return [`${n}:${b}`, item] as const;
  });
}

/**
 * Does this evidence render anything? The generic `rows` array is only one of its shapes: a `prs` / `commits` /
 * `receipt` evidence renders from `branches` / `repos` / `blocks` / `hero`, and testing `rows` alone made such a row
 * static (content behind a disclosure with no way to open it).
 */
export function hasEvidenceBody(ev: ProcessEvidenceView | undefined): boolean {
  if (!ev) return false;
  const rich = ev as { rows?: readonly unknown[]; nodes?: readonly unknown[]; branches?: readonly unknown[]; repos?: readonly unknown[]; blocks?: readonly unknown[]; hero?: unknown };
  return !!(rich.rows?.length || rich.nodes?.length || rich.branches?.length || rich.repos?.length || rich.blocks?.length || rich.hero);
}
