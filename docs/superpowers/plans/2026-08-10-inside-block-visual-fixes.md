# Execution Plan: Inside-block visual and factual fixes (round 3)

## Goal

Ten reported defects in the Inside block are closed:

1. Every ledger row (Gates / Fix / Services / Tester) has real left inset — the glyph no longer touches the block border, and the rows align with the `Inside <stage>` header.
2. The Fix process shows its AI identity (`AI` mark + agent · core · model) exactly like every other AI process, including the configured-identity fallback and the §11 absence copy.
3. A recovery round row ends in a status GLYPH, never the word `running`.
4. The recovery history block is no longer amber. Amber (`--p-attention`) stays reserved for needs-you states.
5. The Gates process row states `n/m` beside its outcome words.
6. An expanded Gates body renders the recorded repository in its own column and gives the gate name a readable width.
7. Nothing in a row tail collides: the duration, the glyph, the count pill and the chevron each keep a gap, and every rendered duration carries the exact millisecond span as its `title`.
8. The impl timeline's `started` row no longer reads as pending grey.
9. Every process whose start karst actually recorded shows the clock time it started.
10. The `Inside <stage>` header states the stage's current operation from the SNAPSHOT, not only from the ephemeral live-progress event — so a reopened panel is not blank.

## Current State

Facts established by reading the code (file:line as of this branch):

- `src/ui/dashboard/webview.html:585-587` — `#inside .op summary,#inside .op-static` has `padding:0 var(--p-s1)`. `--p-s1` = `--k-space-2` = **4px** (`src/model/designTokens.ts:97`), while `#inside .inside-head` (line 541) pads `0 var(--p-s4)` = **10px**. That 6px difference is the reported missing left margin, and it applies to every stage view because every process row uses this one rule.
- `src/ui/dashboard/webview.html:669` — `.gate-row` declares **four** grid columns (`repo, name, detail, state`) but `evidenceGatesHtml` (line 1728-1734) emits only **three** children. The gate name therefore lands in the 74–90px repo column. The ≤430px block (line 875-876) already declares the intended 3-column narrow variant with `gate-state` at column 3, which confirms the wide grid was designed with a repo cell that was never rendered.
- `GateRun.repo` exists and is recorded (`src/store/gateRuns.ts:26`, written from `entry.identity.repo` in `src/workflow/stages/uat.ts:262` and `review.ts`). It is `null` on pre-v21 rows and on the `changes` row. `EvidenceRow` has no field to carry it (`src/model/inside/types.ts:225-265`).
- `gatesProcess` (`src/model/inside/gates.ts:327-336`) builds `aggregate` from `passed`/`failed`/`skipped` only — no total, which is the missing `n/m`.
- `evidenceRecoveryHtml` (`webview.html:1825-1831`) renders `esc(r.duration || statusWord(r.status))` — a recovery round has no duration, so every row prints the WORD (`running`).
- `.recovery-history` (`webview.html:766-767`) uses `--p-edge-wait` / `--p-tint-wait`, and `.recovery-pill` (762-764) uses `--p-edge-wait` / `--p-attention` — the reported yellow.
- `recoveryProcess` (`src/model/inside/recovery.ts:147-149`) sets `execution` ONLY when `fixRun?.provider` exists. It has no `configured` input and no `identityNote`, so a Fix whose round carries no `fixProcessRunId` (or a run with no recorded provider) shows no identity and no `AI` mark — `processRowHtml` gates the mark on `p.execution || p.configuredExecution` (`webview.html:1903`).
- `executionView` (`src/model/inside/agent.ts:100-107`) never populates `AgentExecutionView.agentName`, although `ProcessRun.agentName` is a recorded identity snapshot (`src/store/processRuns.ts:35`) and `agentIdHtml` already renders it (`webview.html:1673-1674`).
- **No `effort` / reasoning-effort value is recorded anywhere in `src/`** (verified: `grep -rn "effort" src/` returns nothing). See Scope.
- `.ev-state` gets `gap:var(--p-s2)` (`webview.html:662`) but `.gate-state` does not, and `.recovery-result` is a bare text span — hence the duration/glyph collision inside gate bodies.
- `#inside .op summary` uses `gap:var(--p-s1)` (4px) between the tail and the 16px `.chev` cell — the reported `5.5s ›` collision.
- No view field carries an exact duration; `formatDuration` (`types.ts:67-79`) rounds to one decimal under a minute and to whole seconds above it.
- `timelineEvents` (`agent.ts:167-179`) emits the run-start row with `status:'note'`, `role:'identity'`. The webview draws it as `.timeline-start` whose label is `--p-muted2` and whose node is a `--p-muted2` ring (`webview.html:725-729`) — visually identical to a pending row, whatever the run's outcome.
- `InsideProcessView` has `duration` but no start-time field (`types.ts:421-469`).
- `InsideStageView` has no live/current-operation field (`types.ts:476-487`). `renderInside` (`webview.html:1995-2003`) builds the header's live line ONLY from `liveOps[view.stageKey]`, an in-memory overlay fed by `InsideProgressEvent`s. A panel opened after those events (or reopened) shows an empty header cell — the reported "current state in Inside stage is not added".
- `stageView` / `doneStageView` (`src/ui/dashboard/state.ts:496-534`) assemble every `InsideStageView`.

