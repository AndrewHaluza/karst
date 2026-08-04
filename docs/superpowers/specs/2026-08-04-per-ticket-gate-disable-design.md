# Per-ticket gate disable

## Problem

`uat.gates`/`review.gates` (and their `repositories.<name>.gates` overrides) are
global, in `karst.yml`. A user who wants one specific ticket to stop being
blocked by a gate (flaky e2e suite, known-broken lint rule, etc.) has no way to
do that without editing the global manifest — which affects every other ticket
too, and has to be reverted afterward.

## Scope

Per ticket, per stage (`uat` / `review`), disable individual named gates by
name. Not a full gate-list override, not a "skip whole stage" toggle — the
resolved gate list stays the source of truth; disabling only removes named
entries from it for that one ticket.

A disabled gate never runs, never blocks, and is visibly reported on the
dashboard as skipped-by-user (not silently absent, not conflated with "repo
doesn't have this script" which already means something else — see Evidence).

## Storage

New nullable `tickets.disabled_gates` column (TEXT, JSON), migration v23:

```json
{ "uat": ["e2e"], "review": ["lint"] }
```

Absent/`NULL`/empty per-stage array = nothing disabled for that stage. Same
shape as the existing `tickets.model`/`tickets.type` per-ticket-override
columns (`store/ticketTypes.ts` precedent): a nullable column that means "no
override, fall back to resolved default" when empty.

`store/ticketGates.ts` (new) owns read/write:

```ts
export interface DisabledGates {
  uat: readonly string[];
  review: readonly string[];
}
export function getDisabledGates(store: Store, ticketId: number): DisabledGates;
export function setDisabledGates(
  store: Store,
  ticketId: number,
  stage: 'uat' | 'review',
  names: readonly string[],
): void;
```

`setDisabledGates` writes only the named stage's array, leaving the other
stage's list untouched — mirrors the tab-scoped-save principle already used
elsewhere in this codebase (settings save is per-section, not whole-draft).

## Resolution

Filtering happens *after* `resolveGates` produces the resolved list, in
`resolveTargetGates` (`workflow/stages/uat.ts`) and `resolveReviewGates`
(`workflow/review/gates.ts`) — both already the single seam each stage goes
through regardless of whether a gate was declared or auto-discovered, so
filtering there covers both uniformly by `ResolvedGate.name`.

Both functions gain a `disabledNames: readonly string[]` parameter, threaded
from the ticket (`getDisabledGates(store, ticketId)[stage]`) at the
`stages/uat.ts` / `stages/review.ts` call sites, which already have `ticketId`
and `store` in scope. `resolveGates` itself (`workflow/gates/resolve.ts`) is
untouched — it stays the pure declared/discovered resolution function; the
per-ticket cut is a filter applied to its output, not a new parameter threaded
through it.

Disabled gates removed here are reported separately (see Evidence) so the
caller can tell "resolved to zero gates because nothing declared/discovered"
(existing `unavailable`/`nothing-to-run`) apart from "resolved to zero gates
because the user disabled all of them" (new: still a pass, not `unavailable`
— the ticket asked for nothing and got nothing to fail).

## Evidence

New nullable `gate_runs.skipped` column (INTEGER 0/1), same v23 migration as
`disabled_gates`. A disabled gate still gets one row per stage attempt:
`skipped=1`, `exit_code`/`command`/`args`/`started_at`/`ended_at` all `NULL`.

This is deliberately a new column, not reusing `exit_code IS NULL` — that
already means "repo defines no such script (NOT a pass)"
(`schema.sql`'s existing comment on `gate_runs.exit_code`), a different fact
than "this gate exists and was deliberately not run". Conflating the two
would make a disabled gate read as an absent script, or vice versa.

`recordGateRun` (`store/gateRuns.ts`) and its `GateRun`/`GateRunBatch` types
gain the field; `rowToGateRun` maps it through. Aggregation
(`stageBlocks.ts`/wherever gate rows currently decide pass/fail) treats
`skipped=1` as excluded from the required-gates check entirely — same
exclusion the resolution-time filter already gives it, this is just the
recorded trail agreeing with what ran.

## Dashboard / CLI display

A skipped gate renders as "Skipped — disabled by user" wherever gate rows are
shown (ticket detail panel gate list, `karst context` CLI output). New neutral
state in the stage palette (`model/stagePalette.ts`) — distinct from
pass/fail/pending, since it is neither a signal nor an unanswered question.

## UI

Ticket detail panel gains a "Gates" section: the *resolved* gate names for
`uat` and `review` (from the same resolution the stage itself would run,
computed on demand — not the raw manifest list, since repo-scoped overrides
and auto-discovery both affect what's actually resolved), each with an
enable/disable toggle.

Follows the existing control conventions (UI-R11–R14): toggle shows pending
state on click, cannot be re-triggered mid-flight, reports a terminal outcome
via the existing `action-result` dispatch shape, watchdog timeout reports
"unknown" rather than a false failure. Posts `{type:'set-disabled-gates',
stage, name, disabled}` to the host, which calls `setDisabledGates` and
returns the updated list so the panel re-renders from server truth rather than
optimistic local state.

## Live effect

No new wiring needed here: `driveTicket`'s gate execution already reads
`opts.manifest` fresh (a getter, `DriveTicketDeps.manifest: () => Manifest |
undefined`) rather than a value snapshotted at session start — the same
property the mid-run-yml-changes fix (869edm2u7) relies on. Since the
disabled-gates filter reads directly from the store at resolution time (not
from anything cached), a toggle flipped mid-session takes effect on the next
gate run for that ticket, no session restart, no manifest edit required.

## Out of scope

- Editing the gate's command/script per ticket (only enable/disable by name).
- Disabling a whole stage's gates in one action (disable each name
  individually; a "disable all" convenience button is a UI nicety, not
  required for this ticket).
- Re-enabling automatically on any schedule — stays disabled until a human
  toggles it back.
