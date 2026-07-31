# Ticket Stack Diffs — Design

**Ticket:** show-wt-diffs — Show WT diffs
**Date:** 2026-07-30

## Problem

The dashboard currently puts a `Diff` button on each worktree row. The action
registers that directory with VS Code's Git extension and opens the Source
Control view. This does not reliably select or expand the requested worktree,
and Source Control does not present the commits made on the ticket branch
alongside its pending changes.

A ticket may span several Git worktrees in different repositories. The useful
unit is therefore the ticket's entire stack, not one worktree and not whichever
repository the Source Control view happens to select.

## Goals

- One ticket-level changes explorer covering every physical worktree in the
  ticket's stack.
- Git-native organization: commits, staged changes, unstaged changes, and
  untracked files.
- Exact per-file comparisons opened in VS Code's native diff editor.
- Immediate usefulness on open: changed repositories, pending groups, and the
  newest commit expose files without requiring the user to find or expand the
  repository elsewhere.
- Host-agnostic Git discovery and panel logic with thin VS Code bindings.
- Asynchronous Git operations so the extension host remains responsive.

## Non-goals

- Staging, unstaging, committing, discarding, or otherwise mutating Git state.
- Rendering patches inside the Karst webview. VS Code's native diff editor owns
  syntax highlighting, navigation, accessibility, and editor settings.
- A full commit graph, branch management, blame view, or remote/PR diff viewer.
- Replacing VS Code's Source Control view for general repository work.
- Live filesystem watching. Opening or manually refreshing the explorer obtains
  a fresh snapshot.

## Chosen UX

### Dashboard entry point

Replace the per-worktree `Diff` buttons with one ticket-level `Changes` action
in the Worktrees section header. `Open folder` remains a per-worktree action.
The message crossing the dashboard webview boundary carries no filesystem path;
the host already knows the dashboard's ticket id.

Opening `Changes` creates or reveals one changes explorer for that ticket. A
later open reuses the panel and refreshes its snapshot.

### Explorer hierarchy

The explorer is repository-first:

```text
Ticket changes
├─ Karst-extension                 2 commits · 4 pending
│  ├─ COMMITS
│  │  ├─ a13f9c2 Add ticket diff snapshot
│  │  │  ├─ src/ui/diffs/snapshot.ts
│  │  │  └─ src/ui/diffs/snapshot.test.ts
│  │  └─ 8be24d1 Wire dashboard action
│  ├─ STAGED CHANGES
│  ├─ CHANGES
│  └─ UNTRACKED FILES
├─ API                             2 commits · clean
└─ Web                             3 pending
```

Each worktree heading shows its display path/name, ticket branch, base branch,
commit count, and pending-entry count. A clean worktree remains visible and is
collapsed. Worktrees with changes open by default. Their non-empty pending
groups open by default; the newest commit opens by default while older commits
start collapsed.

The panel header reports physical worktrees, commits, and pending entries
separately. It does not call their sum "files", because the same path may
legitimately appear in several commits and pending states.

A text filter matches repository labels, commit hashes/messages, and file
paths. A refresh action replaces the complete ticket snapshot.

### Native diff interaction

Selecting a file opens a native VS Code side-by-side diff beside the explorer,
leaving the explorer available for navigation. Titles name the repository and
comparison so two same-named files from different worktrees remain
distinguishable.

Each state has one precise comparison:

| Explorer group | Left side | Right side |
|---|---|---|
| File under a commit | first parent of that commit | that commit |
| Staged Changes | `HEAD` | index |
| Changes | index | working tree |
| Untracked Files | empty document | working-tree file |

Added and deleted files use an empty document for the missing side. Rename
entries retain both the old and new path and show the rename in the file row.
A path may appear in both Staged Changes and Changes when it has staged edits
and further unstaged edits; the two rows intentionally open different
comparisons.

## Git semantics

### Repository discovery