## Target State

- Process rows inset to `--p-s4`, aligned with the stage header.
- `EvidenceRow` gains optional `repo` and `durationExact`; `InsideProcessView` gains optional `time` and `durationExact`; `InsideStageView` gains optional `live`. All additive and optional, so an older snapshot renders exactly as it does today.
- `executionView` accepts an optional recorded agent name.
- Fix carries `execution` → `configuredExecution` → `identityNote` in the same §11 order every other AI process uses.
- Gates aggregate reads `1/3 · 1 failed`; gate bodies render `repo | name | detail | state`.
- Recovery rows render a glyph; the recovery containers use neutral tokens.
- Every duration element carries `title` = exact span; every process with a recorded start renders its clock time.
- `InsideStageView.live` is derived host-side from the stage's own processes and used as the header's fallback.

## Scope

### In Scope
- `src/model/inside/types.ts`, `gates.ts`, `recovery.ts`, `agent.ts`, `index.ts`, `ship.ts` and their `.test.ts` files.
- `src/ui/dashboard/state.ts` and `src/ui/dashboard/webview.html` (+ `webview.test.ts`).

### Out of Scope
- **Reasoning effort.** karst records no effort/reasoning-level value anywhere (`grep -rn "effort" src/` → no matches): neither `process_runs`, `implementation_segments`, nor the manifest carries one. Rendering it would require inventing a fact, which the standing constraint forbids. **Report this to the user**: "effort is not shown because karst never records it — adding it means recording it at launch first."
- The `done` receipt hero (it already states its completion time) and any new store column, migration, or `SCHEMA_VERSION` bump — every fix below reads facts already recorded.
- The stage stepper strip above the block, the fault card, and the blocked banner.

## Key Decisions

1. **New view fields are optional and additive.** No existing member becomes required, so `renderFixtures.ts` and every older snapshot keep type-checking and rendering unchanged.
2. **`n/m` counts VERDICTS, not rows.** `n` = `passed + failed` (gates that produced an exit code); `m` = `batch.length` (gates recorded in the latest batch). A skipped or scriptless gate is in `m` and not in `n` — it was recorded but produced no verdict. The forecast path (nothing has run) still emits NO aggregate: a prediction never carries counts.
3. **The repo cell is per-row and optional.** `EvidenceRow.repo` is the recorded `gate_runs.repo`, rendered verbatim and escaped. When NO row in a gates body carries one (pre-v21 rows), the webview adds `no-repo` to the container and drops the column — an empty 90px column is not shown as absence.
4. **Exact duration is a host-formatted string, not a number.** `formatExactDuration` returns `"274.281s"`. The webview renders it only as a `title`.
5. **Process start time is `formatTime` of the SAME timestamp the duration already uses.** No new store read; a process without a recorded start renders nothing (Services keeps no time).
6. **The header's live line prefers the ephemeral event, falls back to `view.live`.** `view.live` is derived purely from the stage's own process rows (first `run`, else first `wait`), so it states nothing the ledger does not already show.
7. **Amber removal is container-level only.** Per-row status glyphs keep the global `wait`→amber vocabulary; only `.recovery-history` and `.recovery-pill` chrome go neutral.
8. **`InsideLiveView` is declared in `types.ts`, not imported from `progress.ts`.** `progress.ts` already imports from `types.ts`; the reverse import would close a module cycle. `LiveOperationView` in `progress.ts` stays untouched and is structurally identical.

## Execution Order

### Task 1: Add the new optional view fields and the exact-duration formatter

#### Objective
Give the reducers somewhere truthful to put a repository, an exact span, a start time and a stage-level live line — with no behavior change yet.

#### Files
- `src/model/inside/types.ts` — the presentation contract.
- `src/model/inside/types.test.ts` — if this file does not exist, create it; add the formatter's cases there.

