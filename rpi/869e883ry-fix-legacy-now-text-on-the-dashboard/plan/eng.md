# eng.md — legacy Now text on the dashboard

**Ticket**: `869e883ry` · Docs: [pm.md](./pm.md) · [ux.md](./ux.md) · [research](../research/RESEARCH.md)

## Current architecture (confirmed by code read)

- `StageOp`/`StageInside`/`inside()` — `src/model/inside/types.ts` — the shared shape. `ops.length === 0` → view falls back to `blurb` (`STAGE_BLURBS`).
- One renderer for every stage: `renderInside()` — `src/ui/dashboard/webview.html:566-592`.
- `buildStageInside()` — `src/model/inside/index.ts:151-158` — dispatches per stage via `stripFor`.
- Gate stages (`reviewInside`/`uatInside`, `src/model/inside/gates.ts`) already have a static process catalog: `REVIEW_GATES`/`UAT_GATE` (`src/workflow/gates/scripts.ts`). `gateOp()` (`gates.ts:45-51`) synthesizes a `pending` row for a spec with no recorded run — but **only when `stageRunning`** — so a not-yet-started review/uat still falls to blurb.
- `shipInside()` (`index.ts:87-124`) builds `pr`/`merge` ops only from persisted evidence (`prs`, `mergeChecks` tables) — correct once ship has finished, empty (→ blurb) both before AND during a run, because nothing is persisted until a PR row is written.
- Ship's actual live progress is a **second, parallel channel** that never touches `StageInside`:
  `ship.ts` `onProgress(label: string)` (lines 144, 155, 172, 175, 200) → `extension.ts:739` → `panel.ts postShipProgress()` (139-148) → webview `ship-progress` message → `renderShipProgress()` (`webview.html:619-622`) overwrites `#now`, not `#inside`.
