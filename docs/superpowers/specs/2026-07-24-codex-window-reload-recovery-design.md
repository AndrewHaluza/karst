# Codex Window Reload Recovery Design

**Ticket:** 869e95peq

## Goal

Recover an active Karst-managed Codex session after VS Code or Cursor reloads
the window. The recovered session must retain its Codex conversation, render in
a clean terminal, accept input, and tolerate repeated reloads without creating
duplicate or unusable terminals.

## Failure

The editor restores the integrated terminal and its process across a window
reload, but Karst's `SessionManager` is extension-host memory and starts empty.
The restored Codex alternate-screen interface can remain visible while its
reconnected terminal is no longer interactive. Karst neither recognizes nor
owns that terminal after activation, so its runtime state can disagree with the
interface and a later session action can create a competing resume terminal.

## Decision

Karst will replace a restored Karst terminal with a fresh terminal that resumes
the persisted agent session. It will not attempt to reuse the restored terminal
UI because the reported failure is in that reconnected UI/PTY state.

New Karst terminals carry a private ticket identifier in their creation
environment. During extension activation, Karst inspects restored terminals,
associates tagged terminals with tickets, disposes the stale terminal, and
opens one replacement through the normal session launch path. The normal
`shouldResumeSession` rule supplies the stored Codex session ID, preserving the
conversation and operational thread.

For terminals created by an older Karst version without the tag, recovery may
use a conservative compatibility match only when the terminal's working
directory and agent command uniquely identify one active ticket. Ambiguous
terminals are never disposed.

## Boundaries

The host-agnostic session layer receives terminal discovery and identity through
the existing `TerminalHost` seam. VS Code-specific `Terminal.creationOptions`
inspection stays in `extension.ts`.

Reconciliation is separated from command construction:

- terminal discovery reports restored Karst ticket identities;
- reconciliation deduplicates identities and disposes stale terminal handles;
- activation requests one normal open/resume per recoverable ticket;
- `SessionManager` tracks the replacement before user actions are accepted.

The terminal identity must not contain ticket content, credentials, prompts, or
session IDs. Only Karst's numeric ticket ID is required.

## Idempotence

Each activation handles at most one restored terminal per ticket and launches
at most one replacement. Duplicate restored handles for the same ticket are
disposed together but produce one recovery request. The replacement terminal
is tagged, so the same process repeats safely on subsequent window reloads.

Activation reconciliation completes before normal open-session actions can
create a terminal. Within one extension-host lifetime, `SessionManager` retains
its existing one-terminal-per-ticket guard.

## Recovery Failures

Karst replaces a terminal only when it can resolve an owned ticket safely.

If a ticket has no resumable session ID, no longer belongs to this project, has
no worktree, or the adapter cannot build the resume command, Karst must:

1. avoid claiming that the stale terminal is a healthy live session;
2. log the concrete recovery failure;
3. leave the ticket in a clear idle state whose existing Start/Continue action
   can retry recovery;
4. avoid repeated automatic launch loops during the same activation.

An ambiguous untagged terminal is left untouched and reported rather than
disposed.

## Tests

Host-agnostic regression tests will prove:

- a tagged restored terminal yields one recovery request;
- duplicate restored terminals for one ticket yield one recovery request;
- repeated manager/activation simulations replace the prior terminal without
  accumulating duplicates;
- unrelated and ambiguous terminals are untouched;
- missing session data produces a recoverable idle result;
- a recovered open session remains focusable and accepts a nudge through the
  replacement terminal.

Adapter/session tests will also assert that the terminal identity reaches the
host without leaking the Codex session ID. Typecheck, the focused Vitest suite,
the complete test suite, and the production build are the completion gates.

## Out of Scope

- Repairing VS Code's terminal reconnection or Codex's alternate-screen renderer.
- Persisting terminal scrollback outside the editor.
- Changing Codex's own thread storage format.
- Automatically disposing terminals that cannot be identified as Karst-owned.
