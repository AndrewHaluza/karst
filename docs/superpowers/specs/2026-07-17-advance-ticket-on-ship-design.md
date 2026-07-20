# Advance ticket in the ticket provider after ship

Ticket: 869e5t7z2

## Problem

When karst ships a ticket it opens the PRs and moves its own stage to `done`, but
the ticket in ClickUp stays wherever it was. Someone has to go move it by hand,
which is exactly the kind of bookkeeping the orchestrator exists to remove.

Three pieces of the seam for this already exist and are inert:

- `updateTicketStatus` (`src/workflow/stages/done.ts`) is written, tested, and
  called by nothing.
- `clickupProvider.updateStatus` is a no-op stub (`/* not wired for ClickUp yet */`).
- `ticketing.listId` is parsed, stored, and surfaced in settings as "reserved for
  future list-scoped operations" — nothing reads it.

This feature makes all three load-bearing.

## Scope

In: an opt-in setting that pushes one status to the ticketing provider after a
successful ship, and the settings UI to configure it against a real status list
fetched from the provider.

Out: status pushes at any other stage boundary; per-ticket status overrides;
ClickUp custom fields; provider status *transitions* (validating the target is
reachable from the current status — ClickUp does not enforce this).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where the update fires | `extension.ts`, after `runShipTicket` resolves | Keeps the `[L4]` invariant: ship (PRs) and done (ticket status) stay independent, sharing only the ticket id. `ship.ts` is untouched. |
| Where the status list comes from | Fetched from the ClickUp list via `listId` | A typo in a free-text status would surface only at ship time, as a provider error, long after the person who typed it moved on. |
| Ship's fate if the update fails | Ship stays passed; warn only | The PRs are open and the branch is pushed — the irreversible part already succeeded. Ship has no `failed` edge in `graph.ts` (`graph.ts:34`, `ship: { passed: 'done' }`), so failing here would leave the ticket red despite its PRs existing. This is structurally guaranteed anyway: `ship.ts:120` transitions to done before the wiring below ever runs. |

## Config

```yaml
ticketing:
  provider: clickup
  teamId: "9001"
  listId: "42"
  advanceOnShip: true
  shipStatus: "in review"   # ClickUp status NAME, not id
```

`shipStatus` holds the status **name**: ClickUp's `PUT /task/{id}` takes
`{status: "<name>"}`, and `TicketingProvider.updateStatus(key, status: string)`
is already name-shaped. Storing an id would mean translating on every push.

Per the manifest checklist in CLAUDE.md:

- `types.ts` — add `advanceOnShip?: boolean` and `shipStatus?: string` to
  `TicketingConfig`.
- `schema.ts` — `validateTicketing` parses both: `advanceOnShip` must be a
  boolean (default `false`), `shipStatus` a string with blank normalized to
  undefined. Two coherence throws, so a configuration that cannot do anything
  never reaches disk to surprise someone at ship time:
  - `ticketing.shipStatus is required when ticketing.advanceOnShip is true`
  - `ticketing.advanceOnShip requires a provider that can set status (not 'manual')`
    — the UI hides the card for `manual`, but hand-written YAML reaches the schema.
    Without this, `manual` + `advanceOnShip: true` is silently inert forever:
    `extension.ts:386-392` builds a **fresh `manualProvider()` per getter access**
    (`ticketing.ts:50-58`), so the push allocates an `updates[]` array and discards
    it. Failing loudly beats a setting that reads as on and does nothing.
- `write.ts` — no code change needed; line 112 spreads `manifest.ticketing`
  wholesale, so new fields ride along. Covered by a round-trip test rather than an
  edit, per the "round-trips every modeled section" guard.

## Provider seam

```ts
export interface TicketingProvider {
  updateStatus(key: string, status: string): Promise<void>;
  fetchTicket?(ref: string): Promise<ContextBrief>;
  /** The status NAMES a ticket can be moved to, in provider order. Optional:
   *  `manualProvider` has no remote to list from. */
  listStatuses?(): Promise<string[]>;
}
```