- No static step catalog exists for ship (unlike gates' `GateSpec`) — steps are inline strings inside `onProgress` calls.

## Design

### 1. Gate stages: pending rows before the stage starts

Change the gate condition in `gates.ts` from "show pending only while running" to "show pending while running OR not yet started":

```ts
// gates.ts
function gateOp(spec: GateSpec, run: GateRun | undefined, showPending: boolean): StageOp | null {
  if (!run) return showPending ? { status: 'pending', ... } : null;
  ...
}
```
Call sites (`reviewInside`, `uatInside`) pass `cell.status === 'running' || cell.status === 'pending'` instead of just `cell.status === 'running'`.

**Careful bit**: `reviewInside`'s trailing `diff` row currently keys off `ops.length > 0 || running` to decide whether to push a `pass`/`note` diff row — with pending gates now populating `ops`, that condition would fire the `pass` "opened for review" row on a stage that hasn't even started. Fix: gate the diff row push on `running` (note) or a genuine `finished` flag (`status === 'passed' || 'failed'`) — never on `ops.length` alone — and add no diff row at all in the plain-pending case.

### 2. Ship: a pre-run predefined-process view (no live data required)

When `cell.status === 'pending'` and there is no evidence yet, `shipInside` should not fall through to blurb. It already receives `selectedRepos`/`worktrees`-derived data via `StageInsideInput`; synthesize one `pending` `pr` row and one `pending` `merge` row per hot repo — the same two op *names* the finished state already uses, just empty/pending, so the shape a user learns while it's running is the same one they see once it's done. This needs no new step catalog and no data the model layer doesn't already have.

### 3. Ship: structured live progress (the actual bug)

Replace the free-text `ShipProgress` callback with a structured event and move its destination from `#now` to `#inside`.

**Model** (`src/workflow/stages/ship.ts`):
```ts
export type ShipStep = 'commit' | 'push' | 'describe' | 'pr' | 'merge';
export interface ShipStepEvent {
  repo: string;
  step: ShipStep;
  status: 'run' | 'pass' | 'note';   // 'note' = adopted an existing PR, step not re-run
  detail?: string;
}
export type ShipProgress = (event: ShipStepEvent) => void;
```
Bracket each existing await with a `run` event before and a `pass` event after, replacing the single pre-await string call:
- `commitAllIfDirty` → `{repo, step:'commit', status:'run'}` / `'pass'`
- `pushBranch` → `{repo, step:'push', status:'run'}` / `'pass'`
- `describePr` (only when `adapter` present) → `{repo, step:'describe', ...}`
- `findOpenPr`/`openPr` → `{repo, step:'pr', ...}`
- inside `recordMergeChecks`'s existing per-worktree loop → `{repo, step:'merge', status:'run'}` before `checkMergeable`, then a terminal status derived via the existing `mergeOpStatus()` (`model/mergeCheckView.ts`) so the live row and the final persisted row never disagree.
- The `if (prior) { …; continue; }` idempotent-skip branch (line 140) currently emits nothing — add one `note`-status event per skipped step (or a single combined `{repo, step:'pr', status:'note', detail:'existing PR adopted'}`) so the live view never implies a step ran when it didn't. This preserves the codebase's existing evidence-vs-guess discipline (`note` is already reserved for exactly this).
- `tag()` (the `" (repo)"` suffix helper, only used because labels were free text) is deleted — the event always carries `repo` explicitly.

**Wire**: `panel.ts postShipProgress(ticketId, event: ShipStepEvent)` posts `{ type: 'ship-progress', event }` (replacing `label`). `extension.ts:739`'s wiring changes from `(label) => dashboard.postShipProgress(ticketId, label)` to `(event) => dashboard.postShipProgress(ticketId, event)`.

**Webview** (`webview.html`):
- On the "Confirm ship" click (line 814-819), instead of setting `shipLabel`, seed a local `shipOps: Map<string /*repo*/, Map<ShipStep, {status, detail}>>` with every hot repo × every step at `pending` (repo list read from `state.worktrees` — already in `DashboardState`), preserving the existing "click registers before host round trip" guarantee.
- On each incoming `{type:'ship-progress', event}` message, update `shipOps` and re-render — this replaces the `ship-progress` handler at lines 828-835.
- In `render()`, when `shipping` is true, build a `StageInside`-shaped object for `sel === 'ship'` whose `ops` array is flattened from `shipOps` (in step order: commit, push, describe, pr, merge, repeated per repo) and pass that to `renderInside` instead of `state.inside.ship`. Everywhere else (`sel !== 'ship'`, or ship finished) `renderInside` reads `state.inside` exactly as today — unchanged.
- Delete `renderShipProgress()` and its call in `renderNow()` (lines 619-622, 625). The Now line always renders `now.text` from the host-built `NowLine` (see below) once ship is no longer hijacking `#now`.
- Keep `shipping`/`shipDone`/`resolveShipping()` — same lifecycle guard, just re-pointed at feeding `#inside` instead of `#now`. `shipDone`'s "✓ Shipped" flash stays on the Now line (that part isn't legacy free-form process text, it's a settled-state confirmation — out of scope to touch).

### 4. Now line: a real "shipping" sentence

`src/model/nowLine.ts`'s `ship` case currently returns the same "ready to ship" text regardless of `cell.status`, relying entirely on the webview's hijack to mask it while running. Add a `cell.status === 'running'` branch:
```ts
case 'ship':
  if (cell.status === 'running') return { text: 'Now: shipping — committing, pushing, and opening PRs for each hot repo.' };
  ...
```
No action/button on this line while running (the confirm click already happened; nothing to click).

## Data/type changes

- `ShipProgress` signature change (string → `ShipStepEvent`) — ripples to `ship.ts`, `extension.ts:739`, `panel.ts:postShipProgress`, and every test that constructs a fake `onProgress`.
- `panel.ts` message type: `{ type: 'ship-progress', label: string }` → `{ type: 'ship-progress', event: ShipStepEvent }`. No `DashboardState` shape change — this stays outside the store-derived state, same as today.
- No schema/DB change. No new persisted table — the live per-step view stays exactly as durable as today's `ship-progress` message (gone on reload), which is acceptable per pm.md (explicitly deferred).

## Testing strategy

- `src/model/inside/gates.test.ts`: pending-before-running rows for review/uat; diff-row regression guard (no `pass` diff row on a pending stage).
- `src/model/inside/index.test.ts`: ship pre-run pending pr/merge rows per repo.
- `src/workflow/stages/ship.test.ts`: update fake `onProgress` signature across existing tests; new assertions for `run`→`pass` pairs per step, the `note` events on the idempotent-skip path, and merge-step events matching final `mergeOpStatus`.
- `src/model/nowLine.test.ts`: new running-ship case.
- Webview logic (`shipOps` seeding/merge, `renderInside` overlay) is plain functions inside `<script>` — no existing test harness reaches into `webview.html`'s script today (grep confirms no `webview.html`-targeting test file). Extract the pure merge/flatten function (state in, ops array out) so it CAN be unit tested without a DOM, per the file's existing "hand-duplicated types" convention — do not leave it untested purely because the file is HTML.

## Risks (carried from research, refined)

- Signature change touches every `ship.test.ts` fake — mechanical but not small (many call sites).
- `resolveShipping()`'s failed/success branching must keep working once it's feeding `#inside` instead of `#now` — same host-truth-keyed logic, different render target.
- Ship's `note`-status idempotent-skip events must not be mistaken for `pass` by anyone scanning for "did this repo actually get pushed" — reuses the existing `note` semantics precisely so this stays true.
