# Plan — pending gate names + live ship header

Two independent tasks. **Task A and Task B do not touch the same files.** Do A
completely, run the gate, commit. Then do B.

## Ground rules (read before writing any code)

1. **Never invent a fact.** Every value shown must come from something karst
   recorded or resolved. If you cannot find a real source for a cell, leave the
   cell out and say so in your report. An absent fact must read as absent —
   never as `0`, never as `—`, never as a guess.
2. **TDD.** Write the test first. Run it. Watch it FAIL. Then write the code.
   Then watch it pass. A test that passes the first time you run it is testing
   nothing; delete it and write a real one.
3. **Run the suite with `npm test`.** Never `npx vitest` — it fails with a
   `NODE_MODULE_VERSION` error because the native SQLite addon is built for the
   wrong runtime. `npm test` rebuilds it first. Also run `npm run typecheck`.
4. **All wording lives in TypeScript, never in `webview.html`.** The webview
   renders strings the host gives it. If you find yourself typing an English
   sentence inside `webview.html`, you are in the wrong file.
5. **Every value interpolated into HTML goes through `esc(...)`.** No
   exceptions.
6. Do not reformat, re-indent, or "tidy" any code you were not asked to change.
   Keep the diff small.

---

# TASK A — show the gate names before the stage runs

## What is wrong today

Open a ticket that has finished `scope` but has not run `uat`. The Inside block
shows one row:

```
Gates      resolved per repository when the stage runs
```

That row is empty until the stage runs. But karst ALREADY knows which gates
would run — it resolves them for the Settings toggles. We want those names shown
as pending rows, so the row reads:

```
Gates      resolved per repository when the stage runs
  lint       will run when the stage runs      ○
  test       will run when the stage runs      ○
  typecheck  disabled for this ticket          ⊘
```

## Where the names already come from

`src/ui/dashboard/gateOptions.ts` exports `buildGateOptionsLoader`. It returns
an async function that produces:

```ts
interface GateOption { name: string; disabled: boolean }
interface GateOptions { uat: GateOption[]; review: GateOption[] }
```

`src/ui/dashboard/panel.ts`, method `pushGateOptions` (around line 404), calls
that loader and posts `{ type: 'gate-options', options }` to the webview. The
webview uses it for the Settings-style gate toggle list, and for nothing else.

**Do not write a second resolver.** Reuse this one.

## Step A1 — the reducer takes the resolved names (test first)

File: `src/model/inside/gates.ts`

`QualityProcessesInput` is the input type for `uatProcesses` / `reviewProcesses`.
Add ONE optional field to it:

```ts
  /**
   * The gate names this stage WOULD run, resolved host-side
   * (`ui/dashboard/gateOptions.ts`) before anything has run. Optional: a panel
   * that has not resolved them yet passes nothing, and the row falls back to
   * stating that they resolve when the stage runs.
   */
  resolvedGates?: readonly { name: string; disabled: boolean }[];
```

`gatesProcess(...)` is the function that builds the row (around line 265). It
takes `cell, runs, stageKey, now`. Add a fifth parameter
`resolved: readonly { name: string; disabled: boolean }[] = []`.

Inside it, there is a block that computes `boundedRows` from `batch`. Directly
after it, add this rule:

- **If `batch.length > 0`, change nothing.** Recorded rows always win. A
  recorded gate is a fact; a resolved name is a prediction.
- **If `batch.length === 0` AND the stage has not finished** (there is already a
  `const finished = ...` in this function) **AND `resolved.length > 0`**, then
  the evidence rows become one row per resolved name:

```ts
      rows = resolved.map((g) => ({
        status: g.disabled ? 'skip' : 'pending',
        label: g.name,
        detail: g.disabled ? 'disabled for this ticket' : 'will run when the stage runs',
      }));
```

Bound that list with the existing `bounded(...)` helper and
`GATES_EVIDENCE_LIMIT`, exactly the way the recorded path does, including the
`+N more` note row. Copy that pattern; do not invent a second one.

Also: when this fallback produced rows, the row's `detail` should say the names
are a forecast, not a record. Change the existing pending detail string
`'resolved per repository when the stage runs'` to
`'not run yet — these gates would run'` ONLY in that case. Leave the other two
branches (`finished`, and running-with-nothing-recorded) exactly as they are.

**Do not touch `passed`/`failed`/`skipped` counts or the `aggregate`.** A gate
that has not run has no outcome; counting a forecast as a skip would make the
aggregate lie.

Now pass the new field through:

```ts
gatesProcess(input.cell, input.gateRuns, 'uat',   input.now, input.resolvedGates ?? [])
gatesProcess(input.cell, input.gateRuns, 'review', input.now, input.resolvedGates ?? [])
```

in `uatProcesses` and `reviewProcesses` respectively.

### Tests for A1 — write these BEFORE the code above

File: `src/model/inside/gates.test.ts`. Four tests:

