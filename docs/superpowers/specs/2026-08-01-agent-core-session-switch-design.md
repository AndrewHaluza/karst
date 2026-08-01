# Agent-core session switch design

Ticket: 869eck5hn

## Goal

Let a user replace a live implementation or fix session with another agent
core when the current core cannot finish, for example because it reached a
usage limit. The replacement starts immediately with the ticket's live context
and shared worktree. Worktree changes, ticket stage, and workflow evidence are
preserved.

The interaction must be honest about the interruption: changing agent core is
not a harmless setting update. It closes the current terminal and starts a new
provider-owned conversation.

## UX

The ticket dashboard is the primary entry point. While a ticket is at `impl` or
`fix` and `SessionManager` reports a live terminal, the `Now` row shows:

- the existing `Open` action;
- a secondary `Switch agent…` action beside it; and
- the resolved current agent core and model in the supporting text.

The action runs a three-step native VS Code flow:

1. Choose a replacement agent core. The current core remains visible but is not
   selectable.
2. Choose a model compatible with that core. Catalog models use the
   host-supplied model catalog. The null choice is labeled `Inherit (settings:
   <model>)` when the manifest default is compatible, otherwise `Agent default`.
3. Confirm: `Switch from <current core> · <current model> to <new core> · <new
   model>?` The explanation states that Karst will close the current terminal,
   create a fresh provider conversation, and retain files and ticket progress.

The confirmation buttons are `Cancel` and `Switch and continue`. Cancellation
at any step changes nothing. After a successful launch, the dashboard shows the
new resolved core and model.

The dashboard does not offer the switch while there is no live terminal, or at
non-interactive stages. In those states, the existing Edit Ticket and
Start/Continue/Resume actions remain the correct entry points.

## Theme and accessibility contract

The dashboard addition uses the existing webview's semantic `--vscode-*`
tokens and existing button typography, spacing, focus, hover, and disabled
patterns. It introduces no literal black, white, or agent-brand colors.

Provider/model selection and confirmation use native VS Code Quick Pick and
modal UI, so they inherit the active light, dark, high-contrast, and custom
theme automatically. Labels carry the meaning; color is never the sole signal.
The dashboard action has visible text and a focus-visible outline, and the
supporting core/model text remains readable through
`--vscode-descriptionForeground`.

## Dashboard state and message boundary

`DashboardState` gains a host-rendered agent-session view containing:

- resolved provider id and display label;
- resolved model id and catalog label, or `Agent default` when resolution sends
  no model to the CLI; and
- `canSwitch`, true only when the stage is `impl` or `fix` and the injected
  live-session predicate reports an open terminal.

The state builder remains VS Code-free. It receives the model catalog and
live-session predicate through injected arguments, just as it already receives
the manifest default provider, approach phases, and repository-runnability
predicate.

The webview posts only `{ type: 'switch-agent' }`. It cannot provide a ticket
id, provider, model, command, path, or confirmation flag. The dashboard panel
closure owns the ticket id, and all provider/model choices and confirmation are
collected host-side. Crafted companion fields are dropped by the message
parser.

## Switch coordinator

A small VS Code-free coordinator owns the state-changing portion of the switch.
It receives injected operations rather than importing `vscode`:

- read the current ticket/provider/model;
- check whether a live session still exists;
- persist provider and model together;
- dispose the current session;
- launch a fresh session; and
- report completion or a typed failure.

The extension host owns presentation: native pickers, dependency messaging,
confirmation, and user-visible errors. Keeping the coordinator separate makes
ordering and failure behavior directly testable without loading `vscode`.

## Data flow and ordering

1. Re-read the ticket when the action begins; never trust the dashboard
   snapshot that rendered the button.
2. Refuse a stale action if the stage is no longer `impl`/`fix` or the terminal
   is no longer live. Refresh the dashboard instead.
3. Show implemented cores other than the resolved current core.
4. After the user chooses a core, probe that core's `sessions` dependency using
   its own dependency registry. A missing or unhealthy replacement CLI stops
   here; the current session remains untouched.
5. Show the selected core's catalog models plus the null/inherit choice. Label
   that choice `Inherit (settings: <model>)` when the manifest default resolves
   compatibly for the selected core, otherwise `Agent default`. If the current
   ticket model is compatible, it may be preselected; it is never silently
   carried across an incompatible core.
6. Ask for modal confirmation.
7. Re-read and revalidate the stage and live terminal after confirmation to
   close the time-of-check/time-of-use window.
8. Persist `agent_provider` and `model` in one `updateTicketOnboarding` call.
   The null/inherit choice persists a null ticket model through the existing
   empty-string convention; launch-time resolution then uses a compatible
   manifest default or lets the agent CLI choose.
9. Call `SessionManager.disposeSession(ticketId)`. It releases the one-session
   guard before VS Code reports the old terminal's delayed close, and its
   identity checks prevent that close from deleting the replacement.
10. Invoke the normal `karst.openSession` command. It re-reads the ticket,
    resolves the selected adapter and model, rebuilds fresh ticket context and
    approach materialization, and reveals the replacement terminal.
11. Refresh dashboard, sidebar, status, and attention state.

The existing `session_provider` comparison in `shouldResumeSession` is the
cross-core safety property. The stored session id remains tagged with the core
that minted it, so the newly selected provider receives no foreign `--resume`
argument. Its first launch is fully seeded from the live ticket context.

## Failure handling

- Cancellation, picker dismissal, missing replacement CLI, or failed readiness
  probe performs no write and does not close the current terminal.
- A stale dashboard action performs no write and refreshes the dashboard.
- Persistence failure leaves the current session intact and reports the error.
- Once persistence succeeds and the old terminal is disposed, a launch failure
  leaves the ticket idle with the newly selected core/model. Karst reports the
  failure and the ordinary Start action retries the same selected core. It does
  not silently reopen the old core or claim the switch succeeded.
- Delayed hooks or close events from the retired launch remain quarantined by
  the existing launch-generation lifecycle checks.

## Testing

### Pure behavior

- The switch is available only for a live `impl`/`fix` session.
- Resolved provider/model labels use the ticket override, compatible manifest
  default, and agent-default precedence correctly.
- Provider options omit the current provider.
- Model options contain only compatible catalog rows plus the accurately
  labeled null/inherit choice.
- Cancellation and dependency failure perform no persistence, disposal, or
  launch.
- A stale stage/session performs no mutation.
- Provider and model persist before terminal disposal, and disposal precedes
  launch.
- Launch failure returns a retryable idle outcome without rolling back to the
  old provider.

### Boundaries and integration

- Dashboard message parsing accepts payload-free `switch-agent` and drops
  crafted provider/model/ticket fields.
- Dashboard state and HTML render current core/model and the switch action only
  when allowed.
- The selected provider's dependency registry is probed before disposal.
- The normal launch path resolves the new adapter/model and does not pass the
  old provider's session id.
- SessionManager's delayed-close identity guard keeps the replacement terminal
  registered after the old terminal reports closure.
- Webview checks assert semantic theme tokens and reject new hard-coded
  foreground/background colors for this control.
- Focused tests, the full Vitest suite, typecheck, build, and `git diff --check`
  pass.

## Out of scope

- Migrating or translating conversation history between agent providers.
- Running two agent cores concurrently for one ticket.
- Switching during UAT, review, ship, or done.
- Changing the project-wide default provider.
- Installing a missing agent CLI from the switch flow.
- Adding provider-brand colors or icons.