Names, not `{id, name}` pairs: `updateStatus` takes a name, `shipStatus` stores a
name, and ClickUp marks status `id` optional — so an id would be a field this
feature never reads and could occasionally lack.

`listStatuses` is optional exactly as `fetchTicket` is, and for the same reason —
absence is how a provider says "unsupported", and callers already branch on it.

**ClickUp** implements both:

- `listStatuses()` — `GET /list/{listId}`, mapping the response's `statuses[]` to
  its `status` (name) field, preserving the order ClickUp returns. Throws
  `ClickupError` when `listId` is unconfigured. Entries with a non-string `status`
  are filtered out, matching how `parseTags`/`parseAttachments` already guard
  untrusted payloads (`clickup.ts:52-62`). A missing/empty `statuses` is returned
  as `[]` — a real response for a list that inherits from its Space, not an error.
  Colors and ids are deliberately dropped: nothing downstream reads them.
- `updateStatus(ref, status)` — `PUT /task/{ref}` with `{status}`, carrying the
  same `custom_task_ids`/`team_id` suffix the fetch path already builds. Needs a
  `putJson` helper alongside the existing `getJson`, with identical error framing
  (`ClickupError` on network failure, non-ok, and bad JSON).

`listId` is interpolated into a URL, so it is `encodeURIComponent`'d at the call
site — the same treatment `providerTicketUrl` already gives `sourceRef`
(`ticketUrl.ts:18`).

**Manual** gains no `listStatuses` and keeps recording updates into `updates[]`.

### Threading `listId` (currently impossible)

`listStatuses` cannot be built without a plumbing change that does not exist today.
`ClickupDeps` (`clickup.ts:25-30`) has no `listId` field, and `makeTicketingProvider`
drops it on the floor:

```ts
// ticketing.ts:74
return clickupProvider({ fetchFn, token, teamId: config.teamId });
```

with `ticketing.ts:64` stating the omission is deliberate — "`listId` is
intentionally not threaded — no ClickUp code path consumes it yet (§15)". This
feature is that code path. So:

- add `listId?: string` to `ClickupDeps`;
- pass `listId: config.listId` in `makeTicketingProvider`;
- rewrite the `ticketing.ts:64` comment, which becomes false.

The `ticketing` test must assert the id actually **reaches** the provider (a fake
`fetch` seeing `/list/42`), not merely that `listStatuses` exists — an existence
check passes while the feature is broken.

## Ship wiring

### The identifier: `sourceRef`, never `key`

`done.ts:21` currently derives its identifier as `ticket.key ?? String(ticketId)`.
Both halves of that are unsafe to send to a live provider, and the `??` fallback is
the lesser problem:

- **`String(ticketId)`** would `PUT /task/7` using karst's internal database row id,
  moving whichever unrelated ClickUp task answers to that id.
- **`ticket.key`** is no better. It is seeded from the fetched ref at create
  (`ui/onboarding/actions.ts:129`) but is **user-editable free text** thereafter:
  `updateTicketCore` (`store/tickets.ts:180-193`, "the Edit-mode MVP writer") is
  wired to the dashboard's edit action at `extension.ts:1342`. A manual ticket
  (`tickets.ts:110` defaults `source` to `'manual'`) has a hand-typed `key` and no
  ref at all — under `advanceOnShip` that becomes `PUT /task/<free text>` against a
  task nobody ever fetched.