1. `'lists the resolved gate names as pending rows before the stage runs'` —
   cell status `pending`, no gate runs, `resolvedGates: [{name:'lint',disabled:false}]`.
   Expect one evidence row with `status: 'pending'`, `label: 'lint'`.
2. `'marks a user-disabled gate as skipped, never as pending'` — same, with
   `disabled: true`. Expect `status: 'skip'` and the disabled detail.
3. `'never lets a forecast outrank a recorded run'` — supply BOTH a recorded
   `gateRuns` batch and `resolvedGates`. Expect the rows to be the recorded ones
   and `resolvedGates` to appear nowhere.
4. `'counts no outcome for a gate that has not run'` — pending + `resolvedGates`
   of length 3. Expect `evidence.passed === 0 && failed === 0 && skipped === 0`
   and `process.aggregate` to be `undefined`.

## Step A2 — the panel remembers the resolved names and re-renders

File: `src/ui/dashboard/panel.ts`

Today `pushGateOptions` posts the options and forgets them. Make it remember:

1. Add a private field beside the other per-ticket maps (they are near
   `gateControllers` / `gateRequests`):
   `private readonly gateOptionsCache = new Map<number, GateOptions>();`
2. In the success callback of `pushGateOptions`, BEFORE `panel.postMessage`, add
   `this.gateOptionsCache.set(ticketId, options);` and AFTER it, call
   `this.pushState(ticketId);` — the snapshot must be rebuilt, or the names sit
   in the cache and never reach a row.
3. Wherever a ticket's panel is disposed/removed (search for
   `this.panels.delete(`), also `this.gateOptionsCache.delete(ticketId)`. A
   stale cache entry for a closed panel is a leak.

Then find where `buildDashboardState(...)` is called (in this same file) and
pass the cached options through, e.g. `resolvedGates: this.gateOptionsCache.get(ticketId)`.

File: `src/ui/dashboard/state.ts`

`buildDashboardState` takes an options/deps object. Add ONE optional field to
that input type:

```ts
  /** Resolved gate names per stage, from `gateOptions.ts`. Absent → no forecast. */
  resolvedGates?: { uat: readonly { name: string; disabled: boolean }[];
                    review: readonly { name: string; disabled: boolean }[] };
```

At line ~372 the `uatProcesses({ ... })` call is built, and at ~390
`reviewProcesses({ ... })`. Add to each:

```ts
      resolvedGates: input.resolvedGates?.uat ?? [],     // uat call
      resolvedGates: input.resolvedGates?.review ?? [],  // review call
```

(use the actual name of the parameter object in that function — read the
surrounding lines and match it).

### Test for A2

File: `src/ui/dashboard/state.test.ts`. One test: build a state for a ticket
whose `uat` cell is pending, passing `resolvedGates: { uat: [{name:'test',
disabled:false}], review: [] }`. Assert the `uat` inside view's `gates` process
carries an evidence row labelled `test`. This proves the wiring, which the
reducer test cannot.

## Step A3 — nothing to do in the webview

The webview already renders `evidence.rows` for a `gates` evidence. Confirm by
reading `evidenceGatesHtml` in `src/ui/dashboard/webview.html`. **If it renders
without changes, change nothing.** Resist the urge to "improve" it.

## Definition of done for Task A

- `npm test` green, `npm run typecheck` clean.
- The four reducer tests and the one state test exist and failed before the code
  was written.
- Commit message: `feat(dashboard): forecast the resolved gate names before a gate stage runs`

---

# TASK B — the live ship header names the step, not just "Shipping"

## What is wrong today

While a ship runs, the Inside header says:

```
Inside ship   RUNNING · Shipping
```

The design says:

```
Inside ship   RUNNING · PR · api · updating description · #412 · 6.2s
```

Ship already emits a structured event for every step. Nothing turns those into
header events.

## What already exists (read these before writing anything)

- `src/workflow/stages/ship.ts` line ~752:
  ```ts
  export type ShipStep = 'commit' | 'push' | 'describe' | 'pr' | 'merge';
  export interface ShipStepEvent { repo: string; step: ShipStep;
                                   status: 'run' | 'pass' | 'fail' | 'note'; detail?: string }
  export type ShipProgress = (event: ShipStepEvent) => void;
  ```
- `shipTicket(...)` (line ~773) already takes `onProgress: ShipProgress` as its
  **6th positional parameter** and emits these events throughout.
- `src/model/inside/progress.ts` owns the live-header event type:
  ```ts
  interface LiveOperationView { status: 'run' | 'wait' | 'fail';
                                label?: string; detail?: string; duration?: string }
  ```
  and already exports `shipStartedEvent` / `shipFinishedEvent` /
  `shipClearedEvent` as the pattern to copy.
- `src/extension.ts` line ~3907 calls `runShipTicket(store, {...}, undefined,
  undefined, undefined, undefined, onInsideProgress)`. The **6th `undefined` is
  the `onProgress` slot** — that is where your mapper goes.