The source of truth is `listWorktreesByTicket`. One database worktree row
represents one physical Git worktree; the explorer does not infer repositories
from the workspace or Source Control registration. This preserves project
scoping and naturally covers every repository selected for the ticket.

### Committed range

For each worktree:

1. Validate `HEAD` and the worktree row's recorded `baseRef`.
2. Resolve `merge-base(HEAD, baseRef)`.
3. Read the first-parent commit history from that merge base (exclusive) to
   `HEAD` (inclusive), newest first.
4. For each commit, read name/status entries relative to its first parent.

First-parent history keeps commits brought in only through a base-branch merge
out of the ticket's own list while retaining the ticket commits and the merge
commit itself. A merge commit is compared with its first parent. An empty
commit remains visible with zero files. Karst worktrees branch from an existing
recorded base, so this merge-base-bounded range cannot contain a root commit;
the explorer does not invent an orphan-history fallback.

No fallback silently guesses another base. A missing or invalid recorded base
is a repository-level error because labeling an invented range as the ticket's
committed work would be misleading.

### Pending states

Pending state is split using Git plumbing rather than aggregated as
`HEAD`-to-working-tree:

- staged name/status: `HEAD` to index;
- unstaged name/status: index to working tree;
- untracked paths: Git's untracked-file output.

Git output is requested in NUL-delimited form and parsed without shell
interpolation. Filenames containing whitespace or other unusual characters
remain single paths. Change descriptors retain added, modified, deleted, and
renamed status.

### Lazy content

Snapshot loading reads metadata only: repository identity, commit headers, and
file change records. File contents are resolved only when the user opens a
diff. Immutable Git sides are exposed through a read-only Karst document
provider; working-tree sides use the actual file when present.

Binary, otherwise unreadable, or larger-than-5-MiB Git-backed content remains
listed. Opening it shows a clear `Text diff unavailable` message instead of
omitting the change, returning truncated text, or rendering corrupt bytes.

## Module boundaries

All modules except the activation adapter remain free of runtime `vscode`
imports.

- `src/ui/diffs/git.ts` — injected asynchronous Git command surface and
  NUL-delimited metadata parsing.
- `src/ui/diffs/snapshot.ts` — build one ticket-wide `TicketChangesSnapshot`,
  isolate per-worktree failures, assign opaque change ids, and resolve those ids
  to trusted change descriptors.
- `src/ui/diffs/messages.ts` — validate untrusted webview messages. Supported
  actions are refresh and open one opaque change id. Filtering is entirely
  webview-local and never crosses the message boundary.
- `src/ui/diffs/panel.ts` — one-panel-per-ticket lifecycle, loading/error/state
  messages, latest-result-wins refreshes, and delegation of trusted open-diff
  requests to an injected host action.
- `src/ui/diffs/webview.html` — standalone explorer rendering and interaction,
  using the existing webview CSP and escaping conventions.
- `src/extension.ts` — thin VS Code adapter: panel creation, ticket worktree
  lookup, async Git execution, virtual document registration, and
  `vscode.diff` invocation.
- `src/ui/dashboard/messages.ts` and `webview.html` — replace the path-bearing
  per-row diff action with the payload-free ticket action.
- `scripts/copy-assets.mjs` — include the new source webview in the packaged
  `dist/` assets.

## Data contracts and trust boundary

The serializable snapshot contains:

- ticket id and summary counts;
- worktree display identity, branch, base branch, and host-owned opaque identity;
- commit hash, short hash, subject, author, timestamp, and changed-file rows;
- staged, unstaged, and untracked changed-file rows;
- repository-scoped loading errors;
- an opaque `changeId` on every actionable file.

Raw filesystem paths and Git object expressions are not accepted back from the
webview. The panel keeps the current `changeId` → descriptor map host-side.
`open-diff` validates a non-empty string id and resolves it only from that map.
A stale or forged id produces no Git or filesystem access and triggers a
refresh-safe warning.

Every Git invocation passes an argv array directly to the process runner.
Commit subjects and filenames are data, never commands. Webview rendering
escapes all repository, commit, error, and file text.