The provider-authoritative handle in this codebase is **`sourceRef`** — the ref the
provider itself returned at fetch (`ui/onboarding/actions.ts:120,139`), and what
`providerTicketUrl` already builds ClickUp task URLs from (`ticketUrl.ts:11-20`,
`encodeURIComponent`'d). This spec follows that precedent.

Gating the *caller* on `ticket.key` would be cosmetic: it only makes the fallback
unreachable while still sending `key`. The identifier must change inside `done.ts`,
so `done.ts` changes — an earlier draft of this spec claimed it could stay as-is,
which was wrong.

### Shape

`done.ts` gains a pure resolver and an explicit decision function, so the whole
policy is testable and `extension.ts` holds one call rather than a hidden `&&`
chain:

```ts
/** The provider-side handle for a ticket: the ref the provider returned at fetch,
 *  never the user-editable `key`. null → nothing addressable to advance. */
export function providerRef(ticket: Ticket): string | null;

/** Push the post-ship status when configured and addressable. Returns why it
 *  did nothing, so the caller can log rather than guess. */
export async function advanceTicketOnShip(
  store: Store,
  ticketId: number,
  ticketing: TicketingConfig | undefined,
  provider: TicketingProvider,
): Promise<{ advanced: true } | { advanced: false; reason: 'disabled' | 'no-ref' }>;
```

`advanceTicketOnShip` owns the `advanceOnShip && shipStatus` check and the
`providerRef` guard, then calls `provider.updateStatus(ref, status)`.
`updateTicketStatus` is folded into it — keeping a second, key-derived seam
alongside would leave the hazardous path callable and re-create the dead code this
feature exists to retire. `lifecycle.integration.test.ts:119` and `ship.test.ts:290`
(its only callers, both seeding a keyed ticket) move to seeding `sourceRef`.

In `extension.ts`, the dashboard's `shipTicket` handler, after `runShipTicket`
resolves:

```
runShipTicket(...)
  → advanceTicketOnShip(store, ticketId, currentManifest()?.ticketing, provider)
  → afterServerChange()
```

The provider is read through the same fresh-getter pattern onboarding uses
(`makeTicketingProvider(currentManifest()?.ticketing, fetch, makeTokenProvider(context))`)
so a status saved in settings applies without a window reload.

The status push gets its own `.catch`: it logs via `logError` and shows a
**warning** toast (`Ticket shipped, but the status update failed: <message>`),
never touching the ship stage. The PRs are the thing that mattered and they exist.

## Settings UI

A second card in the Ticketing section, below the provider card, present only when
provider is `clickup`. Manual has no statuses to list and advancing a local no-op
record means nothing, so the card is absent rather than disabled.

```
┌─ Ticketing ─────────────────────────────────┐
│  Provider   [ ⬤ ClickUp        ▾ ]          │
│  Team ID    [ 9001            ]             │
│  List ID    [ 42              ]             │
│  API token  Token: configured  [Set] [Clear]│
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│  ◉ Set the ticket status when karst ships   │
│                                             │
│  Status after ship                          │
│  [ in review              ▾ ]  [ Refresh ]  │
│  Add a List ID and API token to load statuses│
└─────────────────────────────────────────────┘
```

Built from the panel's existing devices (`.card`, `.toggle`, `.row`,
`.installed-tag`). The status control is a native `<select>`, not the custom
`provselect`: that machinery exists only because a branded icon badge cannot
render inside an `<option>`, and a native select buys keyboard and screen-reader
behavior for free.

### States

| State | Select | Hint line |
| --- | --- | --- |
| Toggle off | row hidden | — |
| No `listId` or no token | disabled | `Add a List ID and API token to load statuses.` |
| Fetching | disabled | `Loading statuses…` |
| Loaded | populated; saved value selected, or the first status when none is set | — |
| Loaded but empty | disabled | `This list has no statuses.` |
| Saved status absent from list | populated, stale value kept as an option | `"in review" is no longer in this list.` |
| Fetch failed | disabled | the `ClickupError` verbatim |

The fifth row is load-bearing: if someone renames the status in ClickUp, the
configured value must not silently vanish from the dropdown and then save itself
away as empty.

### The draft can never hold the invalid pair

The schema throws on `advanceOnShip: true` + blank `shipStatus`. Left alone, the
obvious path walks straight into it: toggle on → statuses are still loading, nothing
selected → Save → `actions.ts:100-104` posts a **panel-level** `{type:'error'}`,
which is exactly the banner this design routes status problems away from.

So the webview never lets the pair exist. `advanceOnShip` is only set true in the
draft once a `shipStatus` is actually selected; on load, the select defaults to the
first fetched status (row four above), which resolves the normal case instantly. If
the statuses cannot load, the toggle stays visually on but the draft keeps
`advanceOnShip: false` and the hint line says why — no silent Save of a setting
that would fail. The schema throws stay as the backstop for hand-written YAML.

### Fetch trigger

