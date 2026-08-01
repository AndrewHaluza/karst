# Unscoped Ticket-List Navigation Design

Ticket: `869eckf2r` — `[FIX] ux improvment for unscoped tickets`

## Problem

Selecting an active ticket row in the sidebar ticket list always opens the ticket
dashboard. A ticket whose scope stage has not completed instead needs the editing
experience, where its repository selection and other onboarding choices can be
finished.

## Decision

Add a semantic `open-ticket` action for the sidebar row-selection interaction.
The host loads the selected ticket and chooses its destination from the workflow's
persisted scope-stage evidence:

- scope stage `status === 'passed'` → open `karst.openDashboard`;
- any other scope status, or no scope row → open `karst.editTicket`.

The scope stage is the product's existing source of truth for whether scoping is
complete: the workflow marks it passed when worktrees have been created, then
advances the ticket to implementation. Repository selection alone is insufficient
because a saved draft may have repositories selected without having completed
scope.

The selected `ticketId` is passed unchanged to either command.

## Boundaries

Only the ordinary active-row click emits `open-ticket`. The explicit expanded-row
`Open dashboard` button keeps emitting `open-dashboard`, and the existing global
`karst.openDashboard` command remains unconditional. Dashboard links, attention
pickers, status-bar actions, onboarding handoff, terminal binding, and every other
non-list caller therefore retain their current behavior.

Archived rows remain non-navigable, as they are today.

## Components

1. A vscode-free sidebar navigation helper accepts a `TicketWithStages` and returns
   `edit` unless its scope stage passed, otherwise `dashboard`.
2. The sidebar message protocol accepts and routes `open-ticket` with a finite
   numeric ticket ID.
3. The sidebar webview emits `open-ticket` from the active row-selection click.
4. The sidebar action factory loads the exact ticket, asks the helper for the
   destination, and executes the corresponding existing command with the same ID.

## Error Handling

Malformed sidebar messages continue to be dropped at the existing trust boundary.
An unknown ticket ID follows the sidebar message pump's existing caught-error path
and is logged; it must not open a different ticket or silently fall back to a
dashboard.

## Testing

Strict RED→GREEN tests cover:

- an absent, pending, running, or failed scope stage resolves to `edit`;
- a passed scope stage resolves to `dashboard`, even though repository selection
  is not consulted;
- `open-ticket` parsing rejects malformed IDs and routing preserves the correct ID;
- the row-click webview interaction emits `open-ticket`, while the explicit
  `open-dashboard` action remains available;
- host-side routing invokes the edit or dashboard command with the selected ticket
  ID.

Focused sidebar tests run first, followed by the complete test suite, typecheck,
and production build.

## Non-Goals

- No schema, workflow-machine, scope-stage, dashboard, or onboarding changes.
- No redirect inside the global `karst.openDashboard` command.
- No change to explicit dashboard buttons or navigation outside the ticket list.
- No inference from `selectedRepos`, worktree count, or presentation labels.
