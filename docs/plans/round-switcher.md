# Plan — Option B: the round switcher (IMPROVE-ROUNDS-UI)

## Problem

A UAT/Review failure opens a `recovery_rounds` row and calls the Fix agent; a ticket can
spend up to `max_rounds` of them. Every round's evidence is durably recorded, but the
Inside panel collapses it:

- `model/inside/gates.ts` → `latestBatch(runs, stageKey)` keeps only the greatest-`runAt`
  `gate_runs` batch.
- `latestFindingsBatch(findings)` keeps only the newest review findings batch.
- `latestProcessRun(processRuns, id)` keeps only the newest Tester/Review run, and the
  Tester's observations are filtered to that run.

So round 1's failing gates, round 2's findings, and which of them the fix actually cleared
are invisible. The Fix row (`model/inside/recovery.ts`) lists the rounds, but each row
carries a one-line trigger string only.

## Shape of the change

Make "latest" a **default selection** instead of a hard-coded read. A gate stage gains an
ordered list of **attempts**; selecting one re-derives that stage's whole process list —
Gates, Tester/Review — from that attempt's recorded rows. The Fix row is unaffected: it is
whole-history by design and stays that way.

**No schema change.** Everything is a read over rows already written.

### Attempt identity

The canonical key of an attempt is its **stage run id**:

- `gate_runs.stageRunId` (v25, nullable on legacy rows) + `runAt` as the batch stamp.
- `process_runs.stageRunId` — maps the Tester/Review run to its attempt.
- `review_findings.processRunId` / `uat_findings.processRunId` — map findings to a run,
  and through it to an attempt.
- `recovery_rounds.sourceStageRunId` — the attempt that FAILED and opened round N.
  `uatRevalidationStageRunId` / `reviewRevalidationStageRunId` — the attempts that
  revalidated it.

Key rule: `stageRunId !== null ? \`sr:${stageRunId}\` : \`ra:${runAt}\``. Legacy rows with
no stage run id still group by their batch stamp and are never dropped.

### Tab labelling

- An attempt whose key matches a round's `sourceStageRunId` → label `R{round.round}`
  (that attempt is the failure that opened the round).
- The newest attempt, when it is not already labelled → `latest` (or `live` while the
  stage is running).
- Any other attempt → `attempt {k}` by 1-based ordinal among the stage's own attempts.
- Oldest → newest, bounded to the most recent `ATTEMPT_TABS_LIMIT = 8`.
- A stage with 0 or 1 attempt emits **no** tabs — the control costs nothing on a ticket
  that never looped.

### Selection state

Host-held, like every other panel read. The webview posts a selection; the panel stores it
per `(ticketId, stage)` in memory and re-renders. On every new snapshot: keep the selection
if its key still exists, otherwise fall back to latest. Ticket change clears it. The panel
stays a pure read — selection never mutates the store.

## Rules that bind this work

Read before touching:

- `docs/ui/UI-RULES.md` (v3.0) — every UI change is judged against it; cite the rule id in
  the commit when a change exists to satisfy one (UI-R35).
- `docs/ui/UI-INVARIANTS.md`, `docs/ui/DESIGN-SYSTEM.md`, `docs/ui/STYLE-GUIDE.md`.
- `docs/arch/stages-and-gates.md` — append-only gate evidence.

Non-negotiable:

- **Strict TDD**: RED → GREEN, per task. Tests colocated (`x.test.ts` beside `x.ts`).
- The webview renders host-authored strings **verbatim** and derives no business copy
  (UI-R31). Every label, detail and status word on a tab is computed host-side.
- Status is never colour-only — a tab carries a glyph/word as well as a hue.
- `vscode` is not a runtime dep; model/ and ui/dashboard state stay host-agnostic.
- Files small (<400 lines typical). Immutable data — build new arrays, never mutate input.
- Bound every list before it is rendered (`model/inside/bounds.ts` → `bounded()`).

## Tasks

### T1 — `src/model/inside/rounds.ts` (new, pure)

Exports:

```ts
export const ATTEMPT_TABS_LIMIT = 8;
export type AttemptKey = string;

/** The canonical key of a recorded row's attempt. */
export function attemptKey(stageRunId: number | null | undefined, runAt: string): AttemptKey;

export interface GateAttemptView {
  key: AttemptKey;
  /** Host-authored tab copy: `R2`, `latest`, `live`, `attempt 3`. */
  label: string;
  status: InsideStatus;          // from model/inside/types.js
  /** Visible status word, so colour is never the only carrier. */
  statusLabel: string;
  /** `formatTime` of the attempt's earliest recorded start, when it has one. */
  time?: string;
  /** The round this attempt opened, when it opened one. */
  round?: number;
  /** True for the newest attempt — the default selection. */
  latest: boolean;
}

export function listGateAttempts(input: {
  gateRuns: readonly GateRun[];
  processRuns: readonly ProcessRun[];
  rounds: readonly RecoveryRound[];
  stageKey: StageKey;            // 'uat' | 'review'
  running: boolean;              // the stage is running now
}): GateAttemptView[];

export function batchForAttempt(runs: readonly GateRun[], stageKey: StageKey, key: AttemptKey | null): GateRun[];
export function processRunForAttempt(runs: readonly ProcessRun[], processId: string, key: AttemptKey | null): ProcessRun | undefined;
```

