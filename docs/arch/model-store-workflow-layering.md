# `model` / `store` / `workflow` layering

`model` is presentation-shaping (view-model derivation), `store` is persistence
(SQLite reads/writes), `workflow` is the stage graph (pure shape + transition
rules). The directory names suggest a strict one-directional stack with
`model` at the dependency-free bottom. It is not: import edges run both ways.
This is layer erosion (naming implies an invariant the code doesn't enforce),
not a live bug — a Tarjan SCC over the whole `src/` graph finds zero cycles,
so nothing here can deadlock a module's own load.

## What the edges actually are

- **`model` → `store`, ~52 edges.** All but one file use `import type` only —
  erased at compile time, zero runtime coupling (e.g. `store/tickets.js`'s
  `TicketWithStages` type, `model/inside/*.ts` pulling row types for view
  derivation). **`model/artifacts.ts` is the exception**: it imports and
  calls live `store` query functions (`getTicket`, `listGateRuns`,
  `listFindings`, …) against a real `Store` handle. That one file does
  genuine stateful reads from `model/`, not just type-sharing.
- **`store` → `model`, 15 edges across 11 files.** 11 of the 15 import
  statements are `type`-only (`StageKey`, `StageStatus`, `BlockerKind`,
  `PrComment`, …). The 4 value imports are pure serialization helpers with no
  side effects: `compactTicketLabel`, `serializeComments`/`parseComments`,
  `serializeChecks`/`parseChecks`/`readMergeBlock`, and `nowIso` (wraps
  `Date.now()`). None hold a `Store` or do I/O.
- **`model` → `workflow/graph.js`** (`stageRail.ts`, `ticketGlyph.ts`,
  `stageBadge.ts`): `needsConfirm`, `isTerminal`, `countFixAttempts`,
  `lastFailedGate`, and the `STAGE_GRAPH`/`MAIN_LINE`/`GATE_STAGES`
  constants — pure lookups over already-loaded stage rows. No DB access, no
  side effects.

## The actual rule (documented here since the naming doesn't say it)

`model` is not import-free; it is **side-effect-free**. It may import types
from anywhere, and it may import pure functions/constants from `store` or
`workflow` (no `Store` handle, no I/O, no mutation) — those keep it testable
without a database, which is the property that matters (see
`docs/design/impl-phase-tracking.md`'s "picking the latest batch is a pure
decision that belongs in the model layer"). What `model` must not do is call
a function that reads or writes through a live `Store`.

**`model/artifacts.ts` is accepted as-is, not fixed here.** It derives
per-ticket artifact views (uat-report, review, ship-summary) that need the
same evidence rows the store's own read helpers already know how to fetch;
duplicating those queries into `model/` would be the actual anti-pattern
(two places that know how to read `gate_runs`). If a stricter "model never
touches `Store`" invariant is wanted later, the fix is to have the artifact
derivation take pre-fetched rows as arguments (caller in `store`/`extension`
does the fetch) rather than a `Store` handle — not attempted here since
nothing currently depends on `model` being callable without a database.

There is no enforcing test for this (unlike `diagnostics/nonInterference.test.ts`
for the reporting boundary); the invariant is style, not a build gate.