Fires when the toggle turns on, and on `Refresh`. Not on `listId` keystrokes — that
would hammer the API on the way to a valid id.

The message carries `listId`/`teamId` **from the draft**, not from disk, so Refresh
works before Save. The alternative is a hint reading "save first," which is a worse
answer than making it work. The host guards both as strings (the webview is
untrusted) and builds a provider from them via `makeTicketingProvider`.

The consequence is that the fetched list reflects the draft while `shipStatus` is
saved against it — correct, since both are saved together by the same Save. A
`listId` edited *after* statuses load leaves the list stale until Refresh; that is
what the Refresh button is for.

### The host seam this needs

`SettingsActionsDeps` (`actions.ts:14-55`) has no `fetch`, no token accessor, and no
provider factory, so `fetchTicketStatuses` cannot be built from it today. Add one
injected dep, bound in `extension.ts` where `fetch` and `makeTokenProvider` already
live:

```ts
/** Build a ticketing provider for an ad-hoc config (the settings draft), so the
 *  statuses list can be fetched before the config is saved. */
makeProvider(config: TicketingConfig): TicketingProvider;
```

This is what keeps the fetch action unit-testable — tests inject a fake provider,
and `actions.ts` stays free of `fetch` and of `vscode`.

### Messages

```ts
// webview → host
| { type: 'fetch-ticket-statuses'; listId: string; teamId?: string }

// host → webview
| { type: 'ticket-statuses'; statuses: string[] }
| { type: 'ticket-statuses-error'; message: string }
```

`parseSettingsMessage` narrows `fetch-ticket-statuses` with the existing `str()`
envelope guard: `listId` non-empty, `teamId` optional-but-string.

A dedicated error type rather than the existing `{type:'error'}` so a failed status
fetch lands on the hint line beside the control instead of the panel-level banner.

### Copy

Active voice, saying what happens rather than naming the mechanism: the toggle is
"Set the ticket status when karst ships", not "Enable auto-advance". The hint for a
missing prerequisite is directive ("Add a List ID and API token to load statuses.")
rather than apologetic. Fetch errors state what happened, verbatim from the
provider.

## ClickUp API — verified

Nothing in `src/` performs a `PUT` or reads a `statuses[]` (`clickup.ts:88-106` has
only `getJson`), so both assumptions were checked against external sources before
committing to the schema.