#### Implementation
1. In `src/model/inside/types.ts`, directly below `formatDuration`, add:
```ts
/**
 * The same span `formatDuration` rounds, stated exactly. Rendered ONLY as a
 * control's `title`: the row keeps the readable form, and a reader who needs
 * the millisecond truth can hover for it. Empty for an absent or unparseable
 * pair, exactly like `formatDuration` — an absent fact must read as absent.
 */
export function formatExactDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string {
  if (!startedAt || !endedAt) return '';
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return `${(ms / 1000).toFixed(3)}s`;
}
```
2. In `interface EvidenceRow`, add two optional fields with these exact doc comments:
```ts
  /**
   * The repository this row's evidence was recorded against — `gate_runs.repo`,
   * verbatim. Absent for a row that names no repository (a pre-v21 gate row,
   * the `changes` evidence row, a non-gate body): the renderer drops the column
   * rather than drawing an empty one, because a blank cell reads as a repo with
   * no name instead of a row that names none.
   */
  repo?: string;
  /**
   * The exact form of `duration`, host-formatted. Rendered only as the
   * duration's `title`. Absent → the readable duration carries no tooltip.
   */
  durationExact?: string;
```
3. In `interface InsideProcessView`, add below `duration`:
```ts
  /**
   * When this process STARTED, as a clock time in the reader's locale —
   * `formatTime` of the same recorded timestamp `duration` is measured from.
   * A process whose start karst never recorded (Services, which runs nothing)
   * carries none; absence is stated by omission, never by a placeholder.
   */
  time?: string;
  /** The exact form of `duration`. Rendered only as the duration's `title`. */
  durationExact?: string;
```
4. Add, immediately above `interface InsideStageView`:
```ts
/**
 * The stage's CURRENT operation as the header states it.
 *
 * Declared here rather than imported from `./progress.js` because `progress.ts`
 * already imports this module — the reverse import would close a cycle. It is
 * structurally identical to `LiveOperationView` on purpose: the header renders
 * the ephemeral progress event and this snapshot-derived fallback through one
 * code path, so a reopened panel is never blank while a stage is working.
 *
 * Every field is derived from a process row already on screen. This states
 * nothing the ledger below it does not.
 */
export interface InsideLiveView {
  status: 'run' | 'wait' | 'fail';
  label?: string;
  detail?: string;
  duration?: string;
}
```
5. In `interface InsideStageView`, add after `clock`:
```ts
  /**
   * The current operation, derived from this stage's own processes. Absent when
   * no process is running or waiting — a settled stage has no live line.
   */
  live?: InsideLiveView;
```

#### Constraints
- Do not modify `LiveOperationView` in `src/model/inside/progress.ts`.
- Do not make any existing field required.
- Do not import from `./progress.js` in `types.ts`.

#### Edge Cases
- `formatExactDuration(null, x)` / `(x, null)` / unparseable stamps / negative span → `''`.
- A zero-length span → `'0.000s'` (a recorded instant is a fact, not an absence).

#### Verification
```bash
npx vitest run src/model/inside/
npm run typecheck
```
Expected: all green; new formatter tests pass.

#### Completion Criteria
- [ ] `formatExactDuration` exported with the four edge cases tested.
- [ ] `EvidenceRow.repo`, `EvidenceRow.durationExact`, `InsideProcessView.time`, `InsideProcessView.durationExact`, `InsideLiveView`, `InsideStageView.live` all present and optional.
- [ ] `npm run typecheck` clean.

---

### Task 2: Gates — `n/m` aggregate, per-row repository, start time, exact duration

#### Objective
Close reported items 5, 6, 7 (host half) and 9 (gates half).

#### Files
- `src/model/inside/gates.ts` — `gateOp`, `gatesProcess`, `aiProcessBase`.
- `src/model/inside/gates.test.ts` — new cases.

#### Implementation
1. Import `formatExactDuration` and `formatTime` from `./types.js` alongside `formatDuration`.
2. Widen `gateOp`'s return: it currently returns `StageOp`. Change its signature to return `StageOp & { repo: string | null; durationExact: string }` and add to BOTH returned objects:
   - skipped branch: `repo: run.repo, durationExact: ''`
   - normal branch: `repo: run.repo, durationExact: formatExactDuration(run.startedAt, run.endedAt)`
3. In `gatesProcess`, in the recorded-rows `map`, replace the returned object with:
```ts
        batch.map((r): EvidenceRow => {
          const op = gateOp(r);
          return {
            status: op.status,
            label: op.name,
            detail: op.detail,
            duration: op.duration,
            ...(op.repo ? { repo: op.repo } : {}),
            ...(op.durationExact ? { durationExact: op.durationExact } : {}),
          };
        }),
```
   The forecast branch is unchanged — a gate that has not run has no repo of record and no duration.
4. Replace the `aggregate` computation with:
```ts
  // The kind-specific aggregate (B5): the WHOLE batch counted, per handoff §6,
  // led by `n/m` — how many of the recorded gates produced a VERDICT. A skipped
  // gate, or one whose script the repo does not define, is in `m` and not in
  // `n`: it was recorded and it answered nothing. A batch with no recorded row
  // is absence, never "0/0".
  const aggregate =
    batch.length === 0
      ? undefined
      : [
          `${passed + failed}/${batch.length}`,
          passed > 0 ? `${passed} passed` : '',
          failed > 0 ? `${failed} failed` : '',
          skipped > 0 ? `${skipped} skipped` : '',
        ]
          .filter(Boolean)
          .join(' · ');
```
5. In the returned process object, replace the duration spread with:
```ts
    ...(firstStart
      ? {
          duration: formatDuration(firstStart, lastEnd),
          durationExact: formatExactDuration(firstStart, lastEnd),
          time: formatTime(firstStart),
        }
      : {}),
```
6. In `aiProcessBase`, replace the duration spread with:
```ts
    ...(run?.startedAt
      ? {
          duration: formatDuration(run.startedAt, run.endedAt ?? now),
          durationExact: formatExactDuration(run.startedAt, run.endedAt ?? now),
          time: formatTime(run.startedAt),
        }
      : {}),
```