## Step B1 — a pure mapper (test first)

File: `src/model/inside/progress.ts`. Add ONE exported function:

```ts
/**
 * One ship STEP as a live header event.
 *
 * A step that is running (or that just failed) is what the header should name;
 * a `pass`/`note` step is not an operation in flight, so it produces nothing
 * and the next `run` event replaces the header. Ship's own
 * `shipClearedEvent` retires the header when the invocation ends.
 */
export function shipStepEvent(
  ticketId: number,
  event: { repo: string; step: 'commit' | 'push' | 'describe' | 'pr' | 'merge';
           status: 'run' | 'pass' | 'fail' | 'note'; detail?: string },
): InsideProgressEvent | null
```

Rules — implement EXACTLY this, no extra cleverness:

- `status === 'pass'` or `'note'` → return `null`.
- otherwise return `{ kind: 'active', ticketId, stage: 'ship', processId: 'ship',
  live: { status: event.status === 'fail' ? 'fail' : 'run', label, detail } }`.
- `label` is `` `${STEP_LABEL[event.step]} · ${event.repo}` `` where
  `STEP_LABEL` is a module-level constant in this file:
  ```ts
  const STEP_LABEL = { commit: 'Commit', push: 'Push', describe: 'PR',
                       pr: 'PR', merge: 'Merge' } as const;
  ```
  (`describe` and `pr` are both the PR step — that is the design's wording, not
  a mistake.)
- `detail` is `event.detail` when present, else `STEP_DETAIL[event.step]` for a
  running step:
  ```ts
  const STEP_DETAIL = { commit: 'committing the worktree', push: 'pushing the branch',
                        describe: 'updating description', pr: 'opening the pull request',
                        merge: 'checking mergeability' } as const;
  ```
  For a failed step with no `event.detail`, use `` `${STEP_DETAIL[event.step]} failed` ``.
- **Cap `detail` at 200 characters** (`detail.slice(0, 200)`). `event.detail`
  can contain CLI or model prose. The wire validator in this same file rejects
  anything over 240 and the whole event would be silently dropped.
- Never put a URL, a file path, or a PR number you invented in there. `#412` in
  the design comes from `event.detail` when ship recorded one; if ship did not
  record it, it is not shown.

### Tests for B1 — write first

File: `src/model/inside/progress.test.ts`. Five tests:

1. running `describe` on repo `api` → label `PR · api`, detail
   `updating description`, live status `run`.
2. `status: 'pass'` → returns `null`.
3. `status: 'note'` → returns `null`.
4. `status: 'fail'` with no detail → live status `fail`, detail ends with
   `failed`.
5. a 5000-character `event.detail` → the produced event still passes
   `validateInsideProgressEvent(...)` (import it from this same file and call
   it on your own output). This is the test that proves the cap matters.

## Step B2 — one line in the host

File: `src/extension.ts`, the `runShipTicket(` call at ~3907.

Replace the **6th** argument (currently `undefined`) with:

```ts
        (step) => {
          const event = shipStepEvent(ticketId, step);
          if (event) onInsideProgress(event);
        },
```

Import `shipStepEvent` from `./model/inside/progress.js` — there is already an
import from that module on line ~211; add the name to it, do not add a second
import statement.

**Count the arguments.** The signature is
`(store, opts, gh, adapter, git, onProgress, onInsideProgress)`. If you put the
mapper in the wrong slot, TypeScript will tell you; believe it.

There is a second `shipTicket` call site in `src/workflow/` (search for it). Do
NOT change that one unless it already has an `onInsideProgress`; ship's
background/auto path is out of scope for this task.

## Step B3 — nothing to do in the webview

The header already renders `live.label`, `live.detail` and `live.duration` (see
`renderInside` in `src/ui/dashboard/webview.html`, around line 1990). Read it and
confirm. Change nothing.

## Known gap — REPORT IT, do not fake it

The design's header also shows the agent identity (`OpenCode · DeepSeek V4
Flash`) and an elapsed time (`6.2s`). `LiveOperationView` has a `duration`
field but ship's step events carry no start time, and there is no identity
field at all. **Do not add a fake duration and do not guess an identity.** Leave
both out and write one line in your final report saying the two facts have no
source on this path.

## Definition of done for Task B

- `npm test` green, `npm run typecheck` clean.
- The five mapper tests exist and failed before the mapper was written.
- Commit message: `feat(dashboard): name the running ship step in the live header`

---

# Final report you must produce

Three short sections, no prose padding:

1. What you changed, file by file.
2. The exact `npm test` summary line and the `npm run typecheck` result.
3. Anything you could not feed from a recorded fact, and which fact was missing.

If you got stuck, say where you got stuck and what you tried. Do not silently
skip a step, and do not "simplify" a step by removing its test.