**`PUT /task/{id}` sets status by NAME — confirmed.** The body is
`{"status": "in progress"}`, a display-name string, not a status id. Confirmed by
[ClickUp's Update Task reference](https://developer.clickup.com/reference/updatetask)
and independently by the [`clickrup`](https://github.com/psolymos/clickrup) client,
which PUTs `status = "in progress"` as a plain string. `shipStatus` therefore stores
a **name**, as designed — the schema stands.

**`GET /list/{listId}` returns `statuses[]` — confirmed, with caveats.** Two
independent typed clients agree on the shape —
[raycast/extensions](https://github.com/raycast/extensions/blob/main/extensions/clickup/src/types/clickup.ts):

```ts
export interface ClickUpStatus {
  color: string;
  id?: string;
  orderindex?: number;
  status: string;   // ← the NAME
  type?: string;
}
export interface ClickUpList {
  statuses?: ClickUpStatus[];
  override_statuses?: boolean;
  // …
}
```

corroborated by [activepieces](https://github.com/activepieces/activepieces/blob/main/packages/pieces/community/clickup/src/lib/output-schemas.ts).
Two consequences the earlier draft got wrong:

- **The name lives in `status`, and `id` is optional.** Since `shipStatus` stores a
  name, the id is decorative — and requiring it would let a status with no `id`
  drop out of the list for no gain. `TicketStatus` is cut: `listStatuses(): Promise<string[]>`.
- **`statuses` itself is optional**, and `override_statuses` implies a List can
  inherit its statuses from its Space rather than define its own. A missing or
  empty array is therefore a real, reachable response, not a malformed one. It gets
  its own hint (`This list has no statuses.`) rather than an empty dropdown or a
  thrown `ClickupError`.

**The case-normalization worry was unfounded.** No evidence ClickUp lowercases
names server-side; the docs show both `"in progress"` and `"Open"`. It is moot
regardless: the select is populated *from* the fetched list, so a saved
`shipStatus` is always a verbatim provider name. Exact string match is correct, and
the only way to drift is a rename in ClickUp — which is exactly the "stale value
kept as an option" state. No case-insensitive comparison needed.

A `shipStatus` that no longer exists makes ClickUp reject the `PUT`; that lands in
the warn-only path, which is the intended behavior.

**Double-firing is possible but benign.** `nowLine.ts:84-89` only offers ship at the
`ship` stage, and a failed ship rejects so `.then()` never fires — the normal retry
path cannot double-push. But `machine.ts:40-52` transitions off the `ship` row
rather than `stage_current`, so a stale dashboard or a fast double-click can re-run
`shipTicket` at `done` and re-push. PUTting the same status name twice is harmless;
the real edge is re-pushing "in review" over a status a human has since advanced.
Accepted, not mechanised — worth knowing, not worth a lock.

## Testing

Unit, all against fakes — no `vscode` import anywhere in the tested modules.

- `schema` (via `loadManifest`, per the no-`schema.test.ts` convention): defaults
  `advanceOnShip` to `false`; parses the pair; rejects `advanceOnShip: true` with a
  blank/absent `shipStatus`; rejects `advanceOnShip: true` with `provider: manual`;
  rejects a non-boolean `advanceOnShip`.
- `write`: round-trips `advanceOnShip`/`shipStatus` (extends the existing
  "round-trips every modeled section" test).
- `clickup`: `listStatuses` maps `statuses[]` → names in provider order; returns
  `[]` for a response with no `statuses` (the Space-inherited case); drops entries
  with a non-string `status`; throws `ClickupError` without a `listId`, on non-ok,
  and on bad JSON. `updateStatus` PUTs the right URL + `{status}` body and carries
  the `team_id` suffix when `teamId` is set.
- `ticketing`: `makeTicketingProvider` threads `listId` through to the provider —
  asserted via a fake `fetch` observing `/list/42`, **not** by checking that
  `listStatuses` merely exists. The manual provider does not expose `listStatuses`.
- `done` (new `done.test.ts` — the only stage module without one): `providerRef`
  returns `sourceRef`, and `null` for a ticket with a `key` but no `sourceRef` —
  the manual-ticket case that must never reach a live provider. `advanceTicketOnShip`
  pushes `shipStatus` for a configured, ref-bearing ticket; returns
  `{advanced:false, reason:'disabled'}` when `advanceOnShip` is false or
  `shipStatus` is blank; returns `reason:'no-ref'` rather than pushing when
  `providerRef` is null.
- `settings/messages`: `fetch-ticket-statuses` parses and routes; junk envelopes
  (missing/blank `listId`, non-string `teamId`) drop.
- `settings/actions`: `fetchTicketStatuses` posts `ticket-statuses` on success and
  `ticket-statuses-error` with the provider's message on throw (fake provider via
  the new `makeProvider` dep).

The `extension.ts` wiring is not unit-testable — it is the `vscode` binding. That is
why `advanceTicketOnShip` owns the whole decision (enabled? status set? ref
addressable?) rather than an `&&` chain at the call site: the untestable surface is
one call, and every branch that could push a status to a live provider is covered by
`done.test.ts`.

## Manual verification

1. Set provider ClickUp, a real `teamId`/`listId`, and a token; open Ticketing.
2. Toggle on → statuses load from the list. Toggle a bad `listId` + Refresh → the
   ClickUp error shows on the hint line.
3. Pick a status, Save, reopen the panel → the value persists and is selected.
4. Ship a ticket fetched from ClickUp (so it has a `sourceRef`) → the task moves to
   that status; the PRs still open.
5. Ship a **manual** ticket whose `key` was hand-typed to look like a ClickUp id →
   nothing is pushed, no task moves. This is the hazard the `sourceRef` guard
   exists for; confirm it by watching for the absence of a network call, not just a
   green ship.
6. Break the token, ship again → PRs open, ship stays green, a warning toast names
   the failure.