#### Constraints
- Do not change which rows enter `batch` (the `CHANGES_GATE` filter stays).
- Do not give the forecast rows a repo, a duration, or an aggregate.
- Do not change `passed`/`failed`/`skipped` counting.
- `evidence.passed/failed/skipped` stay the whole-batch counts.

#### Edge Cases
- `run.repo === null` (pre-v21 row) → no `repo` key on the row.
- Batch of 2 rows both with `exitCode === null` → aggregate `"0/2"` (recorded, answered nothing) — NOT `undefined`, and never "2 passed".
- Batch of 1 skipped row → `"0/1 · 1 skipped"`.
- Batch of 3: 2 pass, 1 fail → `"3/3 · 2 passed · 1 failed"`.
- A gate with no `startedAt` contributes no duration and does not become `firstStart`.

#### Verification
```bash
npx vitest run src/model/inside/gates.test.ts
npm run typecheck
```
Expected: green. New tests must include, by name:
- `'leads the gates aggregate with the verdict count over the batch size'`
- `'counts a skipped gate in the batch total but not in the verdict count'`
- `'omits the aggregate entirely when the batch recorded no row'`
- `'carries each gate row the repository it was recorded against'`
- `'omits repo on a gate row recorded before the repo column existed'`
- `'states when the gates process started and its exact span'`

#### Completion Criteria
- [ ] All six named tests exist and pass.
- [ ] Existing `gates.test.ts` assertions that pinned the old aggregate string are UPDATED to the new form (search the file for `passed ·` and `aggregate`), not deleted.
- [ ] `npm run typecheck` clean.

---

### Task 3: Fix process — full AI identity, agent name, start time

#### Objective
Close reported item 2.

#### Files
- `src/model/inside/agent.ts` — `executionView` signature.
- `src/model/inside/recovery.ts` — `recoveryProcess`.
- `src/model/inside/gates.ts` — the two `recoveryProcess(...)` call sites and `aiProcessBase`'s `executionView` call.
- `src/model/inside/recovery.test.ts`, `src/model/inside/agent.test.ts` — new cases.

#### Implementation
1. In `agent.ts`, change `executionView` to:
```ts
/**
 * One recorded provider session as the display model. `agentName` is the
 * IDENTITY SNAPSHOT the run recorded (`process_runs.agent_name`), passed
 * through when there is one — never derived from the provider, which is a
 * different fact.
 */
export function executionView(
  provider: string,
  model: string | null,
  agentName?: string | null,
): AgentExecutionView {
  return {
    ...(agentName ? { agentName } : {}),
    provider,
    providerLabel: labelForProvider(provider),
    model,
    modelLabel: labelForModel(provider, model),
  };
}
```
2. In `gates.ts`'s `aiProcessBase`, change the execution spread to
   `...(run?.provider ? { execution: executionView(run.provider, run.model, run.agentName) } : {}),`.
3. In `recovery.ts`:
   - Import `SessionConfiguredInput` (type-only) from `./agent.js` alongside `executionView`, and `formatExactDuration`/`formatTime` from `./types.js`.
   - Change the signature to:
```ts
export function recoveryProcess(
  rounds: readonly RecoveryRound[],
  processRuns: readonly ProcessRun[],
  now: string,
  configured?: SessionConfiguredInput | null,
): RecoveryProcessView | null {
```
   - Replace the process object's trailing spreads with:
```ts
      ...(fixRun?.startedAt
        ? {
            duration: formatDuration(fixRun.startedAt, fixRun.endedAt ?? now),
            durationExact: formatExactDuration(fixRun.startedAt, fixRun.endedAt ?? now),
            time: formatTime(fixRun.startedAt),
          }
        : {}),
      // The §11 identity order, the same one every other AI process uses: what
      // RAN, else what settings SAY will run, else the absence copy. Fix is an
      // AI process — it resumes the captured session — and showing no identity
      // at all made it the one AI row on the stage with no `AI` mark.
      ...(fixRun?.provider
        ? { execution: executionView(fixRun.provider, fixRun.model, fixRun.agentName) }
        : {}),
      // The configured fallback applies ONLY when no run was recorded at all.
      // A run that recorded no provider is identity ABSENCE, never the
      // configured default: what RAN decides, and here it said nothing — so
      // that case takes `identityNote` below instead. This mirrors
      // `aiProcessBase` in `gates.ts` exactly.
      ...(!fixRun && configured
        ? { configuredExecution: executionView(configured.provider, configured.model) }
        : {}),
      ...(fixRun && !fixRun.provider ? { identityNote: 'No historical execution identity recorded' } : {}),
```
4. In `gates.ts`, both call sites become
   `recoveryProcess(stageRounds, input.processRuns, input.now, input.configured)`.

