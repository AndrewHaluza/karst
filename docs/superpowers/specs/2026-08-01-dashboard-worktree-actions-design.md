# Dashboard Worktree Actions Design

## Goal

Make each dashboard worktree row useful as a compact navigation and status surface. A user can open a shell at the worktree, reveal and expand it in VS Code's Explorer, copy its branch name, see its reviewable line totals, and open the existing ticket changes view from an icon control.

## User Experience

The Worktrees panel header keeps its count and replaces the text `Changes` button with an accessible diff icon button. Its tooltip and accessible name remain `Show ticket changes`.

Each worktree row shows:

- the repository display path;
- the branch name with a copy icon button when a branch exists;
- additions and deletions as `+N −N` when Git inspection succeeds;
- an `Open Terminal` action;
- a `Reveal in Explorer` action.

The copy action gives the existing optimistic copied feedback. `Open Terminal` creates and reveals a VS Code terminal whose working directory is the worktree path. `Reveal in Explorer` first reveals the worktree URI, then expands the focused Explorer node so the folder's children are visible.

Line totals compare the worktree with its recorded base reference. They include committed changes and tracked staged or unstaged changes because `git diff <base> --numstat` compares the base tree with the working tree. Untracked files are excluded until added to Git. Binary-file numstat entries do not contribute line counts. While totals are loading, or when the worktree lacks a base or Git inspection fails, no misleading numeric value is shown.

## Architecture

`buildDashboardState` remains synchronous and store-backed. Line totals are live filesystem facts, so they are neither stored in SQLite nor added to the synchronous state builder.

A small host-agnostic Git statistics module accepts injected `GitRunner`, worktree path, and base reference. It runs a bounded asynchronous `git diff --numstat` command and reduces valid numeric rows into additions and deletions. This keeps arbitrary Git work off the extension-host event loop and makes parsing independently testable.

`DashboardManager` receives an optional asynchronous totals loader. After posting a normal dashboard state, it starts a totals refresh for that state's worktrees and later posts an ephemeral `worktree-stats` host message. Request identity and panel liveness checks prevent an older result or a disposed panel from receiving an update. A missing loader preserves current behavior in tests and alternate hosts.

The dashboard webview owns only the latest ephemeral totals map. A normal state push renders worktree identity and actions immediately; a `worktree-stats` message updates totals and rerenders the rows. Totals are keyed by the host-owned repository identity already present on each worktree, not by display text.

## Actions and Trust Boundary

The webview adds `open-worktree-terminal` and `copy-worktree-branch` messages alongside the existing folder action. Each carries a non-empty string and is narrowed by `parseWebviewMessage` before routing. The extension binds terminal creation and clipboard writing; it continues to bind Explorer commands. Malformed and unknown messages are ignored.

The existing `show-changes` message stays payload-free because its dashboard closure already owns the ticket. Replacing its visible text with an icon does not alter its host behavior.

## Error Handling

Git statistics are supplemental. One worktree's failure produces no totals for that row without preventing other rows from updating or failing the dashboard state push. The loader logs unexpected failures through the dashboard's existing error channel.

Terminal and clipboard actions use VS Code's host APIs. Explorer reveal and expansion are sequenced asynchronously; a rejected command is logged through the dashboard action containment rather than crashing the message pump.

## Testing

Implementation follows red-green TDD with focused coverage for:

- numstat parsing, aggregation, binary rows, missing bases, and failed Git commands;
- dashboard message parsing and routing for terminal and branch-copy actions;
- dashboard manager delivery of asynchronous totals and rejection of stale/disposed results;
- webview markup for the diff icon, accessible labels, copied feedback, line totals, and clarified row actions;
- extension-host bindings where they can be isolated without importing `vscode` into Vitest.

Fresh targeted tests run during each TDD cycle. Completion requires the full test suite, typecheck, build, diff checks, and the ticket's implementation-stage marker.
