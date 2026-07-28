# Per-ticket agent core (provider) override

Ticket: 869ea07v4

## Problem

`AgentProvider` (`claude` | `codex` | `antigravity`) — the "agent core" — is
global-only today, set via `manifest.agentProvider` and read at every launch
and dependency-check site in `extension.ts`. Sometimes a specific ticket needs
a different core than the project default. Per-ticket **model** override
already exists end-to-end (`ticket.model`, `resolveModel`/
`resolveModelForProvider`, editable in the onboarding webview's create/edit
page). This feature mirrors that exact pattern one level up, for provider.

## Data layer

- New nullable column `tickets.agent_provider` (schema.sql + a guarded
  `ALTER TABLE` in `migrations.ts`, `SCHEMA_VERSION` 11 → 12), same shape as
  v5's `model` column. `NULL` = inherit the manifest default.
- `Ticket.agentProvider: AgentProvider | null` in `store/tickets.ts`.
- `TicketPatch.agentProvider?: AgentProvider | ''` — `''` clears back to
  inherit (NULL), same convention `model` uses.

## Resolution

- `resolveProvider(ticketProvider, manifestProvider): AgentProvider` added to
  `agent/registry.ts` (already home to `IMPLEMENTED_PROVIDERS`/
  `resolveAdapter`):

  ```ts
  export function resolveProvider(
    ticketProvider: AgentProvider | null | undefined,
    manifestProvider: AgentProvider | null | undefined,
  ): AgentProvider {
    return ticketProvider ?? manifestProvider ?? 'claude';
  }
  ```

- Every `extension.ts` site currently doing
  `currentManifest()?.agentProvider ?? 'claude'` for a specific ticket's
  action gets that ticket's id threaded through and calls
  `resolveProvider(t.agentProvider, currentManifest()?.agentProvider)`
  instead:
  - `currentAgentAdapter` (becomes ticket-aware, or is replaced at call sites
    that have a ticket id with a direct `resolveAdapter(resolveProvider(...))`
    call)
  - `guardCapability` (gains an optional ticket-id parameter; all four call
    sites — `gates` in `maybeDrive`, `sessions` in `openSession`, `worktrees`+
    `gates` in `spinTicket`, `ship` — have a ticket id in scope)
  - the launch-site model resolution: `resolveModelForProvider`'s first
    argument becomes the resolved per-ticket provider instead of the global
    one
  - the onboarding host's `adapter` getter used by `startTicket`
- Global-only spots with no single ticket in view — the status bar
  (`refreshDepsStatus`), the welcome page (`loadWelcomeState`) — stay on the
  manifest default; they are not scoped to one ticket's action.
- Provider-switch safety net: `resolveModelForProvider` already drops a
  ticket's model pick when it's incompatible with the resolved provider,
  falling back to the manifest default model. Feeding it the resolved
  per-ticket provider (instead of always the global one) makes that guard
  correct for ticket-level overrides too — no new compatibility logic needed.

## UI (onboarding webview — serves both create and edit)

- `OnboardingState` gains:
  - `agentProviders: AgentProvider[]` — from `IMPLEMENTED_PROVIDERS`
  - `selectedAgentProvider: AgentProvider | null` — the ticket's own pick;
    `null` = inherit
  - `defaultAgentProvider: AgentProvider` — the manifest's resolved default,
    for the "Inherit (settings: …)" label
  - Named to avoid collision: `OnboardingState.provider` already means the
    *ticketing* integration provider (manual/clickup), unrelated to agent
    core.
- Renders as a new `<select>` next to the model picker: "Inherit (settings:
  claude)" plus the three implemented providers.
- Locks (`disabled`) while `sessionOpen`, identical to the model picker — the
  adapter is baked into the terminal at spawn and can't hot-swap mid-session.
- Changing it re-filters the model `<select>` via `modelsForProvider`, the
  same way switching the global provider already does in settings.

## Wiring

- `OnboardingMessage` gains `{ type: 'set-provider'; id: string }` (mirrors
  `set-model`; `''` means "Inherit").
- `TicketDraftFields` gains `agentProvider: AgentProvider | null`; `submit`/
  `save` carry it through `parseDraftFields`/`routeOnboardingAction` the same
  way `model` is threaded today.
- `OnboardingActions.setProvider(id)` → `updateTicketOnboarding(store,
  ticketId, { agentProvider: id })`.
- `persistDraft` in `actions.ts` gains `agentProvider: input.agentProvider ??
  ''` alongside its existing `model: input.model ?? ''` line, so create mode
  persists the pick on first submit/save exactly like model does.

## Out of scope (YAGNI)

No sidebar/dashboard badge showing the override — the ticket only asks for
edit-page control. The existing `model` field is already surfaced to sidebar
state as a precedent; adding a provider badge later is the same shape of
change if wanted.

## Testing

- Unit: `resolveProvider` (`registry.test.ts`).
- Store round-trip + migration: `tickets.test.ts`, `db.test.ts` (version and
  table-column-count assertions bumped for v12).
- `messages.test.ts`: `set-provider` message parsing/routing, `agentProvider`
  in draft-field parsing.
- `state.test.ts`: new state fields present and correct in both create and
  edit mode, including the "Inherit (settings: X)" default label and the
  session-open lock.
- `extension.ts` has no direct unit tests today (only the shallow
  `extensionActivation.test.ts`); the launch-site wiring changes there follow
  the file's existing untested style — consistent with how the `model`
  threading was added, not a new gap this feature introduces.