#### Constraints
- Do not add an `effort` field anywhere — nothing records one (see Scope).
- Do not change `roundStatus`, `roundDetail`, `triggerProse`, or `insertCausalFix`.
- `configured` stays optional so existing callers/tests compile unchanged.

#### Edge Cases
- Round with `fixProcessRunId` resolving to a run WITH a provider → `execution`, no `configuredExecution`, no `identityNote`.
- Round whose run recorded NO provider → `identityNote` only.
- Round with no matching run at all + a configured assignment → `configuredExecution` only.
- Round with no matching run and no configured assignment → none of the three (unchanged from today).

#### Verification
```bash
npx vitest run src/model/inside/recovery.test.ts src/model/inside/agent.test.ts src/model/inside/gates.test.ts
npm run typecheck
```
Expected: green, with new tests named:
- `'shows the fix execution identity the round recorded'`
- `'falls back to the configured identity when no fix run was recorded'`
- `'states identity absence for a fix run that recorded no provider'`
- `'carries the recorded agent name into the execution view'` (agent.test.ts)

#### Completion Criteria
- [ ] All four named tests exist and pass.
- [ ] `executionView` calls in `gates.ts` and `recovery.ts` pass the agent name where a run has one.
- [ ] `npm run typecheck` clean.

---

### Task 4: Session and scope/ship processes — start times and exact spans

#### Objective
Close reported item 9 for every process whose start karst actually recorded.

#### Files
- `src/model/inside/agent.ts` — `implementationSessionProcess`.
- `src/model/inside/index.ts` — `scopeProcesses`.
- `src/model/inside/ship.ts` — the commit / push / pr / merge process objects.
- Their `.test.ts` files.

#### Implementation
1. `agent.ts`, in `implementationSessionProcess`'s return, replace the duration spread with:
```ts
    ...(cell.startedAt
      ? {
          duration: formatDuration(cell.startedAt, cell.endedAt ?? now),
          durationExact: formatExactDuration(cell.startedAt, cell.endedAt ?? now),
          time: formatTime(cell.startedAt),
        }
      : {}),
```
   Import `formatExactDuration` (`formatTime` is already imported).
2. `index.ts`, in `scopeProcesses`'s `hotSet`, apply the identical replacement using `cell.startedAt` / `cell.endedAt`. Import `formatExactDuration` and `formatTime` from `./types.js`. The `worktrees` process is left unchanged — it records no start of its own.
3. `ship.ts`: for each of the four process objects that already spread a `step`-derived duration (lines ~229, ~284, ~401 and the `merge` process), extend the spread the same way, keyed off the SAME `step.startedAt` the duration uses:
```ts
        ...(step?.startedAt
          ? {
              duration: formatDuration(step.startedAt, step.endedAt ?? input.now),
              durationExact: formatExactDuration(step.startedAt, step.endedAt ?? input.now),
              time: formatTime(step.startedAt),
            }
          : {}),
```
   Preserve each call site's existing optional-chaining shape (`step?.` vs `step.`) exactly as written there.

#### Constraints
- Never synthesize a start: a process with no recorded `startedAt` gets no `time`.
- Do not touch `doneStageView` / `doneReceipt` — the receipt hero already states its completion time.
- Do not change any duration string that is already rendered.

#### Edge Cases
- Running process (`endedAt` null) → `time` is the start; `duration`/`durationExact` measure to `now`, as today.
- Services process → no `time` (it has no recorded start), and no test asserts one.

#### Verification
```bash
npx vitest run src/model/inside/
npm run typecheck
```
Expected: green, with new tests named `'states when the session started'` (agent.test.ts), `'states when the scope hot set started'` (index.test.ts), `'states when each recorded ship step started'` (ship.test.ts).

#### Completion Criteria
- [ ] Three named tests exist and pass.
- [ ] No process without a recorded start carries `time`.
- [ ] `npm run typecheck` clean.

---

### Task 5: Derive the stage's live line from the snapshot

#### Objective
Close reported item 10.

#### Files
- `src/ui/dashboard/state.ts` — `stageView`.
- `src/ui/dashboard/state.test.ts` — new cases (if the file does not exist, add them to the nearest existing dashboard state test file found by `ls src/ui/dashboard/*.test.ts`).

