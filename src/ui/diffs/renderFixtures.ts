import type { ChangedFileView, CommitView, TicketChangesState, WorktreeChangesView } from './snapshot.js';

/**
 * The checked-in render fixture corpus for the diffs (ticket changes) webview.
 *
 * Every fixture is built ONLY from the production presentation shape
 * (`TicketChangesState`) and is pure data: no SQLite reads, no real
 * worktrees, no git calls. Ticket ids use the reserved numeric band
 * 900001–999999 (Key Decision 5). Every path/hash is `fixture:`-prefixed so
 * no fixture control can resolve a real host target.
 */

export type DiffsScenario = 'empty' | 'populated' | 'error' | 'hostile';

export const DIFFS_SCENARIOS: readonly DiffsScenario[] = [
  'empty',
  'populated',
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
function fixtureFile(
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

function fixtureCommit(index: number, overrides?: Partial<CommitView>): CommitView {
  return {
    hash: `fixture:hash:${index}`.padEnd(40, '0'),
    shortHash: `fixture${index}`,
    subject: `Fixture commit ${index}`,
    author: 'Fixture Author',
    authoredAt: `2026-01-0${index + 1}T12:00:00Z`,
    files: [fixtureFile(`src/fixture-${index}.ts`)],
    ...overrides,
  };
}

function fixtureWorktree(
  overrides?: Partial<WorktreeChangesView>,
): WorktreeChangesView {
  return {
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

function stateFor(worktrees: readonly WorktreeChangesView[]): TicketChangesState {
  const { commitCount, pendingCount } = countsFor(worktrees);
  return {
    ticketId: 900001,
    worktreeCount: worktrees.length,
    commitCount,
    pendingCount,
    worktrees: [...worktrees],
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
    unstaged: [fixtureFile('src/ui/dashboard/panel.ts')],
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
  error: errorState,
  hostile: hostileState,
};

export function diffsRenderFixtures(): DiffsRenderFixture[] {
  return DIFFS_SCENARIOS.map((scenario) => ({
    scenario,
    state: BUILDERS[scenario](),
  }));
}
