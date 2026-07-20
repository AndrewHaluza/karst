# List picker — addendum to advance-ticket-on-ship

Follow-up to `2026-07-17-advance-ticket-on-ship-design.md`, driven by F5 testing.

## Problem

The settings Ticketing page asks for a raw numeric **List ID**. ClickUp's "Copy
link" gives a List *view* URL (`/v/l/<viewId>`) whose last segment is a **view
id** (e.g. `2kxuxtf2-432`), not the numeric list id the API needs. Pasting it
yields `GET /list/<viewId>` → 400. Real users will hit this every time.

## Fix

Replace the List ID text field with a **fetched List dropdown**: the extension
enumerates the workspace's lists (it already has token + teamId) and the user picks
by name. The numeric id is stored in `ticketing.listId` exactly as before — no
schema change. Mirrors the status-dropdown pattern already built and reviewed.

## API (verified)

No single "all lists" endpoint; walk the hierarchy with the stored `teamId`:

- `GET /team/{teamId}/space` → `{ spaces: [{ id, name }] }`
- per space: `GET /space/{spaceId}/list` → `{ lists: [{ id, name }] }` (folderless)
- per space: `GET /space/{spaceId}/folder` → `{ folders: [{ id, name, lists: [{ id, name }] }] }`
  (folders embed their lists, so no extra `/folder/{id}/list` call)

Calls = `1 + 2 * spaceCount`. Sequential is fine at this scale; guard every payload
array the house way (`filter` on shape), since the response is untrusted.

## Provider seam

```ts
export interface TicketList {
  id: string;    // numeric list id — what ticketing.listId stores
  name: string;  // list name
  space: string; // owning space name, for disambiguating same-named lists
}

interface TicketingProvider {
  // …existing…
  /** All lists in the workspace, for the settings List picker. Optional:
   *  `manualProvider` has no remote. Needs a configured teamId. */
  listLists?(): Promise<TicketList[]>;
}
```

Unlike `listStatuses` (names only), lists need `{id,name}`: the id is stored, the
name is shown. `space` labels the option so two lists named "Backlog" are
distinguishable. ClickUp impl throws `ClickupError` when `teamId` is unconfigured.
`teamId` is already threaded through `makeTicketingProvider`.

## Messages

```ts
// webview → host
| { type: 'fetch-ticket-lists'; teamId: string }
// host → webview
| { type: 'ticket-lists'; lists: TicketList[] }
| { type: 'ticket-lists-error'; message: string }
```

Parallel to the status trio. Draft-sourced `teamId` (Refresh works before Save),
guarded as a non-empty string.

## Settings action

`fetchTicketLists(teamId)` — builds a provider from the draft config via the
existing `makeProvider` dep, calls `listLists()`, posts `ticket-lists` or
`ticket-lists-error`. Missing `listLists` → `ticket-lists-error`
("This provider cannot list lists.").

## UI

Replace the `#f-ticketListId` text input with a `<select>` + Refresh + hint,
following the status control's six states (not-loaded / loading / loaded /
loaded-empty / stale-saved / fetch-failed). Fetch fires on section open (when
`teamId` + token present) and on Refresh — never on teamId keystrokes.

- Option value = list `id`; label = `"<space> / <name>"`.
- Selecting a list writes `cfg.listId = <id>`, and **resets `ticketStatuses` to
  null** so the status dropdown refetches against the new list (statuses are
  list-scoped — a stale status list from the previous list would be wrong).
- A saved `listId` not in the fetched set stays as a selected option showing the
  raw id, with hint `"<id>" is no longer in this workspace.` — never silently
  dropped (same rule as the stale status).
- Prereq hint when teamId/token missing: `Add a Team ID and API token to load lists.`

## Testing

- `clickup`: `listLists` merges folderless + folder-embedded lists across spaces,
  tags each with its space name, preserves order; drops malformed entries; throws
  `ClickupError` without `teamId`, on non-ok, on bad JSON; returns `[]` for a
  workspace with no lists.
- `ticketing`: `makeTicketingProvider` exposes `listLists` on ClickUp (threads
  teamId), not on manual.
- `settings/messages`: `fetch-ticket-lists` parses (teamId required) + routes; junk
  drops.
- `settings/actions`: `fetchTicketLists` posts `ticket-lists` on success,
  `ticket-lists-error` on throw and on a provider without `listLists`.
- webview: no unit test (runtime asset) — manual F5.

## Manual verification

Team ID + token set → open Ticketing → the List dropdown populates with
`space / name` entries → pick the list → statuses load for it → Save → reopen →
list + status persist and are selected.