#### Implementation
1. Import `type InsideLiveView` from `../../model/inside/types.js` (extend the existing import from that module).
2. Add above `stageView`:
```ts
/**
 * The stage's CURRENT operation, derived from its own process rows: the first
 * running process, else the first waiting one. Nothing here is new information
 * — every field comes from a row already in the ledger below — which is what
 * makes it safe as the header's fallback when no ephemeral progress event has
 * arrived (a reopened panel, a window that missed the events). A settled stage
 * has no live line at all.
 */
function liveFor(processes: readonly InsideProcessView[]): InsideLiveView | undefined {
  const active =
    processes.find((p) => p.status === 'run') ?? processes.find((p) => p.status === 'wait');
  if (!active) return undefined;
  return {
    status: active.status === 'run' ? 'run' : 'wait',
    label: active.label,
    ...(active.detail ? { detail: active.detail } : {}),
    ...(active.duration ? { duration: active.duration } : {}),
  };
}
```
3. In `stageView`'s returned object, add after `clock`:
```ts
    ...(liveFor(processes) ? { live: liveFor(processes)! } : {}),
```
   Compute it once instead: declare `const live = liveFor(processes);` above the return and spread `...(live ? { live } : {})`.

#### Constraints
- Do not read the store here — `stageView` receives everything it needs.
- Do not emit a `fail` live status: a failed stage is stated by the fault card and the row itself, and the header must not duplicate a terminal verdict as an in-flight operation.
- `doneStageView` calls `stageView` and therefore inherits this — no separate change.

#### Edge Cases
- Every process `pass`/`note`/`pending` → no `live`.
- A blocked stage's processes read `wait` (`stageProcessStatus`) → `live.status === 'wait'`, which is correct: karst is waiting.
- Empty `processes` array → no `live`.

#### Verification
```bash
npx vitest run src/ui/dashboard/
npm run typecheck
```
Expected: green, with new tests named `'states the running process as the stage live line'` and `'omits the live line for a stage with nothing running or waiting'`.

#### Completion Criteria
- [ ] Both named tests exist and pass.
- [ ] `npm run typecheck` clean.

---

### Task 6: Webview CSS — inset, gaps, gate columns, neutral recovery, timeline start

#### Objective
Close reported items 1, 4, 6 (CSS half), 7 (spacing half) and 8.

#### Files
- `src/ui/dashboard/webview.html` — the `#inside` style block only.

#### Implementation
Apply each edit exactly:

1. **Row inset (item 1).** Line 585-587, in `#inside .op summary,#inside .op-static`, change `gap:var(--p-s1)` → `gap:var(--p-s2)` and `padding:0 var(--p-s1)` → `padding:0 var(--p-s4)`.
2. **Body alignment.** `#inside .op-body` (line 644): change `margin:0 0 var(--p-s2) 28px` → `margin:0 0 var(--p-s2) 34px` so the body rail stays under the row's name column after the inset change.
3. **Tail/chevron gap (item 7).** In `#inside .op-tail` (line 632), append `;padding-right:var(--p-s1)`.
4. **Gate state gap (item 7).** Line 662: change `#inside .ev-state{gap:var(--p-s2)}` → `#inside .ev-state,#inside .gate-state{gap:var(--p-s2)}`.
5. **Gate columns (item 6).** Line 669: change the wide grid to
   `grid-template-columns:minmax(74px,90px) minmax(110px,150px) minmax(0,1fr) auto`.
   Immediately after the `.gate-row:last-child` rule add:
```css
  /* A gates body whose rows name no repository (pre-v21 rows) drops the column
     rather than drawing an empty one — a blank cell reads as a repo with no
     name instead of a row that names none. */
  #inside .gates.no-repo .gate-row{grid-template-columns:minmax(110px,150px) minmax(0,1fr) auto}
```
6. **Recovery de-amber (item 4).** Line 762-767:
   - `.recovery-pill`: `border:var(--k-border-w) solid var(--p-border)` and `color:var(--p-muted)`. The `.recovery-pill.exhausted` rule is UNCHANGED (a real failure stays red).
   - `.recovery-history`: `border:var(--k-border-w) solid var(--p-border)` and `background:var(--p-surface)`.
7. **Recovery result cell (item 3, CSS half).** Line 774, change `#inside .recovery-result{...}` to include `display:inline-flex;align-items:center;justify-content:flex-end;gap:var(--p-s2);` before its existing declarations.
8. **Timeline start (item 8).** Line 726: `.timeline-start-label` `color:var(--p-muted2)` → `color:var(--p-text)`. Line 728-729: `.timeline-node.start` `border:var(--k-border-w) solid var(--p-muted2)` → `border:var(--k-border-w) solid var(--p-muted)`.
9. **Narrow variants.** Inside `@container (max-width: 430px)`:
   - after line 875 (`#inside .gate-row{grid-template-columns:58px 70px minmax(0,1fr)}`) add `#inside .gate-repo{display:none}` and `#inside .gates.no-repo .gate-row{grid-template-columns:58px 70px minmax(0,1fr)}`.
   - Leave line 875 itself byte-identical — `webview.test.ts:1408` pins it.
   - Add `#inside .op summary,#inside .op-static{padding-left:var(--p-s2);padding-right:var(--p-s2)}` immediately after line 871 so the new wide inset does not crush the narrow layout.