Rules:
- `key === null` → the existing latest behaviour, byte-for-byte. This is what keeps every
  un-looped ticket unchanged.
- Ordering by greatest `runAt` / greatest run id exactly as the current code documents —
  never by array position.
- An attempt whose key no attempt holds → return empty/undefined, never throw.

Tests (`rounds.test.ts`): key derivation incl. legacy null stage run id; ordering; round
labelling from `sourceStageRunId`; `latest`/`live` labels; the 8-tab bound keeps the
NEWEST 8; a single-attempt stage yields ≤1 tab; unknown key degrades.

### T2 — `src/ui/dashboard/messages.ts`

Inbound message + parse:

```ts
| { type: 'select-gate-attempt'; stage: GateStage; key: string }
```

Validation at the boundary: `stage` must be `uat` or `review`; `key` a non-empty string
bounded to 64 chars; anything else → `null` (the file's existing reject contract). Add
tests to `messages.test.ts` covering accept + each reject.

### T3 — `src/model/inside/gates.ts` + `types.ts`

- `QualityProcessesInput` gains `selectedAttempt?: AttemptKey | null`.
- `gatesProcess`, `testerProcess`, `reviewProcess` resolve their rows through T1's
  selectors instead of `latestBatch` / `latestFindingsBatch` / `latestProcessRun`.
  Keep `latestBatch` exported — it stays the `key === null` path and other callers/tests
  use it.
- **A historical attempt is settled.** When the selection is not the latest attempt, the
  forecast branch (resolved gates), the "so far" copy and the running spinner must not
  apply: a past attempt cannot be running. Derive a `settled` flag and branch on it.
- `InsideStageView` (in `types.ts`) gains:
  ```ts
  attempts?: readonly GateAttemptView[];
  selectedAttempt?: AttemptKey;
  /** Host-authored banner shown when a past attempt is selected. */
  attemptNote?: string;   // e.g. "viewing round 2 — not the current result"
  ```
- The Fix row is untouched: `recoveryProcess` keeps reading every round.

Tests in `gates.test.ts`: selecting an older attempt renders that batch's gates, counts and
failure sentence; the Tester's observations follow the selected run; review findings follow
the selected batch; a settled historical attempt never renders a spinner or a forecast;
`selectedAttempt: null` output is identical to today's.

### T4 — `src/ui/dashboard/state.ts`

- `BuildDashboardStateInput` gains an optional selection map
  (`attemptSelection?: Partial<Record<'uat' | 'review', string>>`).
- For each gate stage: build attempts (T1), resolve the effective selection (requested key
  if it exists, else latest), pass it into `uatProcesses`/`reviewProcesses`, and put
  `attempts` / `selectedAttempt` / `attemptNote` on the stage view.
- Zero behaviour change when no selection is supplied.

Tests in `state.test.ts` over an in-memory store (`openStore(':memory:')`) with a seeded
two-round history.

### T5 — `src/ui/dashboard/panel.ts`

- Hold `Map<GateStage, AttemptKey>` per open ticket; clear on ticket change.
- Handle `select-gate-attempt`: record and re-render.
- Drop a selection whose key is gone from the new snapshot (fall back to latest).
- `logger.debug` is not available here directly — follow the file's existing debug seam if
  it has one; otherwise no new logging.

Tests in `panel.test.ts` with the existing fakes: selection survives a snapshot that still
holds the key, falls back when it does not, resets across tickets.

### T6 — `src/ui/dashboard/webview.html` (+ `webview.test.ts`)

- Render the tabs in the `.inside-head` row of the stage block (they scope Gates AND the
  Tester/Review process, so they belong to the stage header, not to one process row).
- `role="tablist"` / `role="tab"` / `aria-selected`; left–right arrow keys move selection;
  visible `:focus-visible` state; `prefers-reduced-motion` respected.
- Each tab: host-authored label + status glyph. Never colour alone.
- Selecting posts `{ type: 'select-gate-attempt', stage, key }` through the existing
  `data-act` dispatch path.
- When `attemptNote` is present, render it as a banner above the ledger, verbatim.
- No tabs element at all when `attempts` is absent or shorter than 2.

Tests in `webview.test.ts` follow the file's existing VM-render pattern.

### T7 — verification

`npm run typecheck` && `npm run test:unit`, plus `docs/ui/UI-RULES.md` conformance
(`src/ui/conformance.test.ts`). Fix what fails. No new file over ~400 lines.

## Out of scope

Option C (the recovery lane) and Option D (the round delta). T1's selectors are the input
D will need — do not build D's diff here.