## Refresh, errors, and lifecycle

- Opening an existing ticket explorer reveals it and starts a fresh refresh.
- The refresh button shows loading state while retaining the last successful
  snapshot to avoid a blank flash.
- Refreshes carry increasing request ids; only the newest completion may replace
  panel state or its change-id map.
- Worktrees load independently. One Git failure renders an inline error for that
  worktree and does not hide successful repositories.
- A ticket with no worktrees renders the existing actionable empty state rather
  than opening Source Control.
- A file removed or changed after snapshot creation may make its diff stale.
  The host reports that condition and refreshes the explorer; it never opens a
  different path as a fallback.
- Metadata uses the existing 1-MiB bounded Git output. A truncation marker turns
  that worktree into a scoped error; a partial commit or file list is never
  presented as complete. Lazy Git-backed file content uses a separate 5-MiB
  bound and refuses the text diff on truncation.
- Disposing the panel drops its snapshot map and refresh state. No watcher or
  long-lived child process survives the panel.

## Testing strategy

Implementation follows strict red-green TDD.

### Real-Git behavior

Temporary Git repositories exercise the actual command surface and independently
derived expected results:

- several ticket worktrees are combined into one snapshot;
- first-parent commits since each repository's base are ordered newest first;
- a file under a commit opens parent-to-commit content;
- added, modified, deleted, and renamed committed files preserve both sides;
- staged-only, unstaged-only, staged-plus-unstaged, and untracked files land in
  the correct groups and open the exact documented comparisons;
- paths containing spaces remain intact;
- clean repositories remain present;
- one invalid repository/base produces a scoped error while other repositories
  succeed;
- binary content remains listed and refuses a text diff clearly.

### Pure panel and boundary behavior

Focused unit tests cover:

- one explorer per ticket and reuse-on-open;
- refresh-on-reopen and explicit refresh;
- latest-result-wins under overlapping refreshes;
- retention of the last snapshot during loading;
- initial expansion metadata and summary counts;
- opaque change-id resolution and stale/forged-id rejection;
- malformed webview messages and absence of path-bearing diff messages;
- dashboard routing of the payload-free ticket-level `Changes` action;
- disposal cleanup and no posts after disposal.

### Packaging and regression verification

The existing asset/CSP tests are extended for the sixth webview asset. Final
verification runs targeted diff tests, `npm test`, `npm run typecheck`, and
`npm run build`.

## Alternatives considered

1. **Keep using Source Control and try to reveal its repository tree.** Rejected:
   the Git extension does not provide a stable public command that selects and
   expands a particular repository and its committed history, and a ticket stack
   would still be fragmented across another extension's state.
2. **Render full patches inside the Karst webview.** Rejected: it duplicates
   VS Code's diff editor, syntax handling, navigation, accessibility, and large
   file behavior. The custom surface should own stack navigation; the native
   editor should own text comparison.
3. **Put files directly inside the ticket dashboard.** Rejected: multi-repository
   commits and pending states would crowd the lifecycle, servers, and PR controls.
   A focused reusable explorer keeps the dashboard concise.
4. **Group by Git state before repository.** Rejected: it repeats repository
   labels, obscures repository-specific base branches, and scales poorly when
   several repositories contain the same relative paths.

## Acceptance criteria

1. One dashboard action opens every worktree belonging to the ticket.
2. Each worktree visibly separates commits, staged changes, unstaged changes,
   and untracked files using regular Git terminology.
3. Commits since the worktree's base are expandable and expose their changed
   files.
4. Selecting any supported text file opens the exact native VS Code comparison
   for its state.
5. Multiple repositories, clean repositories, duplicate relative paths, and
   per-repository Git failures remain distinguishable.
6. The explorer never trusts a path or Git object supplied by the webview.
7. All Git work is asynchronous, tested with real repositories, packaged with
   the extension, and covered by the full verification suite.