#### Constraints
- **No hex, no `rgba()`, no raw px/rem/radius/shadow/duration** — every value above is a `--p-*` or `--k-*` token or an existing grid track (UI-R04/R05). The `110px`/`150px`/`34px` grid/margin values are layout geometry in the same style the surrounding rules already use; do not introduce color or spacing literals.
- Do not touch any selector outside the `#inside` block.
- Do not change line 875 or line 911-912.

#### Edge Cases
- ≤360px and ≤300px containers: the existing padding overrides (lines 911, 917) still win because they come later in the cascade with equal specificity — verify visually via the render fixtures test below.

#### Verification
```bash
npx vitest run src/ui/dashboard/webview.test.ts src/ui/designSystem.test.ts
npm run typecheck
```
Expected: green. `designSystem.test.ts` enforces the no-literal rules — if it fails, the change used a literal where a token was required.

#### Completion Criteria
- [ ] All nine edits applied.
- [ ] `webview.test.ts` and `designSystem.test.ts` pass.

---

### Task 7: Webview JS — gate repo cell, recovery glyph, time and exact-duration titles, header fallback

#### Objective
Close reported items 3, 5 (render half), 6 (render half), 7 (title half), 9 (render half) and 10 (render half).

#### Files
- `src/ui/dashboard/webview.html` — the `#inside` script functions only.
- `src/ui/dashboard/webview.test.ts` — new source-pinning and render cases.

#### Implementation
1. **Gates body** — replace `evidenceGatesHtml` (lines 1728-1734) with:
```js
  // The recorded repository is its own column. A body whose rows name none
  // (pre-v21 gate rows) drops the column instead of drawing it empty — an
  // empty cell would read as a repo with no name.
  function evidenceGatesHtml(ev) {
    const hasRepo = ev.rows.some((r) => !!r.repo);
    return `<div class="gates${hasRepo ? '' : ' no-repo'}">${ev.rows.map((r) => `<div class="gate-row${r.status === 'run' ? ' active' : ''}">`
      + (hasRepo ? `<span class="gate-repo">${esc(r.repo || '')}</span>` : '')
      + `<span class="gate-name">${esc(r.label)}</span>`
      + `<span class="gate-detail">${esc(r.detail || '')}</span>`
      + evStateHtml(r, 'gate-state')
      + `</div>`).join('')}</div>`;
  }
```
2. **Duration title (item 7)** — in `evStateHtml` (line 1711-1716), change the duration span to:
```js
    const dur = r.duration
      ? `<span class="ev-dur"${r.durationExact ? ` title="${esc(r.durationExact)}"` : ''}>${esc(r.duration)}</span>`
      : '';
```
3. **Recovery rows (item 3)** — replace the third cell in `evidenceRecoveryHtml` with:
```js
      + `<span class="recovery-result ${esc(r.status || '')}">`
      + (r.duration ? `<span class="ev-dur">${esc(r.duration)}</span>` : '')
      + `<span class="glyph ${esc(r.status || 'note')}" aria-label="${esc(statusWord(r.status))}"></span>`
      + `</span>`
```
   The status WORD survives as the glyph's accessible name — the same trade `evStateHtml` documents — so nothing that cannot see colour loses the status.
4. **Process tail (items 7 + 9)** — in `processRowHtml`, replace the `duration` entry of `tail` and add the time, in this order (time before duration):
```js
      + (p.time ? `<span class="op-time">${esc(p.time)}</span>` : '')
      + (p.duration ? `<span class="duration"${p.durationExact ? ` title="${esc(p.durationExact)}"` : ''}>${esc(p.duration)}</span>` : '')
```
5. Add the `op-time` style in the `#inside` CSS block, immediately after `#inside .duration{...}` (line 637-638):
```css
  #inside .op-time{display:inline-flex;align-items:center;height:18px;color:var(--p-muted2);
    font-family:var(--p-mono);font-size:var(--p-xs);line-height:18px;white-space:nowrap}
```
   and hide it at the compact width by extending line 872 to `#inside .duration,#inside .op-time{display:none}`.
6. **Header fallback (item 10)** — in `renderInside`, replace lines 1995-2003 with:
```js
    // The header IS the current operation. The ephemeral progress event wins
    // while one is in flight; the snapshot's own derived line is the fallback,
    // so a panel opened after those events (or reopened) still says what the
    // stage is doing. A live op is run/wait/fail only — never a verdict.
    const live = liveOps[view.stageKey];
    const lop = (live && live.active) || view.live || null;
    const lstatus = lop ? (lop.status || 'run') : '';
    const alive = lop
      ? `<span class="glyph ${esc(lstatus)}" aria-label="${esc(statusWord(lstatus))}"></span>`
        + `<span class="live-state">${esc(statusWord(lstatus))}</span><span class="sep">·</span>`
        + `<strong>${esc(lop.label || '')}</strong>`
        + (lop.detail ? `<span class="sep">·</span><span class="live-copy">${esc(lop.detail)}</span>` : '')
        + (lop.duration ? `<span class="sep">·</span><span class="duration">${esc(lop.duration)}</span>` : '')
      : '';
```

