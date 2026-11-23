import {
  authoredLabel,
  diffsSummaryText,
  worktreeCountText,
  type ChangedFileView,
  type CommitView,
  type TicketChangesState,
  type WorktreeChangesView,
} from './snapshot.js';

/**
 * The checked-in render fixture corpus for the diffs (ticket changes) webview.
 *
 * Every fixture is built ONLY from the production presentation shape
 * (`TicketChangesState`) and is pure data: no SQLite reads, no real
 * worktrees, no git calls. Ticket ids use the reserved numeric band
 * 900001–999999 (Key Decision 5). Every path/hash is `fixture:`-prefixed so
 * no fixture control can resolve a real host target.
 */

export type DiffsScenario =
  | 'empty'
  | 'populated'
  | 'one-commit'
  | 'clean'
  | 'many'
  | 'error'
  | 'hostile';

export const DIFFS_SCENARIOS: readonly DiffsScenario[] = [
  'empty',
  'populated',
  'one-commit',
  'clean',
  'many',
  'error',
  'hostile',
];

export interface DiffsRenderFixture {
  scenario: DiffsScenario;
  state: TicketChangesState;
}

/**
 * `changeId` only needs to be unique within one fixture's tree, so it is
 * derived from the file's own path rather than a call-order counter —
 * keeps `diffsRenderFixtures()` deterministic across repeated calls (no
 * shared mutable state), matching every other render-fixture module.
 */
export function fixtureFile(
  path: string,
  overrides?: Partial<ChangedFileView>,
): ChangedFileView {
  return {
    changeId: `fixture:change:${path}`,
    status: 'modified',
    path,
    oldPath: null,
    absolutePath: `/fixture/repo/${path}`,
    ...overrides,
  };
}

export function fixtureCommit(index: number, overrides?: Partial<CommitView>): CommitView {
  const authoredAt = overrides?.authoredAt ?? `2026-01-0${index + 1}T12:00:00Z`;
  return {
    hash: `fixture:hash:${index}`.padEnd(40, '0'),
    shortHash: `fixture${index}`,
    subject: `Fixture commit ${index}`,
    author: 'Fixture Author',
    authoredAt,
    authoredLabel: authoredLabel(authoredAt),
    files: [fixtureFile(`src/fixture-${index}.ts`)],
    ...overrides,
  };
}

export function fixtureWorktree(
  overrides?: Partial<WorktreeChangesView>,
): WorktreeChangesView {
  const base = {
    label: 'fixture-repo',
    branch: 'fixture/branch',
    baseRef: 'main',
    commits: [],
    staged: [],
    unstaged: [],
    untracked: [],
    error: null,
    ...overrides,
  };
  const pending = base.staged.length + base.unstaged.length + base.untracked.length;
  return { ...base, countText: worktreeCountText(base.commits.length, pending) };
}

function countsFor(worktrees: readonly WorktreeChangesView[]): {
  commitCount: number;
  pendingCount: number;
} {
  return worktrees.reduce(
    (acc, worktree) => ({
      commitCount: acc.commitCount + worktree.commits.length,
      pendingCount:
        acc.pendingCount + worktree.staged.length + worktree.unstaged.length + worktree.untracked.length,
    }),
    { commitCount: 0, pendingCount: 0 },
  );
}

export function stateFor(worktrees: readonly WorktreeChangesView[]): TicketChangesState {
  const { commitCount, pendingCount } = countsFor(worktrees);
  return {
    ticketId: 900001,
    ticketLabel: 'T900001 · Fixture ticket',
    worktreeCount: worktrees.length,
    commitCount,
    pendingCount,
    worktrees: [...worktrees],
    summaryText: diffsSummaryText(worktrees.length, commitCount, pendingCount),
  };
}

function emptyState(): TicketChangesState {
  return stateFor([]);
}

/**
 * Two repositories, each with commits and pending changes across staged,
 * unstaged and untracked, so the tree view, the file list and the header
 * counts all render.
 */
