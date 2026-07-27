# Restored Session Adoption Design

**Ticket:** 869ea10xb

## Goal

After a VS Code or Cursor window reload, re-associate each restored Karst
terminal with its existing in-memory session slot instead of replacing its
agent process. Active sessions must appear once, inactive sessions must retain
their state, and repeated reloads must not create additional agent records or
terminals.

## Failure

The editor preserves visible integrated terminals and their processes across a
window reload, while Karst's `SessionManager` is recreated empty. The current
activation reconciliation disposes every tagged restored terminal and launches
a replacement with the persisted agent session ID.

That replacement can create an additional provider-side session record even
when it uses a resume argument. It also destroys a terminal that is already
running and applies the same unnecessary replacement to inactive terminals.

## Decision

Karst will adopt a restored visible terminal in place. Adoption installs the
existing terminal handle into `SessionManager`'s one-terminal-per-ticket map and
attaches the normal close lifecycle without rebuilding an adapter command or
starting a process.

For multiple restored handles tagged with the same ticket, Karst adopts one
canonical handle and disposes the extras. A later normal `openSession` call
therefore focuses the adopted handle and cannot launch a duplicate.

Visible terminals are adopted regardless of the ticket's active or inactive
agent state when the ticket belongs to the current project. The stored ticket
state remains unchanged during adoption. Terminals for unknown or foreign
tickets remain untouched.

Hidden terminals are not restored by the editor. Their existing persisted
ownership recovery remains a relaunch path because no process handle exists to
adopt.

## Shared Provider Behavior

Adoption lives in the host-agnostic `SessionManager`, above all agent adapters.
It does not inspect or branch on Codex, Claude, or Antigravity. Every provider
whose terminal is tagged with `KARST_TICKET_ID` receives the same behavior.

Normal creation and explicit resumption still flow through the selected
`AgentAdapter`; adoption bypasses command construction only because the command
and agent process already exist.

## Lifecycle and State

An adopted terminal is a live session handle for `isOpen`, `focusSession`, and
`nudge`. Its close event removes it only if it remains the current handle, then
invokes the existing session-close callbacks. Adoption does not own newly
materialized paths and therefore must not run launch cleanup for the restored
handle.

Reconciliation returns which ticket IDs were adopted, idled because no safe
adoption was possible, or ignored. Activation excludes adopted tickets from
background relaunch planning. Persisted ownership for an adopted session is
retained so a later reload can repeat the same association.

## Idempotence

Each new extension host starts with an empty manager and adopts at most one
visible handle per ticket. Repeated reloads rediscover and adopt that same
terminal process without launching an agent command. Within one activation,
the existing one-terminal-per-ticket guard prevents all subsequent duplicate
opens.

If duplicate handles already exist, reconciliation deterministically retains
one and disposes the remaining handles without creating another one.

## Tests

Regression tests will prove:

- an active restored terminal is adopted without invoking an adapter;
- an inactive restored terminal is adopted without changing its stored state;
- duplicate restored handles result in one managed handle;
- repeated manager/reload simulations retain one terminal and create no agent
  records;
- adopted terminals remain focusable and accept nudges;
- closing an adopted terminal runs the ordinary close lifecycle once;
- foreign terminals remain untouched;
- hidden active sessions retain their existing background recovery behavior;
- normal fresh creation and explicit resumption remain unchanged; and
- the restoration logic is provider-neutral.

Focused tests will be followed by the full test suite, typecheck, and production
build.

## Out of Scope

- Repairing provider-owned session databases that already contain duplicates.
- Changing agent CLI resume semantics.
- Persisting hidden terminal process handles that the editor does not expose.
- Adopting untagged legacy terminals whose ticket ownership cannot be proven.