#### Constraints
- Every untrusted value stays inside `esc(...)` (UI-R32). `r.repo`, `p.time`, `p.durationExact` and every `lop.*` field are host-shipped strings rendered verbatim — the webview computes and concatenates no copy (UI-R31).
- Do not change `statusWord`, `INSIDE_STATUS_LABEL`, or any mirrored TS→HTML constant (UI-R34).
- Do not change the `liveOps` overlay lifecycle or the progress-event handler.

#### Edge Cases
- A gates body where SOME rows have a repo and some do not → `hasRepo` is true, the repo-less rows render an empty `gate-repo` cell. That is correct: the column is meaningful for that body.
- `p.time` present with no `p.duration` → the time renders alone.
- `view.live` absent and no progress event → the header cell is empty, exactly as today.

#### Verification
```bash
npx vitest run src/ui/dashboard/webview.test.ts
npm run typecheck
```
Expected: green, with new tests named:
- `'renders the recorded repository as its own gates column'`
- `'drops the repo column for a gates body whose rows name none'`
- `'renders a recovery round status as a glyph, never a word'`
- `'titles a duration with its exact span'`
- `'renders a process start time beside its duration'`
- `'falls back to the snapshot live line when no progress event has arrived'`

#### Completion Criteria
- [ ] All six named tests exist and pass.
- [ ] `grep -c 'statusWord(r.status)' ` inside `evidenceRecoveryHtml` shows it used only as the glyph's `aria-label`, never as rendered text.
- [ ] `npm run typecheck` clean.

---

### Task 8: Final verification

#### Objective
Prove the whole change is green and nothing outside the Inside block moved.

#### Implementation
1. Run the full suite (its `pretest` rebuilds `better-sqlite3` for the Node ABI — do NOT run bare `npx vitest` for this step).
2. Run typecheck and build.
3. Inspect the diff for accidental edits outside the listed files.

#### Verification
```bash
npm test
npm run typecheck
npm run build
git status --short
git diff --stat
```
Expected:
- `npm test` — all files pass; the total test count is HIGHER than the pre-change baseline (306 files / 5138 tests) by exactly the number of tests added in Tasks 1–7, with zero failures.
- `npm run typecheck` — no output.
- `npm run build` — succeeds.
- `git diff --stat` touches only: `src/model/inside/types.ts`, `gates.ts`, `recovery.ts`, `agent.ts`, `index.ts`, `ship.ts`, their tests, `src/ui/dashboard/state.ts` (+ its test), `src/ui/dashboard/webview.html`, `src/ui/dashboard/webview.test.ts`, and this plan file.

#### Completion Criteria
- [ ] `npm test` green.
- [ ] `npm run typecheck` clean.
- [ ] `npm run build` clean.
- [ ] No file outside the list above is modified.

---

## Final Verification

1. `npm test` — full suite green.
2. `npm run typecheck` — clean.
3. `npm run build` — clean.
4. Manual (F5 → Extension Dev Host, open a ticket sitting at `uat` with a failed gate and at least one recovery round):
   - Gates / Fix / Services / Tester rows are inset in line with the `Inside uat` title.
   - The Gates row's pill reads `n/m · …`; expanding it shows `repo | gate | detail | duration+glyph` with no collision.
   - The Fix row carries an `AI` mark and an identity.
   - The round row ends in a circle glyph, and the round block is grey, not yellow.
   - Hovering a duration shows the exact span; each process states its start time.
   - The header states the current operation immediately on open, before any progress event.

Commands:

```bash
npm test
npm run typecheck
npm run build
```

## Executor Rules

1. Execute tasks strictly in numerical order.
2. Complete the current task and its verification before starting the next task.
3. Implement the solution described in the plan exactly.
4. Do not redesign architecture or substitute a different approach.
5. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
6. Do not omit planned behavior because another implementation appears simpler.
7. Do not reinterpret product requirements.
8. Do not make optional improvements.
9. Follow existing project conventions where the plan explicitly relies on them.
10. Run the verification specified for every task.
11. Mark a task complete only when its completion criteria are satisfied.
12. If implementation reveals information that does not affect the prescribed solution, continue execution.
13. Stop rather than improvise when the plan cannot be executed as written.

Stop only for a concrete blocker: a referenced file/API does not exist; repository state contradicts a fact the plan depends on; the prescribed implementation is impossible; two instructions contradict each other; or verification proves a fundamental assumption false. When stopping, report the task number, the exact blocker, the evidence, the invalid assumption, and the minimum planning decision needed to continue. Do not propose or implement an alternative unless asked to re-plan.