function populatedState(): TicketChangesState {
  const repoA = fixtureWorktree({
    label: 'fixture-web',
    branch: 'feat/142-dashboard',
    baseRef: 'main',
    commits: [
      fixtureCommit(0, {
        files: [fixtureFile('src/ui/dashboard/webview.html'), fixtureFile('src/ui/dashboard/state.ts')],
      }),
      fixtureCommit(1, { files: [fixtureFile('src/ui/dashboard/render.ts')] }),
    ],
    staged: [fixtureFile('src/ui/dashboard/messages.ts', { status: 'added' })],
    unstaged: [
      fixtureFile('src/ui/dashboard/panel.ts'),
      // DF-23: a deleted file, so the row's mark and its missing "Open file" render.
      fixtureFile('src/ui/dashboard/legacy.ts', { status: 'deleted' }),
    ],
    untracked: [fixtureFile('src/ui/dashboard/scratch.ts', { status: 'added' })],
  });
  const repoB = fixtureWorktree({
    label: 'fixture-cli',
    branch: 'feat/142-cli',
    baseRef: 'develop',
    commits: [fixtureCommit(2, { files: [fixtureFile('src/cli/run.ts')] })],
    staged: [],
    unstaged: [
      fixtureFile('src/cli/parse.ts'),
      fixtureFile('src/cli/old-name.ts', { status: 'renamed', oldPath: 'src/cli/name.ts' }),
    ],
    untracked: [],
  });
  return stateFor([repoA, repoB]);
}

/** One commit and no pending changes: the singular count texts ("1 worktree", "1 commit", "clean"). */
function oneCommitState(): TicketChangesState {
  const repo = fixtureWorktree({
    label: 'fixture-web',
    branch: 'fixture/one-commit',
    baseRef: 'main',
    commits: [fixtureCommit(0, { files: [fixtureFile('src/app.ts')] })],
  });
  return stateFor([repo]);
}

/** Worktrees with commits and nothing pending — the "No changes yet." state (DF-23). */
function cleanState(): TicketChangesState {
  const repoA = fixtureWorktree({
    label: 'fixture-web',
    branch: 'feat/142-dashboard',
    baseRef: 'main',
    commits: [fixtureCommit(0), fixtureCommit(1)],
  });
  const repoB = fixtureWorktree({
    label: 'fixture-cli',
    branch: 'feat/142-cli',
    baseRef: 'develop',
    commits: [fixtureCommit(2)],
  });
  return stateFor([repoA, repoB]);
}

/** How many files the `many` scenario carries (DF-11 renders the first 200 of a group). */
export const MANY_FILES_COUNT = 1500;

/** 1,500 pending files in one worktree — the many-files state (DF-11, DF-23). */
function manyState(): TicketChangesState {
  const files = Array.from({ length: MANY_FILES_COUNT }, (_unused, index) =>
    fixtureFile(`src/generated/file-${String(index + 1).padStart(4, '0')}.ts`, { status: 'added' }),
  );
  const repo = fixtureWorktree({
    label: 'fixture-web',
    branch: 'feat/142-many',
    baseRef: 'main',
    untracked: files,
  });
  return stateFor([repo]);
}

/** One worktree that failed to inspect — the error branch of `worktreeRow`. */
function errorState(): TicketChangesState {
  const repo = fixtureWorktree({
    label: 'fixture-broken',
    branch: null,
    baseRef: null,
    error: 'fixture: git rev-parse failed — not a worktree',
  });
  return stateFor([repo]);
}

const HOSTILE_LABEL = '<script>alert(1)</script>';
const HOSTILE_LONG = 'Z'.repeat(300);

function hostileState(): TicketChangesState {
  const repo = fixtureWorktree({
    label: HOSTILE_LABEL,
    branch: HOSTILE_LONG,
    commits: [
      fixtureCommit(0, {
        subject: HOSTILE_LABEL,
        author: HOSTILE_LABEL,
        files: [fixtureFile(HOSTILE_LONG)],
      }),
    ],
    staged: [fixtureFile(HOSTILE_LABEL, { status: 'added' })],
  });
  return stateFor([repo]);
}

const BUILDERS: Readonly<Record<DiffsScenario, () => TicketChangesState>> = {
  empty: emptyState,
  populated: populatedState,
  'one-commit': oneCommitState,
  clean: cleanState,
  many: manyState,
  error: errorState,
  hostile: hostileState,
};

export function diffsRenderFixtures(): DiffsRenderFixture[] {
  return DIFFS_SCENARIOS.map((scenario) => ({
    scenario,
    state: BUILDERS[scenario](),
  }));
}
